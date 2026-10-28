import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { prisma } from "../src/lib/prisma";
import { resetDatabase, createTestConnection } from "./helpers";

const sent: { connectionId: string; phone: string; text: string }[] = [];
vi.mock("../src/modules/whatsapp/whatsapp.service", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/modules/whatsapp/whatsapp.service")>();
  return {
    ...actual,
    sendAutomatedText: vi.fn(async (connectionId: string, _messageId: string, phone: string, text: string) => {
      sent.push({ connectionId, phone, text });
    }),
  };
});

import * as service from "../src/modules/work-schedules/work-schedules.service";
import { findOrOpenConversationForInboundMessage } from "../src/modules/conversations/conversations.service";
import { handleInboundForFlow } from "../src/modules/flows/flow-engine.service";
import * as flowsService from "../src/modules/flows/flows.service";
import { createTestUser } from "./helpers";

const OFFICE = { name: "Matriz", state: "SP", city: "São Paulo", closedMessage: "Olá, {{cliente}}! Estamos fora do expediente." };
const WEEKDAYS = { MON: { start: "08:00", end: "18:00" }, TUE: { start: "08:00", end: "18:00" }, WED: { start: "08:00", end: "18:00" }, THU: { start: "08:00", end: "18:00" }, FRI: { start: "08:00", end: "18:00" } };

// 2026-10-07 is a Wednesday. São Paulo is UTC−3, so 12:00Z is 09:00 local.
const WED_OPEN = new Date("2026-10-07T12:00:00Z");
const WED_EVENING = new Date("2026-10-07T23:00:00Z");
const SUNDAY = new Date("2026-10-04T15:00:00Z");

describe("Horário de expediente", () => {
  beforeEach(async () => {
    await resetDatabase();
    sent.length = 0;
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  const create = (extra: Partial<Parameters<typeof service.createWorkSchedule>[0]> = {}) =>
    service.createWorkSchedule({ ...OFFICE, days: WEEKDAYS, partialHolidays: [], ...extra });

  async function row(id: string) {
    return prisma.workSchedule.findUniqueOrThrow({ where: { id } });
  }

  it("segue os dias da semana e o fuso do estado", async () => {
    const schedule = await row((await create()).id);
    expect(await service.isWorkScheduleOpen(schedule, WED_OPEN)).toBe(true);
    expect(await service.isWorkScheduleOpen(schedule, WED_EVENING)).toBe(false);
    expect(await service.isWorkScheduleOpen(schedule, SUNDAY)).toBe(false);

    // Manaus is UTC−4: 12:00Z is 08:00 there (open), but in São Paulo's 09:00 it would also be open; 11:30Z is 07:30 in Manaus.
    const manaus = await row((await create({ name: "Filial", state: "AM", city: "Manaus" })).id);
    expect(await service.isWorkScheduleOpen(manaus, new Date("2026-10-07T12:00:00Z"))).toBe(true);
    expect(await service.isWorkScheduleOpen(manaus, new Date("2026-10-07T11:30:00Z"))).toBe(false);
  });

  it("'Atender 24h' abre o dia inteiro", async () => {
    const schedule = await row((await create({ days: { SUN: { allDay: true } } })).id);
    expect(await service.isWorkScheduleOpen(schedule, SUNDAY)).toBe(true);
    expect(await service.isWorkScheduleOpen(schedule, WED_OPEN)).toBe(false);
  });

  it("feriado fecha o dia todo, menos a data indicada como parcial", async () => {
    await prisma.holiday.create({ data: { date: new Date("2026-10-07T00:00:00Z"), name: "Feriado teste", scope: "NATIONAL", source: "MANUAL", year: 2026 } });
    const closed = await row((await create()).id);
    expect(await service.isWorkScheduleOpen(closed, WED_OPEN)).toBe(false);

    const partial = await row((await create({ name: "Parcial", partialHolidays: [{ date: "2026-10-07", start: "08:00", end: "12:00" }] })).id);
    expect(await service.isWorkScheduleOpen(partial, WED_OPEN)).toBe(true); // 09:00
    expect(await service.isWorkScheduleOpen(partial, new Date("2026-10-07T17:00:00Z"))).toBe(false); // 14:00
  });

  it("feriado municipal só vale para a cidade do horário", async () => {
    await prisma.holiday.create({ data: { date: new Date("2026-10-07T00:00:00Z"), name: "Aniversário", scope: "MUNICIPAL", state: "SP", city: "Campinas", source: "MANUAL", year: 2026 } });
    const saoPaulo = await row((await create()).id);
    const campinas = await row((await create({ name: "Campinas", city: "Campinas" })).id);
    expect(await service.isWorkScheduleOpen(saoPaulo, WED_OPEN)).toBe(true);
    expect(await service.isWorkScheduleOpen(campinas, WED_OPEN)).toBe(false);
  });

  it("exige mensagem, ao menos um dia e início antes do término", () => {
    const base = { ...OFFICE, days: WEEKDAYS, partialHolidays: [] };
    expect(service.workScheduleSchema.safeParse(base).success).toBe(true);
    expect(service.workScheduleSchema.safeParse({ ...base, closedMessage: "  " }).success).toBe(false);
    expect(service.workScheduleSchema.safeParse({ ...base, days: {} }).success).toBe(false);
    expect(service.workScheduleSchema.safeParse({ ...base, days: { MON: { start: "18:00", end: "08:00" } } }).success).toBe(false);
    expect(service.workScheduleSchema.safeParse({ ...base, partialHolidays: [{ date: "2026-10-07", start: "12:00", end: "08:00" }] }).success).toBe(false);
  });

  it("conexão sem horário atende 24h: nada a enviar", async () => {
    const connection = await createTestConnection("Suporte");
    expect(await service.getClosedMessageForConnection("WHATSAPP", connection.id, SUNDAY)).toBeNull();
  });

  it("conexão com horário recebe a mensagem só quando fechada", async () => {
    const connection = await createTestConnection("Suporte");
    const schedule = await create();
    await prisma.whatsAppConnection.update({ where: { id: connection.id }, data: { workScheduleId: schedule.id } });
    expect(await service.getClosedMessageForConnection("WHATSAPP", connection.id, WED_OPEN)).toBeNull();
    expect(await service.getClosedMessageForConnection("WHATSAPP", connection.id, SUNDAY)).toBe(OFFICE.closedMessage);
  });

  it("a conversa nova fora do horário devolve a mensagem uma vez; a conversa aberta não repete", async () => {
    const connection = await createTestConnection("Suporte");
    const schedule = await create({ days: { MON: { start: "00:00", end: "00:01" } } }); // closed essentially always
    await prisma.whatsAppConnection.update({ where: { id: connection.id }, data: { workScheduleId: schedule.id } });
    const contact = await prisma.contact.create({ data: { phone: "5511999990000", name: "Joana", whatsappConnectionId: connection.id } });

    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(SUNDAY);
    try {
      const first = await findOrOpenConversationForInboundMessage(connection.id, contact.id, "oi");
      expect(first.isNewConversation).toBe(true);
      expect(first.closedMessage).toBe(OFFICE.closedMessage);
      expect(first.conversation.status).toBe("NEW");

      const second = await findOrOpenConversationForInboundMessage(connection.id, contact.id, "alguém?");
      expect(second.isNewConversation).toBe(false);
      expect(second.closedMessage).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("não exclui um horário em uso por uma conexão", async () => {
    const connection = await createTestConnection("Suporte");
    const schedule = await create();
    await prisma.whatsAppConnection.update({ where: { id: connection.id }, data: { workScheduleId: schedule.id } });
    await expect(service.deleteWorkSchedule(schedule.id)).rejects.toThrow(/Suporte/);

    await prisma.whatsAppConnection.update({ where: { id: connection.id }, data: { workScheduleId: null } });
    await service.deleteWorkSchedule(schedule.id);
    expect(await prisma.workSchedule.count()).toBe(0);
  });

  it("não exclui um horário usado por um nó de fluxo", async () => {
    const schedule = await create();
    const flow = await prisma.flow.create({ data: { name: "Atendimento" } });
    await prisma.flowNode.create({ data: { flowId: flow.id, type: "BUSINESS_HOURS", positionX: 0, positionY: 0, data: { workScheduleId: schedule.id } } });
    await expect(service.deleteWorkSchedule(schedule.id)).rejects.toThrow(/Atendimento/);
  });

  describe("nó de horário do Fluxo", () => {
    async function flowWithHoursNode(connectionId: string, nodeData: Record<string, unknown>) {
      const admin = await createTestUser({ email: "admin@test.dev", role: "ADMIN" });
      const flow = await flowsService.createFlow({ name: "Horário", connectionIds: [connectionId] }, admin.id);
      await flowsService.saveFlowGraph(
        flow.id,
        [
          { id: "s", type: "START", positionX: 0, positionY: 0 },
          { id: "h", type: "BUSINESS_HOURS", positionX: 1, positionY: 0, data: nodeData },
          { id: "open", type: "TEXT_MESSAGE", positionX: 2, positionY: 0, data: { text: "ABERTO" } },
          { id: "closed", type: "TEXT_MESSAGE", positionX: 2, positionY: 1, data: { text: "FECHADO" } },
          { id: "end", type: "END", positionX: 3, positionY: 0 },
        ],
        [
          { sourceNodeId: "s", targetNodeId: "h" },
          { sourceNodeId: "h", targetNodeId: "open", sourceHandle: "open" },
          { sourceNodeId: "h", targetNodeId: "closed", sourceHandle: "closed" },
          { sourceNodeId: "open", targetNodeId: "end" },
          { sourceNodeId: "closed", targetNodeId: "end" },
        ]
      );
      await flowsService.updateFlowMeta(flow.id, { active: true });
    }

    async function customerWritesAt(connectionId: string, when: Date) {
      const contact = await prisma.contact.create({ data: { phone: "5511900000123", name: "Ana", whatsappConnectionId: connectionId } });
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(when);
      try {
        const opened = await findOrOpenConversationForInboundMessage(connectionId, contact.id, "oi");
        if (opened.conversation.status === "IN_FLOW") await handleInboundForFlow(opened.conversation.id, opened.flowId, "oi");
        return opened;
      } finally {
        vi.useRealTimers();
      }
    }

    it("usa o horário escolhido no nó quando a conexão não tem horário", async () => {
      const connection = await createTestConnection("Suporte");
      const schedule = await create();
      await flowWithHoursNode(connection.id, { workScheduleId: schedule.id });
      await customerWritesAt(connection.id, SUNDAY);
      expect(sent.map((m) => m.text)).toEqual(["FECHADO"]);
    });

    it("nó sem horário escolhido conta sempre como aberto", async () => {
      const connection = await createTestConnection("Suporte");
      await flowWithHoursNode(connection.id, { workScheduleId: null });
      await customerWritesAt(connection.id, SUNDAY);
      expect(sent.map((m) => m.text)).toEqual(["ABERTO"]);
    });

    it("quando a conexão tem horário, o do nó é ignorado: aberto segue o fluxo", async () => {
      const connection = await createTestConnection("Suporte");
      const nodeSchedule = await create({ name: "Só sábado", days: { SAT: { allDay: true } } });
      const connectionSchedule = await create();
      await prisma.whatsAppConnection.update({ where: { id: connection.id }, data: { workScheduleId: connectionSchedule.id } });
      await flowWithHoursNode(connection.id, { workScheduleId: nodeSchedule.id });
      await customerWritesAt(connection.id, WED_OPEN); // open for the connection, closed for the node
      expect(sent.map((m) => m.text)).toEqual(["ABERTO"]);
    });

    it("conexão fechada: o Fluxo não começa, vai para a fila com o aviso de expediente", async () => {
      const connection = await createTestConnection("Suporte");
      const schedule = await create();
      await prisma.whatsAppConnection.update({ where: { id: connection.id }, data: { workScheduleId: schedule.id } });
      await flowWithHoursNode(connection.id, { workScheduleId: null });
      const opened = await customerWritesAt(connection.id, SUNDAY);
      expect(opened.conversation.status).toBe("NEW");
      expect(opened.closedMessage).toBe(OFFICE.closedMessage);
      expect(sent).toHaveLength(0);
    });

    it("nó antigo, com dias e horário próprios, continua funcionando", async () => {
      const connection = await createTestConnection("Suporte");
      await flowWithHoursNode(connection.id, { days: [1, 2, 3, 4, 5], start: "08:00", end: "18:00", tzOffsetMinutes: 180 });
      await customerWritesAt(connection.id, SUNDAY);
      expect(sent.map((m) => m.text)).toEqual(["FECHADO"]);
    });
  });
});
