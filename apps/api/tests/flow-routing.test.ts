import fs from "node:fs";
import path from "node:path";
import { describe, it, expect, beforeEach, afterAll, afterEach, vi } from "vitest";
import { CloudApiWhatsAppProvider, type InboundMessageEvent, type OutboundMenu } from "@whatsatendende/whatsapp";
import { prisma } from "../src/lib/prisma";
import { env } from "../src/config/env";
import { resetDatabase, createTestConnection, createTestUser } from "./helpers";

const sent: { kind: "text" | "file" | "menu"; text: string; menu?: OutboundMenu }[] = [];
let official = false;
vi.mock("../src/modules/whatsapp/whatsapp.service", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/modules/whatsapp/whatsapp.service")>();
  return {
    ...actual,
    isOfficialConnection: vi.fn(() => official),
    sendAutomatedText: vi.fn(async (_c: string, _m: string, _p: string, text: string) => {
      sent.push({ kind: "text", text });
    }),
    sendOutboundFile: vi.fn(async (_c: string, _m: string, _p: string, _b: Buffer, _f: string, _t: string, _s: string | null, caption?: string) => {
      sent.push({ kind: "file", text: caption ?? "" });
    }),
    sendAutomatedMenu: vi.fn(async (_c: string, _m: string, _p: string, menu: OutboundMenu) => {
      sent.push({ kind: "menu", text: menu.body, menu });
    }),
  };
});

// Loaded after the mock so every module binds to the mocked whatsapp.service.
import { abandonIdleFlowSessions, dispatchWaitingTransfers, handleInboundForFlow } from "../src/modules/flows/flow-engine.service";
import * as conversationsService from "../src/modules/conversations/conversations.service";
import * as flowsService from "../src/modules/flows/flows.service";

type NodeInput = { id: string; type: "START" | "TEXT_MESSAGE" | "MENU" | "TRANSFER_TO_AGENT" | "END"; data?: Record<string, unknown> };

describe("Fluxo: transferência pelos usuários do passo, Abandonados, horário e API Oficial", () => {
  let connectionId: string;
  let adminId: string;
  let phoneCounter = 0;

  beforeEach(async () => {
    await resetDatabase();
    sent.length = 0;
    official = false;
    connectionId = (await createTestConnection("Univida QR")).id;
    adminId = (await createTestUser({ email: "admin-rota@test.dev", role: "ADMIN" })).id;
  });

  afterEach(() => vi.unstubAllGlobals());

  afterAll(async () => {
    await prisma.$disconnect();
  });

  async function activeFlow(nodes: NodeInput[], edges: [string, string, string?][]) {
    const flow = await flowsService.createFlow({ name: "Univida", connectionIds: [connectionId] }, adminId);
    await flowsService.saveFlowGraph(
      flow.id,
      nodes.map((n, i) => ({ id: n.id, type: n.type, positionX: i * 100, positionY: 0, data: n.data ?? {} })),
      edges.map(([from, to, handle]) => ({ sourceNodeId: from, targetNodeId: to, sourceHandle: handle ?? null }))
    );
    await flowsService.updateFlowMeta(flow.id, { active: true });
    return flow.id;
  }

  /** Menu "Vendas" (Planos / Cemitério) → text with {{opcao}} → transfer step with these people. */
  function salesFlow(people: string[], start: Record<string, unknown> = {}) {
    return activeFlow(
      [
        { id: "s", type: "START", data: start },
        { id: "m", type: "MENU", data: { name: "Vendas", prompt: "Escolha:", options: [{ id: "planos", label: "Planos Univida" }, { id: "cem", label: "Cemitério Parque" }] } },
        { id: "c", type: "MENU", data: { name: "Cidades", prompt: "Cidade?", options: [{ id: "tga", label: "Tangará da Serra" }] } },
        { id: "t", type: "TEXT_MESSAGE", data: { text: "📍 Cidade selecionada: {{opcao}}." } },
        { id: "x", type: "TRANSFER_TO_AGENT", data: { name: "Vendas · Planos", mode: people.length ? "selected" : "any", assignedAgentIds: people } },
      ],
      [
        ["s", "m"],
        ["m", "c", "planos"],
        ["m", "c", "cem"],
        ["c", "t", "tga"],
        ["t", "x"],
      ]
    );
  }

  async function customerWrites(phone: string, text: string, selectedOptionId: string | null = null) {
    const contact = await prisma.contact.upsert({ where: { id: phone }, update: {}, create: { id: phone, phone, name: "Ana", whatsappConnectionId: connectionId } });
    const opened = await conversationsService.findOrOpenConversationForInboundMessage(connectionId, contact.id, text);
    if (opened.conversation.status === "IN_FLOW") await handleInboundForFlow(opened.conversation.id, opened.flowId, text, selectedOptionId);
    return prisma.conversation.findUniqueOrThrow({ where: { id: opened.conversation.id } });
  }

  const nextPhone = () => `55659911${String(++phoneCounter).padStart(4, "0")}`;
  const notesOf = async (conversationId: string) => (await prisma.conversationNote.findMany({ where: { conversationId }, orderBy: { createdAt: "asc" } })).map((n) => n.body);

  it("fills {{opcao}} and leaves the path picked as a system note for whoever takes it", async () => {
    await salesFlow([]);
    const phone = nextPhone();
    await customerWrites(phone, "Oi");
    await customerWrites(phone, "1");
    const conversation = await customerWrites(phone, "Tangará da Serra");
    expect(sent.map((m) => m.text)).toContain("📍 Cidade selecionada: Tangará da Serra.");
    expect(conversation.status).toBe("NEW");
    const note = await prisma.conversationNote.findFirstOrThrow({ where: { conversationId: conversation.id } });
    expect(note).toMatchObject({ authorId: null, body: "Escolhas no fluxo: Planos Univida › Tangará da Serra" });
  });

  it("gives it to the step's person online even when they attend another connection", async () => {
    const otherConnection = await createTestConnection("Vendas");
    const seller = await createTestUser({ email: "vendedor@test.dev", role: "AGENT", presence: "ONLINE", whatsappConnectionId: otherConnection.id });
    await salesFlow([seller.id]);
    const phone = nextPhone();
    await customerWrites(phone, "Oi");
    await customerWrites(phone, "1");
    const conversation = await customerWrites(phone, "1");
    expect(conversation).toMatchObject({ status: "IN_PROGRESS", assignedAgentId: seller.id, whatsappConnectionId: connectionId });
  });

  it("with the step's people offline, goes to Abandonados for someone online — who sees why on accepting", async () => {
    const seller = await createTestUser({ email: "vend-off@test.dev", role: "AGENT", presence: "OFFLINE", whatsappConnectionId: connectionId });
    const colleague = await createTestUser({ email: "colega@test.dev", role: "AGENT", presence: "ONLINE", whatsappConnectionId: connectionId });
    await salesFlow([seller.id]);
    const phone = nextPhone();
    await customerWrites(phone, "Oi");
    await customerWrites(phone, "1");
    const conversation = await customerWrites(phone, "1");
    expect(conversation.status).toBe("FLOW_ABANDONED");

    const visible = await conversationsService.listAbandoned({ userId: colleague.id, role: "AGENT", whatsappConnectionId: connectionId });
    expect(visible.map((c) => c.id)).toEqual([conversation.id]);

    // The customer writing again keeps it there.
    expect((await customerWrites(phone, "alguém aí?")).status).toBe("FLOW_ABANDONED");

    await conversationsService.acceptConversation(conversation.id, colleague.id);
    expect(await notesOf(conversation.id)).toEqual([
      "Escolhas no fluxo: Planos Univida › Tangará da Serra",
      "Nenhum atendente do passo Vendas · Planos estava online quando o cliente chegou.",
    ]);
  });

  it("with nobody online, waits on the step — and the step's person coming online gets it", async () => {
    const seller = await createTestUser({ email: "vend-espera@test.dev", role: "AGENT", presence: "OFFLINE", whatsappConnectionId: connectionId });
    await salesFlow([seller.id]);
    const phone = nextPhone();
    await customerWrites(phone, "Oi");
    await customerWrites(phone, "1");
    const waiting = await customerWrites(phone, "1");
    expect(waiting.status).toBe("IN_FLOW");
    sent.length = 0;
    // A message while waiting is kept, the bot says nothing.
    await customerWrites(phone, "ok, aguardo");
    expect(sent).toHaveLength(0);

    await dispatchWaitingTransfers();
    expect((await prisma.conversation.findUniqueOrThrow({ where: { id: waiting.id } })).status).toBe("IN_FLOW");

    await prisma.user.update({ where: { id: seller.id }, data: { presence: "ONLINE" } });
    await dispatchWaitingTransfers();
    expect(await prisma.conversation.findUniqueOrThrow({ where: { id: waiting.id } })).toMatchObject({ status: "IN_PROGRESS", assignedAgentId: seller.id });
  });

  it("someone else coming online first sends the waiting conversation to Abandonados", async () => {
    const seller = await createTestUser({ email: "vend-esp2@test.dev", role: "AGENT", presence: "OFFLINE", whatsappConnectionId: connectionId });
    const colleague = await createTestUser({ email: "colega2@test.dev", role: "AGENT", presence: "OFFLINE", whatsappConnectionId: connectionId });
    await salesFlow([seller.id]);
    const phone = nextPhone();
    await customerWrites(phone, "Oi");
    await customerWrites(phone, "1");
    const waiting = await customerWrites(phone, "1");
    await prisma.user.update({ where: { id: colleague.id }, data: { presence: "ONLINE" } });
    await dispatchWaitingTransfers();
    expect((await prisma.conversation.findUniqueOrThrow({ where: { id: waiting.id } })).status).toBe("FLOW_ABANDONED");
  });

  it("a menu left unanswered past the Início's limit tells the customer and goes to Abandonados", async () => {
    const colleague = await createTestUser({ email: "colega3@test.dev", role: "AGENT", presence: "ONLINE", whatsappConnectionId: connectionId });
    await salesFlow([], { abandonAfterMinutes: 30 });
    const phone = nextPhone();
    await customerWrites(phone, "Oi");
    const conversation = await customerWrites(phone, "1");

    await abandonIdleFlowSessions(new Date(Date.now() + 29 * 60_000));
    expect((await prisma.conversation.findUniqueOrThrow({ where: { id: conversation.id } })).status).toBe("IN_FLOW");

    await abandonIdleFlowSessions(new Date(Date.now() + 31 * 60_000));
    expect((await prisma.conversation.findUniqueOrThrow({ where: { id: conversation.id } })).status).toBe("FLOW_ABANDONED");
    expect(sent.at(-1)!.text).toBe("Como não recebemos sua resposta, um de nossos atendentes vai falar com você em breve.");

    await conversationsService.acceptConversation(conversation.id, colleague.id);
    expect(await notesOf(conversation.id)).toEqual([
      "Escolhas no fluxo: Planos Univida",
      "O cliente parou de responder os menus por mais de 30 minutos (parou em: Planos Univida › Cidades).",
    ]);
  });

  it("outside the connection's hours, tells the hours and asks — instead of the schedule's own notice", async () => {
    const schedule = await prisma.workSchedule.create({
      data: { name: "Comercial", state: "MT", city: "Tangará da Serra", days: {}, closedMessage: "Estamos fechados." },
    });
    await prisma.whatsAppConnection.update({ where: { id: connectionId }, data: { workScheduleId: schedule.id } });
    await salesFlow([], { outOfHoursPrompt: true });

    const phone = nextPhone();
    const contact = await prisma.contact.create({ data: { phone, name: "Ana", whatsappConnectionId: connectionId } });
    const opened = await conversationsService.findOrOpenConversationForInboundMessage(connectionId, contact.id, "Oi");
    expect(opened.closedMessage).toBeNull();
    expect(opened.conversation.status).toBe("IN_FLOW");
    await handleInboundForFlow(opened.conversation.id, opened.flowId, "Oi");
    expect(sent[0].text).toMatch(/^No momento estamos fora do nosso horário de atendimento\./);
    expect(sent[0].text).toMatch(/1\. Sim, continuar\n2\. Não, obrigado\(a\)$/);

    await handleInboundForFlow(opened.conversation.id, null, "2");
    expect(sent.at(-1)!.text).toBe("Tudo bem! Ficamos à disposição sempre que precisar. Até logo! 👋");
    expect((await prisma.conversation.findUniqueOrThrow({ where: { id: opened.conversation.id } })).status).toBe("CLOSED");
  });

  it("answering Sim to the hours question goes on with the flow", async () => {
    const schedule = await prisma.workSchedule.create({ data: { name: "Fechado", state: "MT", city: "Cuiabá", days: {}, closedMessage: "Fechado." } });
    await prisma.whatsAppConnection.update({ where: { id: connectionId }, data: { workScheduleId: schedule.id } });
    await salesFlow([], { outOfHoursPrompt: true });
    const phone = nextPhone();
    await customerWrites(phone, "Oi");
    sent.length = 0;
    await customerWrites(phone, "1");
    expect(sent[0].text).toBe("Escolha:\n1. Planos Univida\n2. Cemitério Parque\n3. Encerrar atendimento");
  });

  it("QR Code: Voltar, Menu inicial e Encerrar atendimento nos menus", async () => {
    await salesFlow([]);
    const phone = nextPhone();
    await customerWrites(phone, "Oi");
    // The first menu has nowhere to go back to.
    expect(sent.at(-1)!.text).toBe("Escolha:\n1. Planos Univida\n2. Cemitério Parque\n3. Encerrar atendimento");
    await customerWrites(phone, "2");
    expect(sent.at(-1)!.text).toBe("Cidade?\n1. Tangará da Serra\n2. Voltar\n3. Menu inicial\n4. Encerrar atendimento");

    await customerWrites(phone, "2"); // Voltar
    expect(sent.at(-1)!.text).toMatch(/^Escolha:\n1\. Planos Univida/);
    await customerWrites(phone, "1");
    await customerWrites(phone, "menu inicial");
    expect(sent.at(-1)!.text).toMatch(/^Escolha:\n1\. Planos Univida/);

    // The path left for the attendant only has what the customer kept.
    await customerWrites(phone, "1");
    const handed = await customerWrites(phone, "1");
    expect(handed.status).toBe("NEW");
    expect(await notesOf(handed.id)).toContain("Escolhas no fluxo: Planos Univida › Tangará da Serra");
  });

  it("QR Code: Encerrar atendimento fecha a conversa sem pesquisa; a opção pode ser desligada no menu", async () => {
    await activeFlow(
      [
        { id: "s", type: "START" },
        { id: "m", type: "MENU", data: { prompt: "Escolha:", options: [{ id: "a", label: "Vendas" }] } },
        { id: "n", type: "MENU", data: { prompt: "Plano?", options: [{ id: "b", label: "Ouro" }], navigation: { home: false, end: false } } },
        { id: "x", type: "TRANSFER_TO_AGENT", data: { mode: "any", assignedAgentIds: [] } },
      ],
      [
        ["s", "m"],
        ["m", "n", "a"],
        ["n", "x", "b"],
      ]
    );
    const phone = nextPhone();
    await customerWrites(phone, "Oi");
    await customerWrites(phone, "1");
    expect(sent.at(-1)!.text).toBe("Plano?\n1. Ouro\n2. Voltar");
    await customerWrites(phone, "voltar");
    const closed = await customerWrites(phone, "encerrar");
    expect(sent.at(-1)!.text).toBe("Tudo bem! Ficamos à disposição sempre que precisar. Até logo! 👋");
    expect(closed.status).toBe("CLOSED");
    expect(await notesOf(closed.id)).toEqual(["O cliente encerrou o atendimento pelo menu do fluxo."]);
    expect(await prisma.satisfactionSurvey.count({ where: { conversationId: closed.id } })).toBe(0);
  });

  it("on the API Oficial, sends the menu as buttons and takes the tapped one by its id", async () => {
    official = true;
    await salesFlow([]);
    const phone = nextPhone();
    await customerWrites(phone, "Oi");
    expect(sent[0]).toMatchObject({ kind: "menu", text: "Escolha:" });
    expect(sent[0].menu!.options).toEqual([{ id: "planos", label: "Planos Univida" }, { id: "cem", label: "Cemitério Parque" }]);
    await customerWrites(phone, "Cemitério Parque", "cem");
    expect(sent.at(-1)).toMatchObject({ kind: "menu", text: "Cidade?" });
    expect(sent.at(-1)!.menu!.listTitle).toBe("Cidades");
  });

  it("sends a step's photo with its text as the caption", async () => {
    const storageKey = `flow-photo-${Date.now()}.jpg`;
    fs.mkdirSync(env.UPLOAD_DIR, { recursive: true });
    fs.writeFileSync(path.join(env.UPLOAD_DIR, storageKey), Buffer.from([0xff, 0xd8, 0xff]));
    await activeFlow(
      [
        { id: "s", type: "START" },
        { id: "t", type: "TEXT_MESSAGE", data: { text: "Tenha em mãos o pedido médico.", image: { storageKey, fileName: "guias.jpg", mimeType: "image/jpeg", sizeBytes: 3 } } },
        { id: "x", type: "TRANSFER_TO_AGENT", data: { mode: "any", assignedAgentIds: [] } },
      ],
      [
        ["s", "t"],
        ["t", "x"],
      ]
    );
    const conversation = await customerWrites(nextPhone(), "Oi");
    expect(sent[0]).toEqual({ kind: "file", text: "Tenha em mãos o pedido médico." });
    const message = await prisma.message.findFirstOrThrow({ where: { conversationId: conversation.id, automatedBy: "FLOW" }, include: { attachments: true } });
    expect(message).toMatchObject({ type: "IMAGE", body: "Tenha em mãos o pedido médico." });
    expect(message.attachments[0]).toMatchObject({ storageKey, kind: "IMAGE" });
    fs.rmSync(path.join(env.UPLOAD_DIR, storageKey), { force: true });
  });
});

describe("API Oficial: botões e listas", () => {
  const provider = new CloudApiWhatsAppProvider({ phoneNumberId: "123", accessToken: "token", graphApiBaseUrl: "https://graph.test" });
  let bodies: Record<string, unknown>[] = [];

  beforeEach(() => {
    bodies = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init?: RequestInit) => {
        if (typeof init?.body === "string") bodies.push(JSON.parse(init.body));
        return new Response(JSON.stringify({ messages: [{ id: "wamid.1" }], id: "media-1" }), { status: 200 });
      })
    );
  });
  afterEach(() => vi.unstubAllGlobals());

  it("up to 3 short options go as reply buttons", async () => {
    await provider.sendMenu("5565999990000", { body: "Como deseja ser atendido?", options: [{ id: "a", label: "Por Ligação" }, { id: "b", label: "Pelo WhatsApp" }] });
    expect(bodies[0]).toMatchObject({
      type: "interactive",
      interactive: { type: "button", body: { text: "Como deseja ser atendido?" }, action: { buttons: [{ type: "reply", reply: { id: "a", title: "Por Ligação" } }, { type: "reply", reply: { id: "b", title: "Pelo WhatsApp" } }] } },
    });
  });

  it("more options go as a list, a long name cut with the full one underneath", async () => {
    const labs = ["Lab. Alvim", "Lab. Bioanálise", "Lab. Laborclin", "Hemo Lab (Clínica Renova) Centro"].map((label, i) => ({ id: `l${i}`, label }));
    await provider.sendMenu("5565999990000", { body: "Selecione", options: labs, listTitle: "Laboratórios" });
    const interactive = bodies[0].interactive as { type: string; action: { button: string; sections: { title: string; rows: { id: string; title: string; description?: string }[] }[] } };
    expect(interactive.type).toBe("list");
    expect(interactive.action.button).toBe("Ver opções");
    expect(interactive.action.sections[0].title).toBe("Laboratórios");
    expect(interactive.action.sections[0].rows[3]).toEqual({ id: "l3", title: "Hemo Lab (Clínica Renov…", description: "Hemo Lab (Clínica Renova) Centro" });
  });

  it("a tapped button comes back as a text with the option's id", async () => {
    const events: InboundMessageEvent[] = [];
    provider.onMessage((event) => {
      events.push(event);
    });
    await provider.ingestWebhookChange({
      messages: [{ id: "wamid.2", from: "5565999990000", timestamp: "1792150000", type: "interactive", interactive: { type: "button_reply", button_reply: { id: "b", title: "Pelo WhatsApp" } } }],
    });
    expect(events[0]).toMatchObject({ type: "TEXT", body: "Pelo WhatsApp", selectedOptionId: "b" });
  });
});

describe("Fluxos que vêm com o sistema (Univida)", () => {
  let connectionId: string;

  beforeEach(async () => {
    await resetDatabase();
    sent.length = 0;
    official = false;
    connectionId = (await createTestConnection("Univida")).id;
    await createTestUser({ email: "admin-seed@test.dev", role: "ADMIN" });
  });

  it("come in once, switched off and with no connection — a deleted one never comes back", async () => {
    const { syncDefaultFlows } = await import("../src/modules/flows/default-flows");
    expect(await syncDefaultFlows()).toBe(2);
    const flows = await prisma.flow.findMany({ include: { connections: true, nodes: true }, orderBy: { name: "asc" } });
    expect(flows.map((f) => [f.name, f.active, f.connections.length, f.nodes.length])).toEqual([
      ["Univida · API Oficial", false, 0, 42],
      ["Univida · QR Code", false, 0, 42],
    ]);
    expect(await syncDefaultFlows()).toBe(0);
    await prisma.flow.delete({ where: { id: flows[0].id } });
    expect(await syncDefaultFlows()).toBe(0);
    expect(await prisma.flow.count()).toBe(1);
  });

  it("the QR Code one runs Guias › Laboratório › Campo Novo to the Guias · Exames queue", async () => {
    const { syncDefaultFlows } = await import("../src/modules/flows/default-flows");
    await syncDefaultFlows();
    const qr = await prisma.flow.findFirstOrThrow({ where: { name: "Univida · QR Code" } });
    await flowsService.updateFlowMeta(qr.id, { connectionIds: [connectionId], active: true });

    const contact = await prisma.contact.create({ data: { phone: "5565999112233", name: "Ana", whatsappConnectionId: connectionId } });
    const say = async (text: string) => {
      const opened = await conversationsService.findOrOpenConversationForInboundMessage(connectionId, contact.id, text);
      if (opened.conversation.status === "IN_FLOW") await handleInboundForFlow(opened.conversation.id, opened.flowId, text);
      return prisma.conversation.findUniqueOrThrow({ where: { id: opened.conversation.id } });
    };
    await say("Oi");
    expect(sent[0].text).toMatch(/^Olá! 😊\nQue bom ter você aqui na Univida!/);
    expect(sent[0].text).toMatch(/1\. Por Ligação\n2\. Pelo WhatsApp\n3\. Encerrar atendimento$/);
    await say("2");
    await say("1");
    await say("Guias");
    expect(sent.at(-1)).toMatchObject({ kind: "file" });
    expect(sent.at(-1)!.text).toMatch(/Você selecionou a opção \*Guias\*\./);
    await say("2");
    await say("3");
    expect(sent.at(-1)!.text).toMatch(/1\. Lab\. Alvim\n2\. Lab\. Bioanálise/);
    const done = await say("1");
    expect(sent.at(-1)!.text).toMatch(/^Tudo certo! 😊\nEstou te encaminhando/);
    expect(done.status).toBe("NEW");
    const note = await prisma.conversationNote.findFirstOrThrow({ where: { conversationId: done.id } });
    expect(note.body).toBe("Escolhas no fluxo: Pelo WhatsApp › Guias ou Ortopédicos › Guias › Exames de Laboratório › Campo Novo do Parecis › Lab. Alvim");
  });
});
