import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { DEFAULT_DASHBOARD_CHART_KINDS } from "@whatsatendende/types";
import { createApp } from "../src/app";
import { prisma } from "../src/lib/prisma";
import { resetDatabase, createTestUser, TEST_PASSWORD } from "./helpers";

const app = createApp();

async function loginAs(email: string) {
  const res = await request(app).post("/api/auth/login").send({ email, password: TEST_PASSWORD });
  return res.body.accessToken as string;
}

describe("Dashboard: tipo padrão dos gráficos", () => {
  let admin: string;
  let manager: string;

  beforeAll(async () => {
    await resetDatabase();
    await prisma.systemSetting.deleteMany({ where: { key: "dashboard-chart-kinds" } });
    await createTestUser({ email: "admin-charts@test.dev", role: "ADMIN" });
    await createTestUser({ email: "gestor-charts@test.dev", role: "MANAGER" });
    admin = await loginAs("admin-charts@test.dev");
    manager = await loginAs("gestor-charts@test.dev");
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("sem nada salvo, cada gráfico vem com o tipo do sistema", async () => {
    const res = await request(app).get("/api/dashboard/chart-kinds").set("Authorization", `Bearer ${manager}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual(DEFAULT_DASHBOARD_CHART_KINDS);
  });

  it("o administrador define o padrão de todos, e fica na Auditoria", async () => {
    const res = await request(app).put("/api/dashboard/chart-kinds/conversationsByAgent").set("Authorization", `Bearer ${admin}`).send({ kind: "line" });
    expect(res.status).toBe(200);
    const seen = await request(app).get("/api/dashboard/chart-kinds").set("Authorization", `Bearer ${manager}`);
    expect(seen.body).toEqual({ ...DEFAULT_DASHBOARD_CHART_KINDS, conversationsByAgent: "line" });
    const audit = await prisma.auditLog.findFirstOrThrow({ where: { action: "DASHBOARD_CHART_KIND_UPDATED" } });
    expect(audit.metadata).toMatchObject({ chart: "Conversas por atendente", kind: "line" });
  });

  it("o gestor não define o padrão", async () => {
    const res = await request(app).put("/api/dashboard/chart-kinds/conversationsByAgent").set("Authorization", `Bearer ${manager}`).send({ kind: "area" });
    expect(res.status).toBe(403);
    expect((await request(app).get("/api/dashboard/chart-kinds").set("Authorization", `Bearer ${manager}`)).body.conversationsByAgent).toBe("line");
  });

  it("um tipo que o gráfico não tem, ou um gráfico que não existe, é recusado", async () => {
    expect((await request(app).put("/api/dashboard/chart-kinds/conversationsByStatus").set("Authorization", `Bearer ${admin}`).send({ kind: "line" })).status).toBe(400);
    expect((await request(app).put("/api/dashboard/chart-kinds/qualquer").set("Authorization", `Bearer ${admin}`).send({ kind: "bar" })).status).toBe(400);
    expect((await request(app).put("/api/dashboard/chart-kinds/conversationsByStatus").set("Authorization", `Bearer ${admin}`).send({ kind: "pie" })).status).toBe(200);
  });
});
