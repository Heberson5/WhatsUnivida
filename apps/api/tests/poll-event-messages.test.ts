import { describe, it, expect, beforeEach, afterAll } from "vitest";
import request from "supertest";
import { createApp } from "../src/app";
import { prisma } from "../src/lib/prisma";
import { resetDatabase, createTestConnection, createTestUser, TEST_PASSWORD } from "./helpers";
import { importHistoricalMessages } from "../src/modules/conversations/conversations.service";

const app = createApp();

async function loginAs(email: string) {
  const res = await request(app).post("/api/auth/login").send({ email, password: TEST_PASSWORD });
  return res.body.accessToken as string;
}

describe("WhatsApp polls (enquetes) and events (lembretes) render instead of being dropped", () => {
  let connectionId: string;

  beforeEach(async () => {
    await resetDatabase();
    connectionId = (await createTestConnection("Suporte")).id;
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("stores a received poll's question/options and returns them in the message DTO", async () => {
    await createTestUser({ email: "admin-poll@test.dev", role: "ADMIN" });
    const token = await loginAs("admin-poll@test.dev");

    await importHistoricalMessages(connectionId, [
      {
        providerMessageId: "poll-1",
        phone: "5511990001111",
        fromMe: false,
        type: "POLL",
        body: null,
        pollQuestion: "Qual horário prefere?",
        pollOptions: ["Manhã", "Tarde", "Noite"],
        timestamp: new Date("2026-01-01T10:00:00Z"),
      },
    ]);

    const contact = await prisma.contact.findFirstOrThrow({ where: { phone: "5511990001111", whatsappConnectionId: connectionId } });
    const conversation = await prisma.conversation.findFirstOrThrow({ where: { contactId: contact.id } });

    const res = await request(app).get(`/api/messages/conversations/${conversation.id}`).set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(1);
    const [message] = res.body.items;
    expect(message.type).toBe("POLL");
    expect(message.attachments).toHaveLength(1);
    expect(message.attachments[0].kind).toBe("POLL");
    expect(message.attachments[0].pollQuestion).toBe("Qual horário prefere?");
    expect(message.attachments[0].pollOptions).toEqual(["Manhã", "Tarde", "Noite"]);
  });

  it("stores a received event's name/date/description/link and returns them in the message DTO", async () => {
    await createTestUser({ email: "admin-event@test.dev", role: "ADMIN" });
    const token = await loginAs("admin-event@test.dev");

    await importHistoricalMessages(connectionId, [
      {
        providerMessageId: "event-1",
        phone: "5511990002222",
        fromMe: false,
        type: "EVENT",
        body: null,
        eventName: "Reunião de alinhamento",
        eventDescription: "Trazer o contrato assinado",
        eventStartAt: new Date("2026-03-10T14:00:00Z"),
        eventJoinLink: "https://meet.example.com/abc",
        latitude: -23.55,
        longitude: -46.63,
        timestamp: new Date("2026-01-01T10:00:00Z"),
      },
    ]);

    const contact = await prisma.contact.findFirstOrThrow({ where: { phone: "5511990002222", whatsappConnectionId: connectionId } });
    const conversation = await prisma.conversation.findFirstOrThrow({ where: { contactId: contact.id } });

    const res = await request(app).get(`/api/messages/conversations/${conversation.id}`).set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    const [message] = res.body.items;
    expect(message.type).toBe("EVENT");
    const [att] = message.attachments;
    expect(att.kind).toBe("EVENT");
    expect(att.eventName).toBe("Reunião de alinhamento");
    expect(att.eventDescription).toBe("Trazer o contrato assinado");
    expect(att.eventStartAt).toBe(new Date("2026-03-10T14:00:00Z").toISOString());
    expect(att.eventJoinLink).toBe("https://meet.example.com/abc");
    expect(att.latitude).toBeCloseTo(-23.55);
    expect(att.longitude).toBeCloseTo(-46.63);
  });
});
