import { vi, describe, it, expect, beforeEach, afterAll } from "vitest";
import request from "supertest";
import JSZip from "jszip";

const { sendMailMock } = vi.hoisted(() => ({ sendMailMock: vi.fn() }));
vi.mock("nodemailer", () => ({ default: { createTransport: vi.fn(() => ({ sendMail: sendMailMock })) } }));

import { createApp } from "../src/app";
import { prisma } from "../src/lib/prisma";
import { resetDatabase, createTestUser, TEST_PASSWORD } from "./helpers";
import * as settingsService from "../src/modules/settings/settings.service";
import { processDueSchedules } from "../src/modules/report-schedules/report-schedules.service";

const app = createApp();
const TZ = 240;

async function loginAs(email: string) {
  const res = await request(app).post("/api/auth/login").send({ email, password: TEST_PASSWORD });
  return res.body.accessToken as string;
}

function schedule(overrides: Record<string, unknown> = {}) {
  return {
    name: "Diretoria — semanal",
    enabled: true,
    subject: "Relatório — {{periodo}}",
    title: "Relatório de atendimento",
    bodyText: "Segue a apresentação de {{periodo}} ({{datas}}).",
    to: ["diretoria@empresa.com.br"],
    cc: ["gestor@empresa.com.br"],
    frequency: "WEEKLY",
    time: "08:00",
    tzOffsetMinutes: TZ,
    startDate: "2026-11-02",
    weekdays: [1],
    monthDay: null,
    month: null,
    customInterval: 1,
    customUnit: "DAY",
    endType: "NEVER",
    endAfter: null,
    endDate: null,
    skipSaturday: true,
    skipSunday: true,
    period: "AUTO",
    agentId: null,
    connectionIds: [],
    alerts: { emails: ["ti@empresa.com.br"], whatsapp: null, sms: null },
    ...overrides,
  };
}

describe("Agendamento da apresentação", () => {
  let token: string;

  beforeEach(async () => {
    await resetDatabase();
    sendMailMock.mockReset();
    sendMailMock.mockImplementation(async (mail: { to: string[]; cc?: string[] }) => ({ messageId: "x", accepted: [...mail.to, ...(mail.cc ?? [])], rejected: [] }));
    await createTestUser({ email: "gestor@empresa.com.br", role: "MANAGER", displayName: "Gestora" });
    await createTestUser({ email: "admin@empresa.com.br", role: "ADMIN", displayName: "Admin" });
    // Configurações is off for Gestor by default — an administrator turns it on in Permissões.
    await prisma.rolePermission.create({ data: { role: "MANAGER", permission: "configuracoes.gerenciar", allowed: true } });
    await settingsService.updateEmailSettings({ host: "smtp.test.dev", port: 587, fromEmail: "no-reply@empresa.com.br", fromName: "Sistema" });
    token = await loginAs("gestor@empresa.com.br");
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("salva vários e avisa — sem bloquear — quando outro cai no mesmo dia para o mesmo destinatário", async () => {
    const first = await request(app).post("/api/report-schedules").set("Authorization", `Bearer ${token}`).send(schedule());
    expect(first.status).toBe(201);
    expect(first.body.conflicts).toEqual([]);
    expect(first.body.schedule.nextRunAt).not.toBeNull();

    const sameDay = await request(app)
      .post("/api/report-schedules")
      .set("Authorization", `Bearer ${token}`)
      .send(schedule({ name: "Mensal", frequency: "MONTHLY", monthDay: 2, to: ["outra@empresa.com.br", "diretoria@empresa.com.br"], cc: [] }));
    expect(sameDay.status).toBe(201);
    expect(sameDay.body.conflicts[0]).toMatchObject({ name: "Diretoria — semanal", recipients: ["diretoria@empresa.com.br"] });

    const otherPeople = await request(app)
      .post("/api/report-schedules")
      .set("Authorization", `Bearer ${token}`)
      .send(schedule({ name: "Outro público", to: ["alguem@empresa.com.br"], cc: [] }));
    expect(otherPeople.body.conflicts).toEqual([]);

    const list = await request(app).get("/api/report-schedules").set("Authorization", `Bearer ${token}`);
    expect(list.body.schedules).toHaveLength(3);
  });

  it("avisa quando há destinatário de fora da empresa", async () => {
    const res = await request(app).post("/api/report-schedules").set("Authorization", `Bearer ${token}`).send(schedule({ cc: ["socio@gmail.com"] }));
    expect(res.body.externalRecipients).toEqual(["socio@gmail.com"]);
  });

  it("no horário, envia o PowerPoint em anexo para os destinatários e as cópias, e marca o próximo envio", async () => {
    const created = await request(app).post("/api/report-schedules").set("Authorization", `Bearer ${token}`).send(schedule());
    const id = created.body.schedule.id as string;
    const due = new Date(Date.now() - 60_000);
    await prisma.reportSchedule.update({ where: { id }, data: { nextRunAt: due } });

    await processDueSchedules();

    expect(sendMailMock).toHaveBeenCalledTimes(1);
    const mail = sendMailMock.mock.calls[0][0] as { to: string[]; cc: string[]; subject: string; attachments: { filename: string; content: Buffer }[] };
    expect(mail.to).toEqual(["diretoria@empresa.com.br"]);
    expect(mail.cc).toEqual(["gestor@empresa.com.br"]);
    expect(mail.subject).toContain("Últimos 7 dias");
    expect(mail.attachments[0].filename).toMatch(/\.pptx$/);
    const zip = await JSZip.loadAsync(mail.attachments[0].content);
    expect(Object.keys(zip.files).some((f) => f.startsWith("ppt/slides/slide"))).toBe(true);

    const row = await prisma.reportSchedule.findUniqueOrThrow({ where: { id } });
    expect(row.lastStatus).toBe("SENT");
    expect(row.runCount).toBe(1);
    expect(row.nextRunAt!.getTime()).toBeGreaterThan(Date.now());
    // Never written to disk: the history keeps only the outcome.
    const runs = await prisma.reportScheduleRun.findMany({ where: { scheduleId: id } });
    expect(runs).toHaveLength(1);
    expect(runs[0].status).toBe("SENT");
  });

  it("falhou: tenta de novo em 5 e 15 minutos e, na terceira falha, alerta no sistema e por e-mail", async () => {
    const created = await request(app).post("/api/report-schedules").set("Authorization", `Bearer ${token}`).send(schedule());
    const id = created.body.schedule.id as string;
    await prisma.reportSchedule.update({ where: { id }, data: { nextRunAt: new Date(Date.now() - 60_000) } });
    sendMailMock.mockImplementation(async (mail: { to: string[] }) => {
      if (mail.to.includes("ti@empresa.com.br")) return { messageId: "alert", accepted: mail.to, rejected: [] };
      throw new Error("Connection timeout");
    });

    await processDueSchedules();
    let row = await prisma.reportSchedule.findUniqueOrThrow({ where: { id } });
    expect(row.lastStatus).toBe("RETRYING");
    expect(row.retryAttempt).toBe(1);
    expect(row.retryAt!.getTime() - Date.now()).toBeGreaterThan(4 * 60_000);

    await prisma.reportSchedule.update({ where: { id }, data: { retryAt: new Date(Date.now() - 1000) } });
    await processDueSchedules();
    row = await prisma.reportSchedule.findUniqueOrThrow({ where: { id } });
    expect(row.retryAttempt).toBe(2);
    expect(row.retryAt!.getTime() - Date.now()).toBeGreaterThan(14 * 60_000);

    await prisma.reportSchedule.update({ where: { id }, data: { retryAt: new Date(Date.now() - 1000) } });
    await processDueSchedules();
    row = await prisma.reportSchedule.findUniqueOrThrow({ where: { id } });
    expect(row.lastStatus).toBe("FAILED");
    expect(row.retryAt).toBeNull();
    expect(row.nextRunAt).not.toBeNull();

    const notifications = await prisma.notification.findMany({ where: { type: "REPORT_SCHEDULE_FAILED" } });
    expect(notifications).toHaveLength(2); // the creator and the administrator
    const alertMail = sendMailMock.mock.calls.map((c) => c[0] as { to: string[] }).find((m) => m.to.includes("ti@empresa.com.br"));
    expect(alertMail).toBeDefined();
    const runs = await prisma.reportScheduleRun.findMany({ where: { scheduleId: id }, orderBy: { createdAt: "asc" } });
    expect(runs.map((r) => r.status)).toEqual(["RETRYING", "RETRYING", "FAILED"]);
  });

  it("quando o servidor recusa só alguns e-mails, conta como parcial e alerta quais foram", async () => {
    const created = await request(app).post("/api/report-schedules").set("Authorization", `Bearer ${token}`).send(schedule({ cc: ["errado@empresa.com.br"] }));
    const id = created.body.schedule.id as string;
    await prisma.reportSchedule.update({ where: { id }, data: { nextRunAt: new Date(Date.now() - 60_000) } });
    sendMailMock.mockImplementation(async (mail: { to: string[] }) => ({ messageId: "x", accepted: mail.to, rejected: mail.to.includes("ti@empresa.com.br") ? [] : ["errado@empresa.com.br"] }));
    await processDueSchedules();
    const row = await prisma.reportSchedule.findUniqueOrThrow({ where: { id } });
    expect(row.lastStatus).toBe("PARTIAL");
    const notification = await prisma.notification.findFirst({ where: { type: "REPORT_SCHEDULE_FAILED" } });
    expect(notification?.body).toContain("errado@empresa.com.br");
  });

  it("a prévia baixa o PowerPoint com os filtros do formulário, sem enviar e-mail", async () => {
    const res = await request(app)
      .post("/api/report-schedules/preview")
      .set("Authorization", `Bearer ${token}`)
      .buffer(true)
      .parse((r, cb) => {
        const chunks: Buffer[] = [];
        r.on("data", (c: Buffer) => chunks.push(c));
        r.on("end", () => cb(null, Buffer.concat(chunks)));
      })
      .send({ frequency: "MONTHLY", customInterval: 1, customUnit: "DAY", period: "AUTO", agentId: null, connectionIds: [], tzOffsetMinutes: TZ });
    expect(res.status).toBe(200);
    expect(res.headers["content-disposition"]).toContain("lastMonth");
    expect((res.body as Buffer).subarray(0, 2).toString()).toBe("PK");
    expect(sendMailMock).not.toHaveBeenCalled();
  });

  it("o atendente não acessa os agendamentos", async () => {
    await createTestUser({ email: "atendente@empresa.com.br", role: "AGENT" });
    const agentToken = await loginAs("atendente@empresa.com.br");
    const res = await request(app).get("/api/report-schedules").set("Authorization", `Bearer ${agentToken}`);
    expect(res.status).toBe(403);
  });
});
