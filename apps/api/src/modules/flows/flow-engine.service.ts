import fs from "node:fs";
import path from "node:path";
import type { FlowNode, FlowEdge, Prisma } from "@prisma/client";
import {
  FLOW_ABANDON_AFTER_MINUTES_DEFAULT,
  FLOW_HOURS_CLOSED,
  FLOW_HOURS_OPEN,
  FLOW_MENU_DEFAULT_PROMPT,
  FLOW_MENU_NAV_OPTIONS,
  describeWorkScheduleDays,
  flowMenuNavOptions,
  flowNodeName,
  renderFlowMenuText,
  renderFlowText,
  type FlowBusinessHoursData,
  type FlowImage,
  type FlowMenuNavigation,
  type FlowMenuOption,
  type FlowStartData,
  type WorkScheduleDaysDTO,
} from "@whatsatendende/types";
import { env } from "../../config/env";
import { prisma } from "../../lib/prisma";
import { logger } from "../../lib/logger";
import { resolveLocalNow } from "../../lib/access-schedule";
import { realtimeEvents } from "../../realtime/realtime";
import { createNotification } from "../notifications/notifications.service";
import { toNotificationDTO } from "../notifications/notifications.mapper";
import { addAttachment } from "../messages/messages.service";
import * as whatsappService from "../whatsapp/whatsapp.service";
import { getConnectionSchedule, isWorkScheduleOpen } from "../work-schedules/work-schedules.service";

/**
 * Fluxo execution engine. A new conversation on a connection with an active
 * flow opens in IN_FLOW (see findOrOpenConversationForInboundMessage) and
 * every customer message while it stays there comes through here, until a
 * TRANSFER_TO_AGENT hands it to people or an END closes it.
 * Nothing runs unless an admin switched a flow on for that connection.
 *
 * A transfer step with people chosen gives the conversation to the least busy of them who is online — whatever
 * connection they normally attend; the customer keeps talking to the number they wrote to. With none of them online
 * it goes to Abandonados for anyone online among the flow's people, and with nobody online at all it waits on the
 * step (see dispatchWaitingTransfers). A menu left unanswered past the Início's limit also ends in Abandonados.
 */

// Wrong answers to the same menu before giving up and handing the customer to a person.
const MAX_INVALID_MENU_ANSWERS = 3;
// Guards against a graph that loops back on itself without a menu in between.
const MAX_STEPS_PER_RUN = 50;
// What WhatsApp shows as a picture's caption; a longer text goes in its own message after the picture.
const MAX_IMAGE_CAPTION = 1024;
// The API Oficial sends up to this many options as WhatsApp's own buttons or list; more go as numbered text.
const MAX_INTERACTIVE_OPTIONS = 10;
const WEEKDAYS = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"];

/** The out-of-hours question the flow asks before its first step (see FlowStartData.outOfHoursPrompt). */
const HOURS_PROMPT_NODE = "__out_of_hours__";
const HOURS_PROMPT_OPTIONS: FlowMenuOption[] = [
  { id: "hours-continue", label: "Sim, continuar" },
  { id: "hours-stop", label: "Não, obrigado(a)" },
];
const GOODBYE_TEXT = "Tudo bem! Ficamos à disposição sempre que precisar. Até logo! 👋";
const ABANDONED_NOTICE = "Como não recebemos sua resposta, um de nossos atendentes vai falar com você em breve.";
const OFFICIAL_MENU_DEFAULT_PROMPT = "Escolha uma opção:";

type Graph = { nodes: Map<string, FlowNode>; edges: FlowEdge[] };

/** What the session remembers: the option picked last ({{opcao}}), every option picked so far and the menus on the way (for Voltar / Menu inicial). */
type FlowVars = { opcao?: string; path?: string[]; menus?: string[] };

type FlowConversation = {
  id: string;
  whatsappConnectionId: string;
  contactId: string;
  contactName: string;
  contactPhone: string;
};

type MenuData = { prompt?: string; options: FlowMenuOption[]; image?: FlowImage | null; name?: string; navigation?: FlowMenuNavigation };

// What a customer may type for a navigation option besides its number or its label.
const NAV_WORDS: Record<string, string> = {
  voltar: FLOW_MENU_NAV_OPTIONS.back.id,
  menu: FLOW_MENU_NAV_OPTIONS.home.id,
  inicio: FLOW_MENU_NAV_OPTIONS.home.id,
  encerrar: FLOW_MENU_NAV_OPTIONS.end.id,
  sair: FLOW_MENU_NAV_OPTIONS.end.id,
};
type TransferData = { assignedAgentIds?: string[]; mode?: "any" | "selected"; name?: string };

/** Why a conversation is in Abandonados — kept on its FLOW_ABANDONED event, turned into a note when someone accepts it. */
type AbandonedPayload = { reason: "TIMEOUT"; minutes: number; stoppedAt: string } | { reason: "NO_AGENT_ONLINE"; stepName: string };

async function loadGraph(flowId: string): Promise<Graph> {
  const [nodes, edges] = await Promise.all([prisma.flowNode.findMany({ where: { flowId } }), prisma.flowEdge.findMany({ where: { flowId } })]);
  return { nodes: new Map(nodes.map((n) => [n.id, n])), edges };
}

function nextNodeId(graph: Graph, nodeId: string, handle: string | null): string | null {
  return graph.edges.find((e) => e.sourceNodeId === nodeId && (e.sourceHandle ?? null) === handle)?.targetNodeId ?? null;
}

function startOf(graph: Graph): FlowNode | undefined {
  return [...graph.nodes.values()].find((n) => n.type === "START");
}

function startSettings(graph: Graph): FlowStartData {
  return (startOf(graph)?.data ?? {}) as FlowStartData;
}

function render(text: string, conversation: FlowConversation, vars: FlowVars): string {
  return renderFlowText(text, { cliente: conversation.contactName, opcao: vars.opcao });
}

function normalize(text: string): string {
  return text.normalize("NFD").replace(/[̀-ͯ]/g, "").trim().toLowerCase();
}

/** "2", "2.", "opção 2" or the option's own name all pick the second option. A tapped button/list row comes with its id. */
export function matchMenuOption(options: FlowMenuOption[], answer: string | null, selectedOptionId: string | null = null): FlowMenuOption | null {
  if (selectedOptionId) {
    const tapped = options.find((o) => o.id === selectedOptionId);
    if (tapped) return tapped;
  }
  if (!answer) return null;
  const number = /^\D*(\d{1,2})\D*$/.exec(answer.trim());
  if (number) return options[Number(number[1]) - 1] ?? null;
  const wanted = normalize(answer);
  return options.find((o) => normalize(o.label) === wanted) ?? null;
}

export function isWithinBusinessHours(data: Required<Omit<FlowBusinessHoursData, "workScheduleId">>, now: Date): boolean {
  const local = resolveLocalNow(now, data.tzOffsetMinutes);
  if (!data.days.includes(WEEKDAYS.indexOf(local.weekday))) return false;
  const [sh, sm] = data.start.split(":").map(Number);
  const [eh, em] = data.end.split(":").map(Number);
  return local.minutesOfDay >= sh * 60 + sm && local.minutesOfDay < eh * 60 + em;
}

/**
 * The hours node's verdict. A connection that follows a Horário de expediente decides on its own (it sends the out-of-hours notice and never
 * starts the flow while closed), so the node stays "open" there. Otherwise the node's chosen schedule applies; a node with none chosen is
 * always open — except a node saved before schedules existed, which keeps its own days and hours.
 */
async function isNodeOpen(conversation: FlowConversation, data: Partial<FlowBusinessHoursData> & { workScheduleId?: string | null }, now: Date): Promise<boolean> {
  if (await getConnectionSchedule("WHATSAPP", conversation.whatsappConnectionId)) return true;
  if (data.workScheduleId) {
    const schedule = await prisma.workSchedule.findUnique({ where: { id: data.workScheduleId } });
    return schedule ? isWorkScheduleOpen(schedule, now) : true;
  }
  return data.days && data.start && data.end && data.tzOffsetMinutes !== undefined ? isWithinBusinessHours({ days: data.days, start: data.start, end: data.end, tzOffsetMinutes: data.tzOffsetMinutes }, now) : true;
}

async function recordBotMessage(conversation: FlowConversation, type: "TEXT" | "IMAGE", body: string | null) {
  const message = await prisma.message.create({
    data: { conversationId: conversation.id, direction: "OUTBOUND", type, status: "PENDING", body, automatedBy: "FLOW" },
  });
  await prisma.conversation.update({ where: { id: conversation.id }, data: { lastMessageAt: new Date(), lastMessageDirection: "OUTBOUND" } });
  return message;
}

async function sendBotText(conversation: FlowConversation, text: string): Promise<void> {
  const message = await recordBotMessage(conversation, "TEXT", text);
  await whatsappService.sendAutomatedText(conversation.whatsappConnectionId, message.id, conversation.contactPhone, text);
  realtimeEvents.newMessage(conversation.id, null);
}

/** The step's photo — null (and the step goes on without it) when its file is missing from the uploads. */
function readImage(image: FlowImage | null | undefined): { image: FlowImage; buffer: Buffer } | null {
  if (!image?.storageKey) return null;
  const filePath = path.join(env.UPLOAD_DIR, image.storageKey);
  if (!fs.existsSync(filePath)) {
    logger.warn({ storageKey: image.storageKey }, "a flow step's photo is missing from the uploads — sending the text only");
    return null;
  }
  return { image, buffer: fs.readFileSync(filePath) };
}

async function attachPhoto(messageId: string, photo: { image: FlowImage }) {
  await addAttachment(messageId, { fileName: photo.image.fileName, mimeType: photo.image.mimeType, sizeBytes: photo.image.sizeBytes, storageKey: photo.image.storageKey, kind: "IMAGE" });
}

async function sendBotImage(conversation: FlowConversation, photo: { image: FlowImage; buffer: Buffer }, caption: string | null): Promise<void> {
  const message = await recordBotMessage(conversation, "IMAGE", caption);
  await attachPhoto(message.id, photo);
  await whatsappService.sendOutboundFile(conversation.whatsappConnectionId, message.id, conversation.contactPhone, photo.buffer, photo.image.fileName, photo.image.mimeType, null, caption ?? undefined);
  realtimeEvents.newMessage(conversation.id, null);
}

/** A text with the step's photo: one message (the text as its caption) when it fits, else the photo then the text. */
async function sendBotStep(conversation: FlowConversation, text: string, image: FlowImage | null | undefined): Promise<void> {
  const photo = readImage(image);
  if (!photo) return sendBotText(conversation, text);
  if (text.length <= MAX_IMAGE_CAPTION) return sendBotImage(conversation, photo, text);
  await sendBotImage(conversation, photo, null);
  await sendBotText(conversation, text);
}

/**
 * A menu: on the API Oficial, WhatsApp's own buttons (up to 3, with the photo) or a list (up to 10); on QR Code — or
 * with more options — the numbered text. The conversation keeps the numbered text, so the team reads the options.
 */
async function sendBotMenu(conversation: FlowConversation, data: MenuData, vars: FlowVars, listTitle: string | null, nav: FlowMenuOption[] = []): Promise<void> {
  const options = data.options ?? [];
  const official = whatsappService.isOfficialConnection(conversation.whatsappConnectionId);
  if (!official || options.length === 0 || options.length > MAX_INTERACTIVE_OPTIONS) {
    return sendBotStep(conversation, render(renderFlowMenuText({ ...data, options: [...options, ...nav] }), conversation, vars), data.image);
  }
  const prompt = data.prompt?.trim() || OFFICIAL_MENU_DEFAULT_PROMPT;
  const photo = readImage(data.image);
  const message = await recordBotMessage(conversation, photo ? "IMAGE" : "TEXT", render(renderFlowMenuText({ ...data, prompt }), conversation, vars));
  if (photo) await attachPhoto(message.id, photo);
  await whatsappService.sendAutomatedMenu(conversation.whatsappConnectionId, message.id, conversation.contactPhone, {
    body: render(prompt, conversation, vars),
    options,
    image: photo ? { buffer: photo.buffer, fileName: photo.image.fileName, mimeType: photo.image.mimeType } : undefined,
    listTitle: listTitle ?? undefined,
  });
  realtimeEvents.newMessage(conversation.id, null);
}

async function completeSession(sessionId: string): Promise<void> {
  await prisma.flowSession.update({ where: { id: sessionId }, data: { completedAt: new Date(), currentNodeId: null } });
}

function varsOf(value: Prisma.JsonValue | null | undefined): FlowVars {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as FlowVars) : {};
}

/** A note by the system on the conversation, for whoever attends it. */
async function addSystemNote(conversationId: string, body: string): Promise<void> {
  await prisma.conversationNote.create({ data: { conversationId, authorId: null, body } });
}

/** What the customer picked on the way, for the person who takes it over. */
async function notePath(conversation: FlowConversation, vars: FlowVars): Promise<void> {
  if (vars.path?.length) await addSystemNote(conversation.id, `Escolhas no fluxo: ${vars.path.join(" › ")}`);
}

/** Ends the flow by putting the conversation in the queue, exactly like a normal new conversation. */
async function handToQueue(conversation: FlowConversation, sessionId: string | null, reason: string, vars: FlowVars = {}): Promise<void> {
  await prisma.conversation.update({ where: { id: conversation.id }, data: { status: "NEW", enteredQueueAt: new Date() } });
  await prisma.conversationEvent.create({ data: { conversationId: conversation.id, type: "FLOW_TO_QUEUE", payload: { reason } } });
  if (sessionId) await completeSession(sessionId);
  await notePath(conversation, vars);
  realtimeEvents.newQueueConversation(conversation.whatsappConnectionId, conversation.id, conversation.contactName);
}

/** Into Abandonados — whoever is online among the flow's people accepts it (see listAbandoned). */
async function handToAbandoned(conversation: FlowConversation, sessionId: string, payload: AbandonedPayload, vars: FlowVars): Promise<void> {
  await prisma.conversation.update({ where: { id: conversation.id }, data: { status: "FLOW_ABANDONED", enteredQueueAt: new Date() } });
  await prisma.conversationEvent.create({ data: { conversationId: conversation.id, type: "FLOW_ABANDONED", payload } });
  await completeSession(sessionId);
  await notePath(conversation, vars);
  realtimeEvents.abandonedChanged();
}

/** Everyone chosen on any transfer step of the flow — they attend its conversations from any connection. */
async function flowStepPeople(flowId: string): Promise<string[]> {
  const steps = await prisma.flowNode.findMany({ where: { flowId, type: "TRANSFER_TO_AGENT" }, select: { data: true } });
  return [...new Set(steps.flatMap((s) => ((s.data ?? {}) as TransferData).assignedAgentIds ?? []))];
}

/** Whether anyone who can take this conversation from Abandonados is online: the entry connection's attendants or the flow's people. */
async function anyoneOnlineFor(conversation: FlowConversation, flowId: string): Promise<boolean> {
  const people = await flowStepPeople(flowId);
  const count = await prisma.user.count({
    where: { status: "ACTIVE", presence: "ONLINE", OR: [{ whatsappConnectionId: conversation.whatsappConnectionId }, { id: { in: people } }] },
  });
  return count > 0;
}

/** Gives the conversation straight to the least busy of these people who is online — false when none of them is. */
async function assignToLeastBusyOnline(conversation: FlowConversation, sessionId: string, candidateIds: string[], vars: FlowVars): Promise<boolean> {
  if (candidateIds.length === 0) return false;
  const online = await prisma.user.findMany({
    where: { id: { in: candidateIds }, status: "ACTIVE", presence: "ONLINE" },
    select: { id: true, _count: { select: { assignedConversations: { where: { status: { in: ["IN_PROGRESS", "TRANSFERRED"] } } } } } },
  });
  const agent = online.sort((a, b) => a._count.assignedConversations - b._count.assignedConversations)[0];
  if (!agent) return false;
  const now = new Date();
  const claimed = await prisma.conversation.updateMany({
    where: { id: conversation.id, status: "IN_FLOW" },
    data: { status: "IN_PROGRESS", assignedAgentId: agent.id, enteredQueueAt: now, acceptedAt: now, firstResponseAt: null, assignedAgentReadAt: null },
  });
  if (claimed.count === 0) return true; // someone else took it meanwhile (Gestão, the phone…) — nothing left to do here
  await prisma.$transaction([
    prisma.conversationAssignment.create({ data: { conversationId: conversation.id, toAgentId: agent.id, reason: "FLOW" } }),
    prisma.conversationEvent.create({ data: { conversationId: conversation.id, type: "FLOW_ASSIGNED", payload: { toAgentId: agent.id } } }),
  ]);
  await completeSession(sessionId);
  await notePath(conversation, vars);
  realtimeEvents.conversationAccepted(conversation.id, conversation.whatsappConnectionId, agent.id);
  const notification = await createNotification({
    userId: agent.id,
    type: "MESSAGE",
    title: conversation.contactName,
    body: "Nova conversa encaminhada pelo fluxo",
    entityType: "Conversation",
    entityId: conversation.id,
  });
  realtimeEvents.notificationCreated(agent.id, toNotificationDTO(notification));
  return true;
}

function stepName(node: FlowNode): string {
  return flowNodeName(node) ?? "Transferir para atendente";
}

/**
 * TRANSFER_TO_AGENT. No people chosen: the entry connection's queue. People chosen: the least busy of them online;
 * none of them online: Abandonados, if anyone who can take it is online; nobody online at all: it waits on this step.
 */
async function transfer(conversation: FlowConversation, sessionId: string, flowId: string, node: FlowNode, vars: FlowVars): Promise<void> {
  const data = (node.data ?? {}) as TransferData;
  const people = data.mode === "selected" ? (data.assignedAgentIds ?? []) : [];
  if (people.length === 0) return handToQueue(conversation, sessionId, "TRANSFER", vars);
  if (await assignToLeastBusyOnline(conversation, sessionId, people, vars)) return;
  if (await anyoneOnlineFor(conversation, flowId)) return handToAbandoned(conversation, sessionId, { reason: "NO_AGENT_ONLINE", stepName: stepName(node) }, vars);
  await prisma.flowSession.update({ where: { id: sessionId }, data: { currentNodeId: node.id, lastActivityAt: new Date() } });
}

async function closeByFlow(conversation: FlowConversation, sessionId: string, byCustomer = false): Promise<void> {
  await prisma.conversation.update({ where: { id: conversation.id }, data: { status: "CLOSED", closedAt: new Date() } });
  await prisma.conversationEvent.create({ data: { conversationId: conversation.id, type: "CLOSED", payload: { byFlow: true, ...(byCustomer ? { byCustomer: true } : {}) } } });
  await completeSession(sessionId);
  realtimeEvents.newMessage(conversation.id, null);
}

/** Walks the graph from `nodeId` until it reaches a menu (waits for the customer) or the flow ends. */
async function advance(conversation: FlowConversation, sessionId: string, flowId: string, graph: Graph, startNodeId: string | null, vars: FlowVars): Promise<void> {
  let nodeId = startNodeId;
  for (let step = 0; nodeId && step < MAX_STEPS_PER_RUN; step++) {
    const node = graph.nodes.get(nodeId);
    if (!node) break;
    const data = (node.data ?? {}) as Record<string, unknown>;
    switch (node.type) {
      case "START":
        nodeId = nextNodeId(graph, node.id, null);
        break;
      case "TEXT_MESSAGE":
        await sendBotStep(conversation, render(String(data.text ?? ""), conversation, vars), data.image as FlowImage | null | undefined);
        nodeId = nextNodeId(graph, node.id, null);
        break;
      case "BUSINESS_HOURS":
        nodeId = nextNodeId(graph, node.id, (await isNodeOpen(conversation, data, new Date())) ? FLOW_HOURS_OPEN : FLOW_HOURS_CLOSED);
        break;
      case "MENU": {
        const menus = vars.menus ?? [];
        const here: FlowVars = { ...vars, menus: menus.at(-1) === node.id ? menus : [...menus, node.id] };
        await sendBotMenu(conversation, data as unknown as MenuData, here, flowNodeName(node), navOptionsFor(conversation, data as unknown as MenuData, here));
        await prisma.flowSession.update({ where: { id: sessionId }, data: { currentNodeId: node.id, invalidAttempts: 0, lastActivityAt: new Date(), variables: here } });
        return;
      }
      case "TRANSFER_TO_AGENT":
        await transfer(conversation, sessionId, flowId, node, vars);
        return;
      case "END":
        await closeByFlow(conversation, sessionId);
        return;
    }
  }
  // A path that just stops (or a broken/looping graph) never strands the customer.
  await handToQueue(conversation, sessionId, "DEAD_END", vars);
}

/** Outside the entry connection's hours: the hours it attends, and whether the customer wants to go on anyway. */
async function outOfHoursPrompt(conversation: FlowConversation): Promise<MenuData | null> {
  const schedule = await getConnectionSchedule("WHATSAPP", conversation.whatsappConnectionId);
  if (!schedule || (await isWorkScheduleOpen(schedule))) return null;
  const hours = describeWorkScheduleDays(schedule.days as WorkScheduleDaysDTO);
  const official = whatsappService.isOfficialConnection(conversation.whatsappConnectionId);
  const prompt = [
    "No momento estamos fora do nosso horário de atendimento.",
    ...(hours ? [`🕐 Atendemos: ${hours}`] : []),
    "",
    "Deseja continuar mesmo assim? Assim que estivermos no horário, um atendente dará sequência à sua solicitação.",
    ...(official ? [] : ["", "Responda com o número da opção 👇"]),
  ].join("\n");
  return { prompt, options: HOURS_PROMPT_OPTIONS };
}

/** Voltar / Menu inicial / Encerrar atendimento after a menu's own options — QR Code only (the API Oficial keeps its buttons). */
function navOptionsFor(conversation: FlowConversation, menu: MenuData, vars: FlowVars): FlowMenuOption[] {
  if (whatsappService.isOfficialConnection(conversation.whatsappConnectionId)) return [];
  return flowMenuNavOptions(menu.navigation, (vars.menus?.length ?? 0) > 1);
}

/** Voltar: the menu before this one. Menu inicial: the first menu. Encerrar atendimento: closes, with no survey. */
async function navigate(conversation: FlowConversation, sessionId: string, flowId: string, graph: Graph, optionId: string, vars: FlowVars): Promise<void> {
  if (optionId === FLOW_MENU_NAV_OPTIONS.end.id) {
    await sendBotText(conversation, GOODBYE_TEXT);
    await addSystemNote(conversation.id, "O cliente encerrou o atendimento pelo menu do fluxo.");
    return closeByFlow(conversation, sessionId, true);
  }
  const menus = vars.menus ?? [];
  const path = vars.path ?? [];
  // advance() puts the menu it reaches back on the list.
  const back = optionId === FLOW_MENU_NAV_OPTIONS.back.id;
  const target = back ? menus.at(-2) : menus[0];
  const next: FlowVars = back ? { path: path.slice(0, -1), menus: menus.slice(0, -2) } : { path: [], menus: [] };
  await prisma.flowSession.update({ where: { id: sessionId }, data: { variables: next } });
  return advance(conversation, sessionId, flowId, graph, target ?? null, next);
}

/** An answer that matches no option: the menu again, until the third miss hands the customer to the queue. */
async function retryMenu(conversation: FlowConversation, sessionId: string, invalidAttempts: number, menu: MenuData, vars: FlowVars, listTitle: string | null, nav: FlowMenuOption[] = []) {
  const attempts = invalidAttempts + 1;
  if (attempts >= MAX_INVALID_MENU_ANSWERS) {
    await sendBotText(conversation, "Não consegui entender sua resposta. Vou encaminhar você para um atendente.");
    return handToQueue(conversation, sessionId, "INVALID_ANSWERS", vars);
  }
  await prisma.flowSession.update({ where: { id: sessionId }, data: { invalidAttempts: attempts } });
  await sendBotMenu(conversation, { ...menu, prompt: `Não entendi. ${menu.prompt?.trim() || FLOW_MENU_DEFAULT_PROMPT}` }, vars, listTitle, nav);
}

async function loadFlowConversation(conversationId: string): Promise<FlowConversation | null> {
  const row = await prisma.conversation.findUnique({
    where: { id: conversationId },
    select: { id: true, status: true, whatsappConnectionId: true, contactId: true, contact: { select: { name: true, phone: true } } },
  });
  if (!row || row.status !== "IN_FLOW" || !row.whatsappConnectionId || !row.contact.phone) return null;
  return {
    id: row.id,
    whatsappConnectionId: row.whatsappConnectionId,
    contactId: row.contactId,
    contactName: row.contact.name ?? row.contact.phone,
    contactPhone: row.contact.phone,
  };
}

async function run(conversationId: string, flowId: string | null, answer: string | null, selectedOptionId: string | null): Promise<void> {
  const conversation = await loadFlowConversation(conversationId);
  if (!conversation) return;

  const session = await prisma.flowSession.findUnique({ where: { conversationId } });
  if (!session) {
    if (!flowId) return handToQueue(conversation, null, "NO_SESSION");
    const created = await prisma.flowSession.create({ data: { flowId, contactId: conversation.contactId, conversationId } });
    const graph = await loadGraph(flowId);
    const start = startOf(graph);
    const hoursPrompt = startSettings(graph).outOfHoursPrompt ? await outOfHoursPrompt(conversation) : null;
    if (hoursPrompt) {
      await sendBotMenu(conversation, hoursPrompt, {}, null);
      await prisma.flowSession.update({ where: { id: created.id }, data: { currentNodeId: HOURS_PROMPT_NODE, lastActivityAt: new Date() } });
      return;
    }
    return advance(conversation, created.id, flowId, graph, start ? nextNodeId(graph, start.id, null) : null, {});
  }

  const graph = await loadGraph(session.flowId);
  const vars = varsOf(session.variables);
  const current = session.currentNodeId && session.currentNodeId !== HOURS_PROMPT_NODE ? graph.nodes.get(session.currentNodeId) : undefined;
  // Waiting on a transfer step for someone to come online — the message is kept for whoever takes it.
  if (current?.type === "TRANSFER_TO_AGENT") return;
  await prisma.flowSession.update({ where: { id: session.id }, data: { lastActivityAt: new Date() } });

  if (session.currentNodeId === HOURS_PROMPT_NODE) {
    const option = matchMenuOption(HOURS_PROMPT_OPTIONS, answer, selectedOptionId);
    if (option?.id === "hours-continue") {
      const start = startOf(graph);
      return advance(conversation, session.id, session.flowId, graph, start ? nextNodeId(graph, start.id, null) : null, vars);
    }
    if (option?.id === "hours-stop") {
      await sendBotText(conversation, GOODBYE_TEXT);
      return closeByFlow(conversation, session.id);
    }
    return retryMenu(conversation, session.id, session.invalidAttempts, (await outOfHoursPrompt(conversation)) ?? { options: HOURS_PROMPT_OPTIONS }, vars, null);
  }

  // The flow was re-saved/deleted while this customer was mid-menu — hand them to a person.
  if (!current || current.type !== "MENU") return handToQueue(conversation, session.id, "STALE_SESSION", vars);

  const menuData = (current.data ?? {}) as unknown as MenuData;
  const nav = navOptionsFor(conversation, menuData, vars);
  const navWord = nav.find((o) => o.id === NAV_WORDS[normalize(answer ?? "")]);
  const option = matchMenuOption([...(menuData.options ?? []), ...nav], answer, selectedOptionId) ?? navWord ?? null;
  if (option && nav.includes(option)) return navigate(conversation, session.id, session.flowId, graph, option.id, vars);
  if (option) {
    const next: FlowVars = { opcao: option.label, path: [...(vars.path ?? []), option.label], menus: vars.menus };
    await prisma.flowSession.update({ where: { id: session.id }, data: { variables: next } });
    return advance(conversation, session.id, session.flowId, graph, nextNodeId(graph, current.id, option.id), next);
  }
  return retryMenu(conversation, session.id, session.invalidAttempts, menuData, vars, flowNodeName(current), nav);
}

// Two messages from the same customer arriving together must not run the flow twice in parallel.
const queues = new Map<string, Promise<void>>();

function enqueue(conversationId: string, task: () => Promise<void>): Promise<void> {
  const previous = queues.get(conversationId) ?? Promise.resolve();
  const next = previous.then(task).catch((err) => logger.error({ err, conversationId }, "flow engine failed"));
  queues.set(conversationId, next);
  void next.finally(() => {
    if (queues.get(conversationId) === next) queues.delete(conversationId);
  });
  return next;
}

/**
 * Entry point from the inbound-message handler for a conversation in IN_FLOW. `flowId` is set only for the message that opened it;
 * `selectedOptionId` is the button/list row tapped on the API Oficial.
 */
export function handleInboundForFlow(conversationId: string, flowId: string | null, answer: string | null, selectedOptionId: string | null = null): Promise<void> {
  return enqueue(conversationId, () => run(conversationId, flowId, answer, selectedOptionId));
}

/** Called when a person takes a conversation out of IN_FLOW (Gestão, the phone...) so its session doesn't linger. */
export async function endFlowSession(conversationId: string): Promise<void> {
  await prisma.flowSession.updateMany({ where: { conversationId, completedAt: null }, data: { completedAt: new Date(), currentNodeId: null } });
}

/** The labels picked so far, then the menu where the customer stopped — "Guias › Exames de Laboratório". */
function stoppedAt(vars: FlowVars, node: FlowNode | undefined): string {
  const parts = [...(vars.path ?? [])];
  const name = node ? flowNodeName(node) : "Horário de atendimento";
  if (name && parts[parts.length - 1] !== name) parts.push(name);
  return parts.length ? parts.join(" › ") : "primeiro menu";
}

/** Every menu left unanswered past its flow's limit (Início › minutos sem resposta): the customer is told, and it goes to Abandonados. */
export async function abandonIdleFlowSessions(now = new Date()): Promise<void> {
  const sessions = await prisma.flowSession.findMany({
    where: { completedAt: null, currentNodeId: { not: null }, lastActivityAt: { lt: new Date(now.getTime() - 60_000) }, conversation: { status: "IN_FLOW" } },
    select: { id: true, flowId: true, conversationId: true, currentNodeId: true, lastActivityAt: true, variables: true },
    take: 100,
  });
  const graphs = new Map<string, Graph>();
  for (const session of sessions) {
    if (!session.conversationId || !session.currentNodeId) continue;
    const graph = graphs.get(session.flowId) ?? (await loadGraph(session.flowId));
    graphs.set(session.flowId, graph);
    const node = session.currentNodeId === HOURS_PROMPT_NODE ? undefined : graph.nodes.get(session.currentNodeId);
    // A transfer step waits for people, not for the customer.
    if (session.currentNodeId !== HOURS_PROMPT_NODE && node?.type !== "MENU") continue;
    const minutes = startSettings(graph).abandonAfterMinutes ?? FLOW_ABANDON_AFTER_MINUTES_DEFAULT;
    if (now.getTime() - session.lastActivityAt.getTime() < minutes * 60_000) continue;
    const conversationId = session.conversationId;
    await enqueue(conversationId, async () => {
      const conversation = await loadFlowConversation(conversationId);
      const fresh = await prisma.flowSession.findUnique({ where: { id: session.id }, select: { completedAt: true, lastActivityAt: true } });
      // The customer answered (or a person took it) while this was waiting its turn.
      if (!conversation || !fresh || fresh.completedAt || fresh.lastActivityAt.getTime() !== session.lastActivityAt.getTime()) return;
      const vars = varsOf(session.variables);
      await sendBotText(conversation, ABANDONED_NOTICE);
      await handToAbandoned(conversation, session.id, { reason: "TIMEOUT", minutes, stoppedAt: stoppedAt(vars, node) }, vars);
    });
  }
}

/**
 * Conversations waiting on a transfer step because nobody was online: the first of the step's people to come online
 * gets it; anyone else who can take it coming online first sends it to Abandonados.
 */
export async function dispatchWaitingTransfers(): Promise<void> {
  const sessions = await prisma.flowSession.findMany({
    where: { completedAt: null, currentNodeId: { not: null }, conversation: { status: "IN_FLOW" } },
    select: { id: true, flowId: true, conversationId: true, currentNodeId: true, variables: true },
    take: 200,
  });
  for (const session of sessions) {
    if (!session.conversationId || !session.currentNodeId || session.currentNodeId === HOURS_PROMPT_NODE) continue;
    const node = await prisma.flowNode.findUnique({ where: { id: session.currentNodeId } });
    if (node?.type !== "TRANSFER_TO_AGENT") continue;
    const conversationId = session.conversationId;
    await enqueue(conversationId, async () => {
      const conversation = await loadFlowConversation(conversationId);
      const fresh = await prisma.flowSession.findUnique({ where: { id: session.id }, select: { completedAt: true, currentNodeId: true } });
      if (!conversation || !fresh || fresh.completedAt || fresh.currentNodeId !== node.id) return;
      const vars = varsOf(session.variables);
      const people = ((node.data ?? {}) as TransferData).assignedAgentIds ?? [];
      if (await assignToLeastBusyOnline(conversation, session.id, people, vars)) return;
      if (await anyoneOnlineFor(conversation, session.flowId)) await handToAbandoned(conversation, session.id, { reason: "NO_AGENT_ONLINE", stepName: stepName(node) }, vars);
    });
  }
}

/** The flows whose transfer steps include this person — they see those flows' Abandonados besides their own connection's. */
export async function flowIdsWithPerson(userId: string): Promise<string[]> {
  const steps = await prisma.flowNode.findMany({ where: { type: "TRANSFER_TO_AGENT" }, select: { flowId: true, data: true } });
  return [...new Set(steps.filter((s) => (((s.data ?? {}) as TransferData).assignedAgentIds ?? []).includes(userId)).map((s) => s.flowId))];
}

/** Accepting from Abandonados: the system tells the attendant why it was there. */
export async function noteAbandonedReason(conversationId: string): Promise<void> {
  const event = await prisma.conversationEvent.findFirst({ where: { conversationId, type: "FLOW_ABANDONED" }, orderBy: { createdAt: "desc" } });
  const payload = event?.payload as AbandonedPayload | null | undefined;
  if (!payload) return;
  await addSystemNote(
    conversationId,
    payload.reason === "TIMEOUT"
      ? `O cliente parou de responder os menus por mais de ${payload.minutes} minutos (parou em: ${payload.stoppedAt}).`
      : `Nenhum atendente do passo ${payload.stepName} estava online quando o cliente chegou.`
  );
}
