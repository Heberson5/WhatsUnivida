import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { birthdaysToday, businessDay, daysUntilBirthday, fillBirthdayTags, isBirthdayOn, DEFAULT_BIRTHDAY_MESSAGES } from "@whatsatendende/types";
import { createApp } from "../src/app";
import { prisma } from "../src/lib/prisma";
import { env } from "../src/config/env";
import { resetDatabase, createTestUser, createWaitingConversation, TEST_PASSWORD } from "./helpers";

const app = createApp();

async function loginAs(email: string) {
  const res = await request(app).post("/api/auth/login").send({ email, password: TEST_PASSWORD });
  return res.body.accessToken as string;
}

const today = businessDay(new Date(), env.BUSINESS_TZ_OFFSET_MINUTES);
const pad = (n: number) => String(n).padStart(2, "0");
// Born on today's day and month (28/02 stands in for 29/02 so the test never depends on the year).
const bornToday = (year: number) => `${pad(today.month === 2 && today.day === 29 ? 28 : today.day)}/${pad(today.month)}/${year}`;
const notToday = `${pad(today.day === 1 ? 2 : 1)}/${pad(today.month)}/1990`;

describe("Aniversário do cliente", () => {
  it("29/02 faz aniversário em 28/02 nos anos sem 29; conta os dias até o próximo", () => {
    expect(isBirthdayOn("29/02/1988", { year: 2027, month: 2, day: 28 })).toBe(true);
    expect(isBirthdayOn("29/02/1988", { year: 2028, month: 2, day: 28 })).toBe(false);
    expect(isBirthdayOn("29/02/1988", { year: 2028, month: 2, day: 29 })).toBe(true);
    expect(daysUntilBirthday("25/10/1964", { year: 2026, month: 10, day: 25 })).toBe(0);
    expect(daysUntilBirthday("28/10/1964", { year: 2026, month: 10, day: 25 })).toBe(3);
    expect(daysUntilBirthday("24/10/1964", { year: 2026, month: 10, day: 25 })).toBe(364);
  });

  it("o dia segue o fuso da empresa, não o do servidor", () => {
    // 02:00 UTC of the 26th is still the 25th in UTC-4.
    expect(businessDay(new Date("2026-10-26T02:00:00Z"), 240)).toEqual({ year: 2026, month: 10, day: 25 });
    expect(businessDay(new Date("2026-10-26T05:00:00Z"), 240)).toEqual({ year: 2026, month: 10, day: 26 });
  });

  it("lista cada pessoa uma vez, o titular primeiro, com a idade que faz hoje e as tags preenchidas", () => {
    const day = { year: 2026, month: 10, day: 25 };
    const people = birthdaysToday(
      [
        { name: "Pedro Souza", relation: "Neto", birth: "25/10/2018", holder: false, contract: "C1" },
        { name: "Maria Aparecida Souza", relation: "Titular", birth: "25/10/1964", holder: true, contract: "C1" },
        { name: "Pedro  Souza", relation: "Neto", birth: "25/10/2018", holder: false, contract: "C2" },
        { name: "José Souza", relation: "Cônjuge", birth: "28/10/1961", holder: false, contract: "C1" },
      ],
      day
    );
    expect(people.map((p) => [p.name, p.age])).toEqual([["Maria Aparecida Souza", 62], ["Pedro Souza", 8]]);
    expect(fillBirthdayTags(DEFAULT_BIRTHDAY_MESSAGES.BENEFICIARY, people[1])).toContain("Hoje é aniversário de Pedro Souza (neto)");
    expect(fillBirthdayTags("{{aniversariante_primeiro_nome}} faz {{idade}}", people[1])).toBe("Pedro faz 8");
  });

  describe("no atendimento", () => {
    let adminToken: string;
    let agentToken: string;
    let otherToken: string;
    let agentId: string;
    let otherId: string;
    let connectionId: string;

    async function inProgress(phone: string, assignedAgentId: string) {
      const { conversation } = await createWaitingConversation(phone, connectionId);
      return prisma.conversation.update({ where: { id: conversation.id }, data: { status: "IN_PROGRESS", assignedAgentId, acceptedAt: new Date() } });
    }

    beforeAll(async () => {
      await resetDatabase();
      await prisma.dataSource.deleteMany();
      await prisma.birthdayGreeting.deleteMany();
      await createTestUser({ email: "admin-bd@test.dev", role: "ADMIN" });
      adminToken = await loginAs("admin-bd@test.dev");
      const connection = await request(app).post("/api/whatsapp/connections").set("Authorization", `Bearer ${adminToken}`).send({ name: "Aniversários" });
      connectionId = connection.body.id;
      await request(app).post(`/api/whatsapp/connections/${connectionId}/connect`).set("Authorization", `Bearer ${adminToken}`);
      await new Promise((resolve) => setTimeout(resolve, 2200));
      agentId = (await createTestUser({ email: "ana-bd@test.dev", role: "AGENT", displayName: "Ana", whatsappConnectionId: connectionId })).id;
      otherId = (await createTestUser({ email: "bia-bd@test.dev", role: "AGENT", displayName: "Bia", whatsappConnectionId: connectionId })).id;
      agentToken = await loginAs("ana-bd@test.dev");
      otherToken = await loginAs("bia-bd@test.dev");

      await inProgress("5565999990011", agentId);
      await inProgress("5565999990022", agentId);
      const csv = [
        "telefone_whatsapp,codigo_cliente,nome_cliente,numero_contrato,situacao_contrato,beneficiarios",
        `5565999990011,1,Maria Aparecida Souza,C-1,Ativo,Maria Aparecida Souza;Titular;${bornToday(1964)};Não | Pedro Souza;Neto;${bornToday(2018)};Não | José Souza;Cônjuge;${notToday};Não`,
        `5565999990022,2,Carlos Lima,C-2,Cancelado,Carlos Lima;Titular;${bornToday(1970)};Não`,
      ].join("\n");
      const source = await request(app).post("/api/data-sources").set("Authorization", `Bearer ${adminToken}`).send({ name: "Planilha", kind: "UPLOAD" });
      await request(app).post(`/api/data-sources/${source.body.id}/upload`).set("Authorization", `Bearer ${adminToken}`).attach("file", Buffer.from(csv), { filename: "base.csv", contentType: "text/csv" });
      await request(app).post(`/api/data-sources/${source.body.id}/active`).set("Authorization", `Bearer ${adminToken}`).send({ active: true }).expect(200);
    }, 20000);

    afterAll(async () => {
      await prisma.dataSource.deleteMany();
      await prisma.birthdayGreeting.deleteMany();
      await prisma.$disconnect();
    });

    it("o aviso aparece com titular e beneficiário, as mensagens prontas, e o selo vai para o card", async () => {
      const conversation = await prisma.conversation.findFirstOrThrow({ where: { contact: { phone: "5565999990011" } } });
      const data = (await request(app).get(`/api/conversations/${conversation.id}/birthday`).set("Authorization", `Bearer ${agentToken}`)).body;
      expect(data.pending).toBe(true);
      expect(data.people.map((p: { name: string; kind: string; age: number }) => [p.name, p.kind, p.age])).toEqual([
        ["Maria Aparecida Souza", "HOLDER", today.year - 1964],
        ["Pedro Souza", "BENEFICIARY", today.year - 2018],
      ]);
      // {{primeiro_nome}} is how the contact is called (Contatos › Primeiro nome, else the first word of its name).
      expect(data.people[0].text).toMatch(/^(Bom dia|Boa tarde|Boa noite), Cliente! 🎉\n\nHoje o dia é seu/);
      expect(data.people[1].text).toContain("Hoje é aniversário de Pedro Souza (neto)");

      const mine = (await request(app).get("/api/conversations/mine").set("Authorization", `Bearer ${agentToken}`)).body;
      const card = mine.find((c: { id: string }) => c.id === conversation.id);
      expect(card.birthdaysToday.map((b: { name: string }) => b.name)).toEqual(["Maria Aparecida Souza", "Pedro Souza"]);
    });

    it("contrato cancelado não entra", async () => {
      const conversation = await prisma.conversation.findFirstOrThrow({ where: { contact: { phone: "5565999990022" } } });
      const data = (await request(app).get(`/api/conversations/${conversation.id}/birthday`).set("Authorization", `Bearer ${agentToken}`)).body;
      expect(data).toEqual({ pending: false, people: [] });
    });

    it("parabenizado uma vez no ano: em outra conversa, o aviso mostra quem já mandou", async () => {
      const conversation = await prisma.conversation.findFirstOrThrow({ where: { contact: { phone: "5565999990011" } } });
      await request(app).post(`/api/conversations/${conversation.id}/birthday/greeted`).set("Authorization", `Bearer ${agentToken}`).send({ personKey: "maria aparecida souza" }).expect(204);
      const after = (await request(app).get(`/api/conversations/${conversation.id}/birthday`).set("Authorization", `Bearer ${agentToken}`)).body;
      // Pedro is still to be congratulated: the pop-up stays until everyone was (or "Agora não").
      expect(after.pending).toBe(true);
      expect(after.people[0].greeted).toMatchObject({ byName: "Ana" });
      await request(app).post(`/api/conversations/${conversation.id}/birthday/greeted`).set("Authorization", `Bearer ${agentToken}`).send({ personKey: "pedro souza" }).expect(204);
      expect((await request(app).get(`/api/conversations/${conversation.id}/birthday`).set("Authorization", `Bearer ${agentToken}`)).body.pending).toBe(false);

      // Next conversation of the same contact, with someone else: the pop-up comes back, saying it was already done.
      await prisma.conversation.update({ where: { id: conversation.id }, data: { status: "CLOSED" } });
      const again = await prisma.conversation.create({
        data: { contactId: conversation.contactId, whatsappConnectionId: connectionId, status: "IN_PROGRESS", assignedAgentId: otherId, acceptedAt: new Date() },
      });
      const forBia = (await request(app).get(`/api/conversations/${again.id}/birthday`).set("Authorization", `Bearer ${otherToken}`)).body;
      expect(forBia.pending).toBe(true);
      expect(forBia.people.map((p: { greeted: { byName: string } }) => p.greeted.byName)).toEqual(["Ana", "Ana"]);
      await request(app).post(`/api/conversations/${again.id}/birthday/ack`).set("Authorization", `Bearer ${otherToken}`).expect(204);
      expect((await request(app).get(`/api/conversations/${again.id}/birthday`).set("Authorization", `Bearer ${otherToken}`)).body.pending).toBe(false);
      expect((await request(app).post(`/api/conversations/${again.id}/birthday/greeted`).set("Authorization", `Bearer ${otherToken}`).send({ personKey: "jose souza" })).status).toBe(400);
    });

    it("Respostas › Aniversários: já vem com os dois textos; desligada, o aviso não traz mensagem", async () => {
      expect((await request(app).get("/api/birthday-messages").set("Authorization", `Bearer ${agentToken}`)).status).toBe(403);
      const messages = (await request(app).get("/api/birthday-messages").set("Authorization", `Bearer ${adminToken}`)).body;
      expect(messages.map((m: { kind: string; text: string }) => [m.kind, m.text])).toEqual([
        ["HOLDER", DEFAULT_BIRTHDAY_MESSAGES.HOLDER],
        ["BENEFICIARY", DEFAULT_BIRTHDAY_MESSAGES.BENEFICIARY],
      ]);
      await request(app).patch("/api/birthday-messages/BENEFICIARY").set("Authorization", `Bearer ${adminToken}`).send({ active: false }).expect(200);
      try {
        const conversation = await prisma.conversation.findFirstOrThrow({ where: { contact: { phone: "5565999990011" }, status: "IN_PROGRESS" } });
        const data = (await request(app).get(`/api/conversations/${conversation.id}/birthday`).set("Authorization", `Bearer ${otherToken}`)).body;
        expect(data.people.find((p: { kind: string }) => p.kind === "BENEFICIARY").text).toBeNull();
      } finally {
        await request(app).patch("/api/birthday-messages/BENEFICIARY").set("Authorization", `Bearer ${adminToken}`).send({ active: true }).expect(200);
      }
    });
  });
});
