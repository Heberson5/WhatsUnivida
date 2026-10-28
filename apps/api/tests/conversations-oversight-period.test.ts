import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import request from "supertest";
import { createApp } from "../src/app";
import { prisma } from "../src/lib/prisma";
import { resetDatabase, createTestUser, createTestConnection, TEST_PASSWORD } from "./helpers";

const app = createApp();

// Wednesday 8 Oct 2026, 15:00 UTC — every period below is relative to this moment.
const NOW = new Date("2026-10-08T15:00:00.000Z");
const at = (iso: string) => new Date(iso);

describe("Gestão: filtro de período", () => {
  let token: string;
  let connectionId: string;
  let serial = 0;

  async function conversation(input: { name: string; status: "WAITING" | "IN_PROGRESS" | "CLOSED"; createdAt: Date; lastMessageAt: Date; closedAt?: Date }) {
    serial += 1;
    const contact = await prisma.contact.create({ data: { phone: `55119900${String(serial).padStart(5, "0")}`, name: input.name, whatsappConnectionId: connectionId } });
    return prisma.conversation.create({
      data: {
        contactId: contact.id,
        whatsappConnectionId: connectionId,
        status: input.status,
        enteredQueueAt: input.createdAt,
        createdAt: input.createdAt,
        lastMessageAt: input.lastMessageAt,
        closedAt: input.closedAt ?? null,
      },
    });
  }

  beforeAll(async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
    await resetDatabase();
    connectionId = (await createTestConnection("Suporte")).id;
    await createTestUser({ email: "adm-periodo@test.dev", role: "ADMIN" });
    token = (await request(app).post("/api/auth/login").send({ email: "adm-periodo@test.dev", password: TEST_PASSWORD })).body.accessToken;

    await conversation({ name: "Criada hoje", status: "WAITING", createdAt: at("2026-10-08T10:00:00Z"), lastMessageAt: at("2026-10-08T10:00:00Z") });
    await conversation({ name: "Começou ontem, mensagem hoje", status: "IN_PROGRESS", createdAt: at("2026-10-07T20:00:00Z"), lastMessageAt: at("2026-10-08T09:00:00Z") });
    await conversation({ name: "Encerrada hoje", status: "CLOSED", createdAt: at("2026-10-07T18:00:00Z"), lastMessageAt: at("2026-10-07T18:30:00Z"), closedAt: at("2026-10-08T08:00:00Z") });
    await conversation({ name: "Só ontem", status: "CLOSED", createdAt: at("2026-10-07T12:00:00Z"), lastMessageAt: at("2026-10-07T12:30:00Z"), closedAt: at("2026-10-07T13:00:00Z") });
    await conversation({ name: "Na fila desde ontem", status: "WAITING", createdAt: at("2026-10-07T22:00:00Z"), lastMessageAt: at("2026-10-07T22:00:00Z") });
    await conversation({ name: "Setembro", status: "CLOSED", createdAt: at("2026-09-18T12:00:00Z"), lastMessageAt: at("2026-09-18T12:30:00Z"), closedAt: at("2026-09-18T13:00:00Z") });
  }, 30000);

  afterAll(async () => {
    vi.useRealTimers();
    await prisma.$disconnect();
  });

  async function list(query: string) {
    const res = await request(app).get(`/api/conversations/oversight${query}`).set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    return (res.body as { contact: { name: string } }[]).map((c) => c.contact.name);
  }

  it("Hoje mostra o que começou, teve mensagem ou foi encerrado hoje — e nada de outros dias", async () => {
    expect(await list("?period=today")).toEqual(["Criada hoje", "Começou ontem, mensagem hoje", "Encerrada hoje"]);
  });

  it("Ontem mostra o que teve movimento ontem, o mais recente primeiro", async () => {
    expect(await list("?period=yesterday")).toEqual(["Começou ontem, mensagem hoje", "Na fila desde ontem", "Encerrada hoje", "Só ontem"]);
  });

  it("Últimos 7 dias e Este mês deixam de fora só o que é de setembro", async () => {
    const week = await list("?period=last7days");
    expect(week).toHaveLength(5);
    expect(week).not.toContain("Setembro");
    expect(await list("?period=month")).toEqual(week);
  });

  it("Mês anterior mostra só o de setembro", async () => {
    expect(await list("?period=lastMonth")).toEqual(["Setembro"]);
  });

  it("Personalizado usa o intervalo escolhido (datas inteiras)", async () => {
    expect(await list("?period=custom&from=2026-10-07&to=2026-10-07")).toEqual(["Começou ontem, mensagem hoje", "Na fila desde ontem", "Encerrada hoje", "Só ontem"]);
  });

  it("Personalizado ainda sem as datas, ou sem período nenhum (atalho Aguardando do Dashboard), mostra tudo", async () => {
    expect(await list("?period=custom&from=&to=")).toHaveLength(6);
    expect(await list("")).toHaveLength(6);
  });

  it("from/to explícitos, sem período, continuam valendo (links antigos)", async () => {
    expect(await list("?from=2026-10-08T00:00:00.000Z&to=2026-10-08T23:59:59.999Z")).toEqual(["Criada hoje", "Começou ontem, mensagem hoje", "Encerrada hoje"]);
  });

  it("combina o período com o filtro de status", async () => {
    expect(await list("?period=today&status=CLOSED")).toEqual(["Encerrada hoje"]);
    expect(await list("?status=WAITING")).toEqual(["Criada hoje", "Na fila desde ontem"]);
  });

  it("conta o dia no fuso do navegador: 23h do dia anterior em UTC-3 já é Ontem, 22h de hoje em UTC-3 já é amanhã em UTC", async () => {
    await conversation({ name: "Fuso G", status: "WAITING", createdAt: at("2026-10-08T02:00:00Z"), lastMessageAt: at("2026-10-08T02:00:00Z") }); // 7 Oct 23:00 in UTC-3
    await conversation({ name: "Fuso H", status: "WAITING", createdAt: at("2026-10-09T01:00:00Z"), lastMessageAt: at("2026-10-09T01:00:00Z") }); // 8 Oct 22:00 in UTC-3
    // tzOffsetMinutes is what Date#getTimezoneOffset() returns: 180 for UTC-3.
    expect(await list("?period=today&tzOffsetMinutes=180&q=Fuso")).toEqual(["Fuso H"]);
    expect(await list("?period=yesterday&tzOffsetMinutes=180&q=Fuso")).toEqual(["Fuso G"]);
    expect(await list("?period=today&tzOffsetMinutes=0&q=Fuso")).toEqual(["Fuso G"]);
  });
});
