import type { AiSession, Prisma } from "@prisma/client";
import {
  AI_ASSISTANT_AUTOMATED_BY,
  aiAssistantReply,
  type AiAssistantClientDataDTO,
  type AiAssistantSettingsDTO,
  type AiAssistantSimulationDTO,
  type AiAssistantSimulationStepDTO,
  type AiAssistantSimulationWhen,
  type ClientContractDTO,
} from "@whatsatendende/types";
import { prisma } from "../../lib/prisma";
import { logger } from "../../lib/logger";
import { writeAudit } from "../../lib/audit";
import { blockingTag, isBlocked } from "../../lib/auto-messages";
import { phoneKey } from "../../lib/phone-key";
import { fillSendTags } from "../../lib/customer-tags";
import { realtimeEvents } from "../../realtime/realtime";
import { createNotification } from "../notifications/notifications.service";
import { toNotificationDTO } from "../notifications/notifications.mapper";
import { addAttachment } from "../messages/messages.service";
import * as whatsappService from "../whatsapp/whatsapp.service";
import { getClosedMessageForConnection, getConnectionSchedule, isWorkScheduleOpen } from "../work-schedules/work-schedules.service";
import { clientRows, cpfKeyOf, dataAccessFor, getClientData, localDateTime, usableSource, type ColumnMap, type Row } from "../data-sources/data-sources.service";
import { prepareBoletos, previewBoletos } from "../boletos/boletos.service";
import { assistantAnswers, getAiAssistantSettings, getAssistantUser } from "./ai-assistant.service";
import { scheduleCloseFollowUp, type HeldClosingMessage } from "../satisfaction/satisfaction.service";
import { getActiveClosingMessageForAgent } from "../closing-messages/closing-messages.service";
import { renderAutoMessageTemplate } from "../auto-message-templates/auto-message-templates.service";
import { copyReplyMediaFile } from "../../lib/reply-media";
import { classifyIntent, transcribeAudio } from "./ai-llm";
import { firstNameFor, greetingOfTheDay, phrase, typingDelayMs } from "./ai-phrases";
import { env } from "../../config/env";
import {
  addressesMatch,
  correctionTarget,
  extractCpf,
  formatBrl,
  isNo,
  isSameAnswer,
  isYes,
  looksLikeDocumentAttempt,
  maskCpf,
  monthOf,
  namesMatch,
  parseChoice,
  ruleIntent,
  type Intent,
} from "./ai-text";

/**
 * Assistente Virtual — talks to the customer of a conversation in IN_AI ("Com a IA"), before the queue.
 *
 * "A IA entende, o sistema executa": the conversation is a fixed script in code (CPF, nome, endereço, débitos,
 * boleto); the local AI is only asked what the customer wants when the obvious words don't say it. Values, months,
 * linha digitável and the PDF come from the same code the attendants use — the AI never writes a number.
 *
 * Every reply starts with the assistant's name ("*Assistente Virtual:* ..."). Anything unexpected — the AI or the
 * transcription off, the data source unavailable, a boleto that can't be generated, an error — hands the conversation
 * to the queue with a note. It only ever speaks while the conversation is IN_AI: Gestão, the phone, a tag or switching
 * it off take the conversation away and it stops.
 */

const DEBOUNCE_MS = 4_000;
const IDLE_MINUTES = 30;
const MAX_CPF_ATTEMPTS = 3;
const MAX_NAME_ATTEMPTS = 2;
const MAX_UNCLEAR = 2;
const MAX_PARCELS_LISTED = 12;
// CPFs that didn't match (not found, or the name didn't match) from one phone in 24 hours, across conversations.
const MAX_AUDIO_FAILS = 2;
/**
 * Outside working hours and on holidays the spreadsheet usually isn't updated: the assistant still uses data this many
 * hours past the source's own deadline (the boleto goes with "se já pagou, desconsidere"). In working hours, never.
 */
export const STALE_TOLERANCE_HOURS_CLOSED = 72;
const MAX_FAILED_CPF_PER_DAY = 5;

/** "Boa tarde, Maria! Sou o assistente virtual…": the greeting of the settings, with the time of day and the name. */
function openingOf(conv: Conv, greeting: string): string {
  const rest = greeting.trim().replace(/^(ol[aá]|oi|bom dia|boa tarde|boa noite)\s*[!,.]?\s*/i, "");
  const name = nameOf(conv);
  return `${greetingOfTheDay(new Date(), env.BUSINESS_TZ_OFFSET_MINUTES)}${name ? `, ${name}` : ""}! ${rest}`.trim();
}

async function recordFailedCpfCheck(conv: Conv, reason: "NOT_FOUND" | "NAME_MISMATCH"): Promise<void> {
  await prisma.conversationEvent.create({ data: { conversationId: conv.id, type: "AI_CPF_FAILED", payload: { reason } } });
}

async function failedCpfChecksToday(conv: Conv): Promise<number> {
  return prisma.conversationEvent.count({
    where: { type: "AI_CPF_FAILED", createdAt: { gte: new Date(Date.now() - 24 * 3_600_000) }, conversation: { contactId: conv.contactId } },
  });
}

type State = "NEW" | "AWAIT_INTENT" | "AWAIT_CPF" | "AWAIT_NAME" | "AWAIT_ADDRESS" | "AWAIT_PARCEL" | "AWAIT_MORE" | "DONE";
type FinanceIntent = "BOLETO" | "DEBITOS";

interface ParcelOption {
  id: string;
  contract: string;
  label: string;
  /** This parcel and every older open one of its contract — a boleto never skips an older parcel. */
  ids: string[];
}

interface SessionData {
  intent?: FinanceIntent;
  cpfKey?: string;
  /** A CPF the customer sent before saying what they wanted — used as soon as they ask for the boleto/débitos. */
  pendingCpf?: string;
  /** The CPF offered as "o mesmo de antes" when asking for the CPF. */
  offerCpf?: string;
  /** The CPF just consulted had nothing open: the next answer may be another CPF (the titular's) or "não". */
  afterEmpty?: boolean;
  /** This phone isn't on the spreadsheet rows of the CPF confirmed — the record should get it. */
  phoneMissing?: boolean;
  cpfAttempts?: number;
  nameAttempts?: number;
  unclear?: number;
  informedName?: string;
  nameMatched?: boolean;
  informedAddress?: string;
  addressDiffers?: boolean | null;
  options?: ParcelOption[];
  /** Audios in a row that could not be transcribed: the first one asks the customer to write, the second goes to the team. */
  audioFails?: number;
  /** Hours past the data source's deadline accepted in this conversation (only outside working hours). */
  toleranceHours?: number;
  /** When the (older than its deadline) data used was last updated — "07/11 às 18:35". */
  staleSince?: string;
  /** What the customer wrote (or said), for the note. */
  said?: string[];
  summary?: string;
  /** What the assistant did, for the note: "Débitos informados", "Boleto enviado: …". */
  done?: string[];
}

interface Conv {
  id: string;
  connectionId: string;
  contactId: string;
  phone: string;
  contactName: string | null;
  firstName: string | null;
  dataCpfKey: string | null;
  dataClientKey: string | null;
}

// --- Sending ------------------------------------------------------------------------------------------------

/** Recorded as sent by the assistant's own attendant row, so it counts like an attendant's message (first response…). */
async function recordAiMessage(conversationId: string, type: "TEXT" | "DOCUMENT", body: string | null) {
  const assistant = await getAssistantUser();
  const message = await prisma.message.create({
    data: { conversationId, direction: "OUTBOUND", type, status: "PENDING", body, automatedBy: AI_ASSISTANT_AUTOMATED_BY, senderAgentId: assistant.id },
  });
  const now = new Date();
  await prisma.conversation.update({ where: { id: conversationId }, data: { lastMessageAt: now, lastMessageDirection: "OUTBOUND", awaitingReplySince: null } });
  await prisma.conversation.updateMany({ where: { id: conversationId, firstResponseAt: null, assignedAgentId: assistant.id }, data: { firstResponseAt: now } });
  return message;
}

/** The assistant takes the conversation as its attendant (Relatórios, Dashboard, pesquisa count it like anyone's). */
async function takeAsAttendant(conv: Conv): Promise<void> {
  const assistant = await getAssistantUser();
  const now = new Date();
  await prisma.conversation.updateMany({ where: { id: conv.id, status: "IN_AI" }, data: { assignedAgentId: assistant.id, acceptedAt: now, firstResponseAt: null } });
  await prisma.conversationAssignment.create({ data: { conversationId: conv.id, fromAgentId: null, toAgentId: assistant.id, reason: "AI_ASSISTANT" } });
}

/** Like a person: "digitando…" on the customer's WhatsApp for a moment before the reply (never in the tests). */
async function humanPause(conv: Conv, text: string): Promise<void> {
  if (env.NODE_ENV === "test") return;
  await whatsappService.sendAgentPresence(conv.id, "composing").catch(() => undefined);
  await new Promise((resolve) => setTimeout(resolve, typingDelayMs(text)));
}

/** The customer's first name for the replies, when it looks like a real name. */
function nameOf(conv: Conv): string | null {
  return firstNameFor({ firstName: conv.firstName, name: conv.contactName });
}

async function say(conv: Conv, settings: AiAssistantSettingsDTO, text: string): Promise<void> {
  await humanPause(conv, text);
  const body = aiAssistantReply(settings.name, text);
  const message = await recordAiMessage(conv.id, "TEXT", body);
  await whatsappService.sendAutomatedText(conv.connectionId, message.id, conv.phone, body);
  realtimeEvents.newMessage(conv.id, null);
}

/** A bare value to copy (linha digitável, PIX): no name in front, so the customer copies it straight into the bank app. */
async function sayRaw(conv: Conv, text: string): Promise<void> {
  const message = await recordAiMessage(conv.id, "TEXT", text);
  await whatsappService.sendAutomatedText(conv.connectionId, message.id, conv.phone, text);
  realtimeEvents.newMessage(conv.id, null);
}

// --- Session ----------------------------------------------------------------------------------------------

function dataOf(session: AiSession): SessionData {
  const value = session.data as Prisma.JsonValue;
  return value && typeof value === "object" && !Array.isArray(value) ? (value as SessionData) : {};
}

async function save(session: AiSession, state: State, data: SessionData): Promise<AiSession> {
  return prisma.aiSession.update({ where: { id: session.id }, data: { state, data: data as unknown as Prisma.InputJsonValue, lastActivityAt: new Date() } });
}

async function loadConv(conversationId: string): Promise<Conv | null> {
  const row = await prisma.conversation.findUnique({
    where: { id: conversationId },
    select: { id: true, status: true, whatsappConnectionId: true, contactId: true, dataCpfKey: true, dataClientKey: true, contact: { select: { name: true, phone: true, firstName: true } } },
  });
  if (!row || row.status !== "IN_AI" || !row.whatsappConnectionId || !row.contact.phone) return null;
  return {
    id: row.id,
    connectionId: row.whatsappConnectionId,
    contactId: row.contactId,
    phone: row.contact.phone,
    contactName: row.contact.name,
    firstName: row.contact.firstName,
    dataCpfKey: row.dataCpfKey,
    dataClientKey: row.dataClientKey,
  };
}

/** The note the team reads: what the customer told the assistant and what it did. */
function noteOf(data: SessionData, outcome: string): string {
  const lines = ["Assistente Virtual", `Resultado: ${outcome}`];
  if (data.intent) lines.push(`Pedido: ${data.intent === "BOLETO" ? "boleto" : "débitos em aberto"}`);
  if (data.summary) lines.push(`Resumo: ${data.summary}`);
  if (data.cpfKey) lines.push(`CPF/CNPJ informado: ${maskCpf(data.cpfKey)}`);
  if (data.informedName !== undefined) lines.push(`Nome informado: ${data.informedName}${data.nameMatched ? " (confere com o cadastro)" : " (não confere com o cadastro)"}`);
  if (data.informedAddress !== undefined) {
    const compared = data.addressDiffers === true ? " (diferente do cadastro — cadastro marcado como desatualizado)" : data.addressDiffers === false ? " (igual ao cadastro)" : "";
    lines.push(`Endereço informado: ${data.informedAddress}${compared}`);
  }
  if (data.phoneMissing) lines.push("Este telefone não está no cadastro do CPF confirmado (cadastro marcado para atualizar)");
  if (data.done?.length) lines.push(...data.done.map((d) => `• ${d}`));
  if (data.said?.length) lines.push(`Mensagens do cliente: ${data.said.slice(-6).map((s) => `"${s}"`).join(" · ")}`);
  return lines.join("\n");
}

async function end(session: AiSession, reason: string): Promise<void> {
  await prisma.aiSession.update({ where: { id: session.id }, data: { state: "DONE", endedAt: new Date(), endReason: reason } });
}

/**
 * To the queue, like a new conversation. Inside working hours the customer hears that someone will attend; outside, the
 * connection's out-of-hours notice — and from then on the assistant says nothing more (it only speaks in IN_AI).
 */
async function handToQueue(conv: Conv, session: AiSession, settings: AiAssistantSettingsDTO | null, data: SessionData, outcome: string, tellCustomer = true): Promise<void> {
  if (tellCustomer && settings) {
    const closed = await getClosedMessageForConnection("WHATSAPP", conv.connectionId).catch(() => null);
    const text = closed ? fillSendTags(closed, conv.contactName ?? conv.phone, conv.firstName) : settings.transferMessage;
    // Same tags as the team's messages: "Fora do expediente" or "Transferência" marked as not sent for this customer.
    const blocked = await isBlocked({ id: conv.id, contactId: conv.contactId }, closed ? "OUT_OF_HOURS" : "TRANSFER");
    if (text.trim() && !blocked) await say(conv, settings, text.trim()).catch((err) => logger.warn({ err }, "assistant could not send the transfer notice"));
  }
  await prisma.conversationNote.create({ data: { conversationId: conv.id, authorId: null, body: noteOf(data, outcome) } });
  // A person attends from here: the queue's own times (Entrada na fila, Aceite, 1ª resposta) start now, not the assistant's.
  await prisma.conversation.update({ where: { id: conv.id }, data: { status: "NEW", enteredQueueAt: new Date(), assignedAgentId: null, acceptedAt: null, firstResponseAt: null } });
  await prisma.conversationEvent.create({ data: { conversationId: conv.id, type: "AI_TO_QUEUE", payload: { reason: outcome } } });
  await end(session, "QUEUE");
  realtimeEvents.newQueueConversation(conv.connectionId, conv.id, conv.contactName ?? conv.phone);
}

const GOODBYE = "Obrigado pelo contato! Sempre que precisar, é só chamar por aqui. 👋";

/**
 * The customer doesn't need the assistant ("não preciso de nada", "foi engano", "deixa pra lá"): after something was
 * done for them it closes like any attendance (goodbye + survey); with nothing done, a short goodbye and the
 * conversation closes without the survey — there was no attendance to rate, and nothing goes to the queue.
 */
async function noNeed(conv: Conv, session: AiSession, settings: AiAssistantSettingsDTO, data: SessionData) {
  if (data.done?.length) return finish(conv, session, settings, data, { outcome: "resolvido; cliente disse que não precisava de mais nada" });
  return finish(conv, session, settings, data, { goodbye: phrase("noNeedGoodbye"), outcome: "cliente não precisava de atendimento" });
}
const GOODBYE_ON_REQUEST = "Tudo bem, vou encerrar nossa conversa. Sempre que precisar, é só chamar por aqui. 👋";

/**
 * Closes the conversation as its attendant, exactly like the Encerrar button: closed by the assistant (Relatórios count
 * it), then the closing message and the satisfaction survey by the same rules as any attendant's close — the closing
 * message chosen for the Assistente Virtual in Respostas › Encerramento (or, with none, the assistant's own goodbye), the
 * survey of Respostas › Pesquisa, and the tags that stop either one. With the survey on, the closing message waits for
 * the score, as it does for the team.
 */
async function finish(conv: Conv, session: AiSession, settings: AiAssistantSettingsDTO | null, data: SessionData, options: { goodbye?: string; outcome?: string; endReason?: string } = {}): Promise<void> {
  const assistant = await getAssistantUser();
  const outcome = options.outcome ?? "resolvido pelo assistente";
  await prisma.conversationNote.create({ data: { conversationId: conv.id, authorId: null, body: noteOf(data, outcome) } });
  const now = new Date();
  const closed = await prisma.conversation.updateMany({
    where: { id: conv.id, status: "IN_AI" },
    data: { status: "CLOSED", closedAt: now, closedByUserId: assistant.id, assignedAgentId: assistant.id, closeReason: "AI_ASSISTANT", pendingTransferDeadline: null },
  });
  await end(session, options.endReason ?? "RESOLVED");
  if (closed.count === 0) return;
  await prisma.conversationEvent.create({ data: { conversationId: conv.id, type: "CLOSED", payload: { agentId: assistant.id, byAssistant: true, previousStatus: "IN_AI", outcome } } });
  const current = settings ?? (await getAiAssistantSettings());
  scheduleCloseFollowUp(conv.id, await closingMessageOf(conv, current, assistant.id, options.goodbye ?? GOODBYE));
  realtimeEvents.newMessage(conv.id, null);
}

/** The closing message of the Assistente Virtual: the one assigned to it in Respostas › Encerramento, else its own goodbye. */
async function closingMessageOf(conv: Conv, settings: AiAssistantSettingsDTO, assistantId: string, fallback: string): Promise<HeldClosingMessage> {
  const configured = await getActiveClosingMessageForAgent(assistantId, conv.connectionId);
  if (!configured) return { text: fallback, senderId: assistantId, senderDisplayName: settings.name };
  const text = renderAutoMessageTemplate(configured.text, {
    atendente: settings.name,
    atendenteNome: settings.name,
    atendenteCargo: settings.name,
    cliente: conv.contactName ?? conv.phone,
    primeiroNome: conv.firstName,
  });
  return { text, senderId: assistantId, senderDisplayName: configured.showSenderName ? settings.name : null, media: copyReplyMediaFile(configured) };
}

// --- Client data ------------------------------------------------------------------------------------------

interface ClientFound {
  clientKey: string;
  name: string | null;
  address: string | null;
  /** The phones on this client's rows (55 + DDD + 8 digits) — to tell whether the customer writes from one of them. */
  phoneKeys: string[];
  /** As written on the spreadsheet, for the note and the pop-up. */
  phones: string[];
}

async function findClientByCpf(conv: Conv, cpfKey: string, toleranceHours = 0): Promise<ClientFound | null | "UNAVAILABLE"> {
  const source = await usableSource({ whatsappConnectionId: conv.connectionId, staleToleranceHours: toleranceHours });
  if (!source) return "UNAVAILABLE";
  const { map, byClient } = await clientRows(source, { id: conv.id, whatsappConnectionId: conv.connectionId, dataClientKey: null, dataCpfKey: cpfKey, dataSuspensionAckAt: null, contact: { phone: conv.phone } });
  const first = [...byClient.entries()][0];
  if (!first) return null;
  const [clientKey, rows] = first;
  const col = (row: Row, role: keyof ColumnMap) => (map[role] ? (row[map[role]!] ?? "").trim() : "");
  const row = rows[0].data;
  const address = [col(row, "payerAddress"), col(row, "payerCity"), col(row, "payerZip")].filter(Boolean).join(", ");
  const phones = [...new Set(rows.map((r) => col(r.data, "phone")).filter(Boolean))];
  const phoneKeys = [...new Set(phones.map((p) => phoneKey(p)).filter((k): k is string => Boolean(k)))];
  return { clientKey, name: col(row, "clientName") || null, address: address || null, phoneKeys, phones };
}

async function openContracts(conv: Conv, toleranceHours = 0): Promise<ClientContractDTO[] | null> {
  const fresh = await prisma.conversation.findUniqueOrThrow({ where: { id: conv.id } });
  const data = await getClientData({ ...fresh, contact: { phone: conv.phone }, staleToleranceHours: toleranceHours }, "ADMIN");
  if (data.status !== "OK" || !data.client) return null;
  return data.client.contracts;
}

function parcelLine(parcel: ClientContractDTO["parcels"][number], contract: string, showContract: boolean): string {
  const month = monthOf(parcel.due) ?? parcel.due ?? "sem vencimento";
  const value = formatBrl(parcel.overdue ? (parcel.updatedValue ?? parcel.value) : parcel.value) ?? "valor não informado";
  const late = parcel.overdue ? ` — vencida em ${parcel.due}, valor atualizado para hoje` : parcel.due ? ` — vence em ${parcel.due}` : "";
  return `${month}: ${value}${late}${showContract ? ` (contrato ${contract})` : ""}`;
}

/** Every open parcel, for the customer to see what is open (month, value, overdue). */
function parcelList(contracts: ClientContractDTO[]): string[] {
  const showContract = contracts.filter((c) => c.parcels.length > 0).length > 1;
  return contracts.flatMap((contract) => contract.parcels.map((parcel) => parcelLine(parcel, contract.number, showContract))).slice(0, MAX_PARCELS_LISTED);
}

/**
 * What the customer can ask the boleto for — the same rule as the team's: never skipping an older parcel. Per
 * contract, only the oldest open parcel, or the oldest and the next one together (one PDF).
 */
function buildOptions(contracts: ClientContractDTO[]): ParcelOption[] {
  const withParcels = contracts.filter((c) => c.parcels.length > 0);
  const showContract = withParcels.length > 1;
  const options: ParcelOption[] = [];
  for (const contract of withParcels) {
    const [oldest, next] = contract.parcels;
    const of = (parcel: typeof oldest) => monthOf(parcel.due) ?? parcel.due ?? "sem vencimento";
    const suffix = showContract ? ` (contrato ${contract.number})` : "";
    options.push({ id: oldest.id, contract: contract.number, label: `${parcelLine(oldest, contract.number, false)}${suffix}`, ids: [oldest.id] });
    if (next) {
      options.push({ id: next.id, contract: contract.number, label: `${of(oldest)} e ${of(next)} juntas, no mesmo PDF${suffix}`, ids: [oldest.id, next.id] });
    }
  }
  return options;
}
// --- Steps ------------------------------------------------------------------------------------------------

/** "O mesmo CPF de antes": this conversation's, else the last one this phone confirmed — still on the spreadsheet. */
async function previousCpf(conv: Conv): Promise<string | null> {
  const candidates = [
    conv.dataCpfKey,
    ...(await prisma.contactCpfVerification.findMany({ where: { contactId: conv.contactId }, orderBy: { verifiedAt: "desc" }, take: 3 })).map((v) => v.cpfKey),
  ].filter((c): c is string => Boolean(c));
  if (candidates.length === 0) return null;
  const { toleranceHours } = await clientDataAccess(conv);
  for (const cpf of [...new Set(candidates)]) {
    const found = await findClientByCpf(conv, cpf, toleranceHours);
    if (found && found !== "UNAVAILABLE") return cpf;
  }
  return null;
}

/** Outside working hours (or a holiday) on this connection's Horário de expediente. No schedule = always open. */
async function closedNow(conv: Pick<Conv, "connectionId">): Promise<boolean> {
  const schedule = await getConnectionSchedule("WHATSAPP", conv.connectionId).catch(() => null);
  if (!schedule) return false;
  return !(await isWorkScheduleOpen(schedule).catch(() => true));
}

interface ClientDataAccess {
  usable: boolean;
  closed: boolean;
  toleranceHours: number;
  /** Set when the data used is past its deadline (tolerated outside working hours). */
  staleSince?: string;
  reason: string | null;
}

/** Whether the client data can be consulted now: in working hours only when up to date; outside, a little older too. */
async function clientDataAccess(conv: Conv): Promise<ClientDataAccess> {
  const closed = await closedNow(conv);
  const toleranceHours = closed ? STALE_TOLERANCE_HOURS_CLOSED : 0;
  const access = await dataAccessFor(conv.connectionId, toleranceHours);
  return {
    usable: access.usable,
    closed,
    toleranceHours,
    staleSince: access.stale && access.dataUpdatedAt ? localDateTime(access.dataUpdatedAt) : undefined,
    reason: access.reason,
  };
}

/**
 * The data can't be consulted: the customer hears it plainly (not just the out-of-hours notice), the request goes to the
 * team with the CPF and the reason, and — outside working hours — the connection's out-of-hours notice follows.
 */
async function dataUnavailable(conv: Conv, session: AiSession, settings: AiAssistantSettingsDTO, data: SessionData, access: ClientDataAccess) {
  const what = data.intent === "DEBITOS" ? "os débitos" : "os boletos";
  const cpf = data.cpfKey ? ` com o CPF ${maskCpf(data.cpfKey)}` : "";
  await say(conv, settings, phrase(access.closed ? "dataUnavailableClosed" : "dataUnavailable", { o_que: what, com_cpf: cpf }));
  return handToQueue(conv, session, settings, data, `consulta indisponível: ${access.reason ?? "dados dos clientes indisponíveis"}`, access.closed);
}

/**
 * Always asks whose CPF the boleto (or the débitos) is for — the person writing may be a beneficiary or a relative,
 * and the boleto is in the titular's name. A CPF used before by this phone is offered as "mesmo".
 */
async function askCpf(conv: Conv, session: AiSession, settings: AiAssistantSettingsDTO, data: SessionData) {
  const proposito = data.intent === "DEBITOS" ? "Para consultar os débitos" : "Para enviar o boleto";
  const previous = await previousCpf(conv);
  if (previous) {
    await say(conv, settings, phrase("askCpfWithPrevious", { proposito, cpf: maskCpf(previous), nome: nameOf(conv) }));
  } else {
    await say(conv, settings, phrase("askCpf", { proposito, nome: nameOf(conv) }));
  }
  await save(session, "AWAIT_CPF", { ...data, offerCpf: previous ?? undefined });
}

/**
 * Boleto or débitos asked: first whose CPF it is (never assumed from the phone — the titular may be someone else);
 * a CPF already in the message is used right away.
 */
async function startFinance(conv: Conv, session: AiSession, settings: AiAssistantSettingsDTO, data: SessionData, intent: FinanceIntent, text = "") {
  // The CPF is asked even when the data can't be consulted: the request reaches the team with it.
  const next: SessionData = { ...data, intent, cpfAttempts: 0, afterEmpty: false, offerCpf: undefined };
  if (text && extractCpf(text)) return onCpf(conv, session, settings, { ...next, pendingCpf: undefined }, text);
  if (data.pendingCpf) return onCpf(conv, session, settings, { ...next, pendingCpf: undefined }, data.pendingCpf);
  return askCpf(conv, session, settings, next);
}

async function confirmClient(conv: Conv, cpfKey: string, clientKey: string) {
  await prisma.conversation.update({ where: { id: conv.id }, data: { dataCpfKey: cpfKey, dataClientKey: clientKey } });
  conv.dataCpfKey = cpfKey;
  conv.dataClientKey = clientKey;
}

async function onCpf(conv: Conv, session: AiSession, settings: AiAssistantSettingsDTO, data: SessionData, text: string) {
  if (data.afterEmpty && isNo(text)) {
    await say(conv, settings, phrase("okAnythingElse"));
    return save(session, "AWAIT_MORE", { ...data, afterEmpty: false });
  }
  const cpf = extractCpf(text) ?? (data.offerCpf && isSameAnswer(text) ? data.offerCpf : null);
  if (!cpf) {
    const attempts = (data.cpfAttempts ?? 0) + 1;
    if (attempts >= MAX_CPF_ATTEMPTS) return handToQueue(conv, session, settings, { ...data, cpfAttempts: attempts }, "CPF não informado ou inválido");
    const hint = looksLikeDocumentAttempt(text) ? phrase("cpfInvalid") : phrase("cpfMissing");
    await say(conv, settings, hint);
    return save(session, "AWAIT_CPF", { ...data, cpfAttempts: attempts });
  }
  // Someone trying CPF after CPF from the same phone (across conversations): stop and pass to the team.
  if ((await failedCpfChecksToday(conv)) >= MAX_FAILED_CPF_PER_DAY) {
    await say(conv, settings, phrase("cpfLimit"));
    return handToQueue(conv, session, settings, data, `limite de ${MAX_FAILED_CPF_PER_DAY} tentativas de CPF em 24 horas neste telefone`, false);
  }
  const access = await clientDataAccess(conv);
  if (!access.usable) return dataUnavailable(conv, session, settings, { ...data, cpfKey: cpf }, access);
  data = { ...data, toleranceHours: access.toleranceHours, staleSince: access.staleSince };
  const found = await findClientByCpf(conv, cpfKeyOf(cpf)!, access.toleranceHours);
  if (found === "UNAVAILABLE") return dataUnavailable(conv, session, settings, { ...data, cpfKey: cpf }, await clientDataAccess(conv));
  if (!found) {
    await recordFailedCpfCheck(conv, "NOT_FOUND");
    const attempts = (data.cpfAttempts ?? 0) + 1;
    if (attempts >= MAX_CPF_ATTEMPTS) return handToQueue(conv, session, settings, { ...data, cpfAttempts: attempts, cpfKey: cpf }, "CPF não encontrado no cadastro");
    await say(conv, settings, phrase("cpfNotFound"));
    return save(session, "AWAIT_CPF", { ...data, cpfAttempts: attempts });
  }
  const next: SessionData = { ...data, cpfKey: cpf, afterEmpty: false, offerCpf: undefined, nameAttempts: 0, informedName: undefined, informedAddress: undefined, addressDiffers: undefined };
  const already = await prisma.contactCpfVerification.findUnique({ where: { contactId_cpfKey: { contactId: conv.contactId, cpfKey: cpf } } });
  if (already) {
    await confirmClient(conv, cpf, found.clientKey);
    return deliver(conv, session, settings, { ...next, done: [...(next.done ?? []), "CPF já confirmado antes por este telefone"] });
  }
  if (!found.name) return handToQueue(conv, session, settings, next, "cadastro sem nome do cliente para confirmar");
  await say(conv, settings, phrase("askName"));
  return save(session, "AWAIT_NAME", next);
}

async function onName(conv: Conv, session: AiSession, settings: AiAssistantSettingsDTO, data: SessionData, text: string) {
  const found = data.cpfKey ? await findClientByCpf(conv, data.cpfKey, data.toleranceHours) : null;
  if (found === "UNAVAILABLE") return dataUnavailable(conv, session, settings, data, await clientDataAccess(conv));
  if (!found || !found.name) return handToQueue(conv, session, settings, data, "cadastro do CPF não encontrado para confirmar o nome");
  const informedName = text.trim().slice(0, 200);
  if (!namesMatch(informedName, found.name)) {
    await recordFailedCpfCheck(conv, "NAME_MISMATCH");
    const attempts = (data.nameAttempts ?? 0) + 1;
    const next: SessionData = { ...data, informedName, nameMatched: false, nameAttempts: attempts };
    if (attempts >= MAX_NAME_ATTEMPTS) {
      await say(conv, settings, phrase("nameMismatchFinal"));
      return handToQueue(conv, session, settings, next, "nome informado não confere com o CPF");
    }
    await say(conv, settings, phrase("nameMismatch"));
    return save(session, "AWAIT_NAME", next);
  }
  if (!settings.confirmAddress) return confirmIdentity(conv, session, settings, { ...data, informedName, nameMatched: true }, found, null);
  await say(conv, settings, phrase("askAddress"));
  return save(session, "AWAIT_ADDRESS", { ...data, informedName, nameMatched: true });
}

async function onAddress(conv: Conv, session: AiSession, settings: AiAssistantSettingsDTO, data: SessionData, text: string) {
  const found = data.cpfKey ? await findClientByCpf(conv, data.cpfKey, data.toleranceHours) : null;
  if (found === "UNAVAILABLE") return dataUnavailable(conv, session, settings, data, await clientDataAccess(conv));
  if (!found) return handToQueue(conv, session, settings, data, "cadastro do CPF não encontrado para confirmar o endereço");
  return confirmIdentity(conv, session, settings, data, found, text.trim().slice(0, 300));
}

/**
 * Name confirmed (and the address, when Configurações asks for it): the conversation is this client's from now on. An
 * address different from the record, or a phone that isn't on it, raises "Cadastro desatualizado" for the team.
 */
async function confirmIdentity(conv: Conv, session: AiSession, settings: AiAssistantSettingsDTO, data: SessionData, found: ClientFound, informedAddress: string | null) {
  const addressDiffers = informedAddress !== null && found.address ? !addressesMatch(informedAddress, found.address) : null;
  // A beneficiary or relative writing for the titular: their phone isn't on the record yet — the team adds it.
  const ownKey = phoneKey(conv.phone);
  const phoneMissing = Boolean(ownKey) && !found.phoneKeys.includes(ownKey!);
  if (addressDiffers || phoneMissing) {
    await prisma.clientDataCorrection.create({
      data: {
        contactId: conv.contactId,
        conversationId: conv.id,
        cpfKey: data.cpfKey!,
        clientName: found.name,
        registeredAddress: found.address,
        informedName: data.informedName ?? null,
        informedAddress: addressDiffers ? informedAddress : null,
        contactPhone: phoneMissing ? conv.phone : null,
        registeredPhones: found.phones.join(", ") || null,
      },
    });
  }
  await prisma.contactCpfVerification.upsert({
    where: { contactId_cpfKey: { contactId: conv.contactId, cpfKey: data.cpfKey! } },
    create: { contactId: conv.contactId, cpfKey: data.cpfKey! },
    update: { verifiedAt: new Date() },
  });
  await confirmClient(conv, data.cpfKey!, found.clientKey);
  await writeAudit({
    userId: null,
    action: "AI_ASSISTANT_CLIENT_CONFIRMED",
    entity: "Conversation",
    entityId: conv.id,
    ipAddress: null,
    metadata: { cpf: maskCpf(data.cpfKey!), addressDiffers, phoneMissing },
  });
  return deliver(conv, session, settings, {
    ...data,
    informedAddress: informedAddress ?? undefined,
    addressDiffers,
    phoneMissing,
    done: [...(data.done ?? []), informedAddress !== null ? "Nome e endereço confirmados pelo cliente" : "Nome confirmado pelo cliente"],
  });
}

/** With the client confirmed: the open parcels, then the boleto. */
async function deliver(conv: Conv, session: AiSession, settings: AiAssistantSettingsDTO, data: SessionData) {
  const contracts = await openContracts(conv, data.toleranceHours);
  if (!contracts) return dataUnavailable(conv, session, settings, data, await clientDataAccess(conv));
  const options = buildOptions(contracts);
  if (options.length === 0) {
    const cpf = data.cpfKey ? maskCpf(data.cpfKey) : "informado";
    await say(conv, settings, phrase("noParcels", { cpf }));
    return save(session, "AWAIT_CPF", { ...data, afterEmpty: true, cpfAttempts: 0, offerCpf: undefined, done: [...(data.done ?? []), `Informado: nenhuma parcela em aberto para o CPF ${cpf}`] });
  }
  const parcels = parcelList(contracts);
  const list = parcels.map((line) => `• ${line}`).join("\n") + (data.staleSince ? `\n\n${phrase("staleList")}` : "");
  const choices = options.map((o, i) => `*${i + 1}.* ${o.label}`).join("\n");
  const done = [...(data.done ?? []), `Débitos informados: ${parcels.join("; ")}`];
  if (data.intent === "BOLETO" && options.length === 1) {
    return sendBoletos(conv, session, settings, { ...data, done }, options[0]);
  }
  if (data.intent === "BOLETO") {
    await say(conv, settings, phrase("parcelsForBoleto", { lista: list, opcoes: choices }));
  } else {
    await say(conv, settings, phrase("parcelsForDebts", { lista: list, opcoes: choices }));
  }
  return save(session, "AWAIT_PARCEL", { ...data, options, done });
}

async function onParcel(conv: Conv, session: AiSession, settings: AiAssistantSettingsDTO, data: SessionData, text: string) {
  const options = data.options ?? [];
  if (isNo(text)) {
    await say(conv, settings, phrase("okAnythingElse"));
    return save(session, "AWAIT_MORE", data);
  }
  let choice = parseChoice(text, options.length);
  if (choice === null && isYes(text) && options.length === 1) choice = 1;
  if (choice === null) {
    const unclear = (data.unclear ?? 0) + 1;
    if (unclear >= MAX_UNCLEAR) return handToQueue(conv, session, settings, { ...data, unclear }, "não entendeu qual parcela o cliente queria");
    await say(conv, settings, phrase("parcelUnclear", { total: options.length }));
    return save(session, "AWAIT_PARCEL", { ...data, unclear });
  }
  if (choice === 0) {
    // "Todas", "as duas", "juntas": the oldest and the next one, when there's only one such option. Never more than two.
    const together = options.filter((o) => o.ids.length === 2);
    if (together.length === 1) return sendBoletos(conv, session, settings, { ...data, unclear: 0 }, together[0]);
    if (options.length === 1) return sendBoletos(conv, session, settings, { ...data, unclear: 0 }, options[0]);
    await say(conv, settings, phrase("parcelOnlyTwo", { total: options.length }));
    return save(session, "AWAIT_PARCEL", data);
  }
  return sendBoletos(conv, session, settings, { ...data, unclear: 0 }, options[choice - 1]);
}

async function sendBoletos(conv: Conv, session: AiSession, settings: AiAssistantSettingsDTO, data: SessionData, option: ParcelOption) {
  const ids = [...new Set(option.ids)];
  const fresh = await prisma.conversation.findUniqueOrThrow({ where: { id: conv.id } });
  const target = { ...fresh, contact: { name: conv.contactName, phone: conv.phone }, staleToleranceHours: data.toleranceHours ?? 0 };
  try {
    const preview = await previewBoletos(target, ids);
    const prepared = await prepareBoletos(target, ids, true);
    const caption = aiAssistantReply(settings.name, preview.message.trim());
    const document = await recordAiMessage(conv.id, "DOCUMENT", caption);
    await addAttachment(document.id, { fileName: prepared.fileName, mimeType: "application/pdf", sizeBytes: prepared.pdf.length, storageKey: prepared.storageKey, kind: "DOCUMENT" });
    await whatsappService.sendOutboundFile(conv.connectionId, document.id, conv.phone, prepared.pdf, prepared.fileName, "application/pdf", null, caption);
    realtimeEvents.newMessage(conv.id, null);
    for (const item of prepared.items) {
      await sayRaw(conv, item.linha.replace(/\D/g, ""));
      if (item.pix) await sayRaw(conv, item.pix);
    }
    const sent =
      prepared.items.map((i) => `contrato ${i.contract}, vencimento ${i.due}, ${i.updatedValue ?? i.value}`).join("; ") +
      (data.staleSince ? ` — fora do expediente, com os dados de ${data.staleSince} (já passaram do prazo de atualização)` : "");
    await prisma.conversationNote.create({ data: { conversationId: conv.id, authorId: null, body: `Boleto enviado pelo Assistente Virtual: ${sent}.` } });
    for (const item of prepared.items) {
      await writeAudit({ userId: null, action: "BOLETO_SENT", entity: "Conversation", entityId: conv.id, ipAddress: null, metadata: { ...item, byAssistant: true, contactPhone: conv.phone } });
    }
    await say(conv, settings, phrase(data.staleSince ? "boletoSentStale" : "boletoSent"));
    return save(session, "AWAIT_MORE", { ...data, done: [...(data.done ?? []), `Boleto enviado: ${sent}`] });
  } catch (err) {
    const reason = (err as Error).message ?? "erro ao gerar o boleto";
    logger.warn({ err, conversationId: conv.id }, "assistant could not send the boleto");
    await say(conv, settings, phrase("boletoFailed")).catch(() => undefined);
    return handToQueue(conv, session, settings, { ...data, done: [...(data.done ?? []), `Boleto não gerado: ${reason}`] }, "boleto não pôde ser gerado automaticamente");
  }
}

/** What the customer wants, by the obvious words first and the local AI only when they don't say it. */
async function intentOf(text: string, data: SessionData): Promise<{ intent: Intent | null; data: SessionData }> {
  const byRule = ruleIntent(text);
  // The only "other subject" the rules recognize: cancelling the plan or the contract.
  if (byRule === "OUTRO") return { intent: byRule, data: { ...data, summary: data.summary || "quer cancelar o plano ou o contrato" } };
  if (byRule) return { intent: byRule, data };
  const byAi = await classifyIntent(text);
  if (!byAi) return { intent: null, data };
  return { intent: byAi.intent, data: { ...data, summary: byAi.summary || data.summary } };
}

async function onIntent(conv: Conv, session: AiSession, settings: AiAssistantSettingsDTO, data: SessionData, text: string, state: State) {
  const { intent, data: next } = await intentOf(text, data);
  switch (intent) {
    case "ATENDENTE":
      return handToQueue(conv, session, settings, next, "cliente pediu um atendente");
    case "BOLETO":
    case "DEBITOS":
      return startFinance(conv, session, settings, { ...next, unclear: 0 }, intent, text);
    case "ENCERRAR":
      return finish(conv, session, settings, next, { goodbye: GOODBYE_ON_REQUEST, outcome: next.done?.length ? "resolvido; cliente pediu para encerrar" : "cliente pediu para encerrar" });
    case "SEM_NECESSIDADE":
      return noNeed(conv, session, settings, next);
    case "AGRADECIMENTO":
      if (state === "AWAIT_MORE") return finish(conv, session, settings, next);
      if (next.done?.length) return finish(conv, session, settings, next);
      // "Não, obrigado" right after "Como posso ajudar?": nothing to do.
      if (isNo(text)) return noNeed(conv, session, settings, next);
      await say(conv, settings, phrase("youreWelcome"));
      return save(session, state, next);
    case "SAUDACAO":
      await say(conv, settings, state === "AWAIT_MORE" ? phrase("anythingElse") : phrase("howCanIHelp"));
      return save(session, state, next);
    case "OUTRO":
      return handToQueue(conv, session, settings, next, "assunto para a equipe");
    default: {
      if (state === "AWAIT_MORE" && isNo(text)) return finish(conv, session, settings, next);
      // A plain "não" to "Como posso ajudar?": nothing to do.
      if (state === "AWAIT_INTENT" && isNo(text)) return noNeed(conv, session, settings, next);
      // Only a CPF, before saying what it is for: kept, and the customer is asked what they need.
      const cpf = extractCpf(text);
      if (cpf) {
        await say(conv, settings, phrase("cpfReceivedWhichService", { cpf: maskCpf(cpf) }));
        return save(session, state, { ...next, pendingCpf: cpf });
      }
      const unclear = (next.unclear ?? 0) + 1;
      if (unclear >= MAX_UNCLEAR) return handToQueue(conv, session, settings, { ...next, unclear }, "assistente não entendeu o pedido");
      await say(conv, settings, phrase("notUnderstood"));
      return save(session, state, { ...next, unclear });
    }
  }
}

// --- One run ------------------------------------------------------------------------------------------------

/** The customer's messages not answered yet, as text — audio transcribed first (the assistant only answers after it). */
async function pendingText(conv: Conv, session: AiSession): Promise<{ text: string; last: Date | null; failedAudio: boolean; media: boolean; providerIds: string[] }> {
  const messages = await prisma.message.findMany({
    where: { conversationId: conv.id, direction: "INBOUND", ...(session.lastHandledAt ? { createdAt: { gt: session.lastHandledAt } } : {}) },
    orderBy: { createdAt: "asc" },
    include: { attachments: true },
  });
  const parts: string[] = [];
  let failedAudio = false;
  let media = false;
  for (const message of messages) {
    if (message.type === "AUDIO") {
      let transcription = message.transcription;
      const attachment = message.attachments[0];
      if (!transcription && attachment) {
        transcription = await transcribeAudio(attachment.storageKey, attachment.mimeType);
        if (transcription) {
          await prisma.message.update({ where: { id: message.id }, data: { transcription } });
          realtimeEvents.newMessage(conv.id, null);
        }
      }
      if (transcription) parts.push(transcription);
      else failedAudio = true;
      continue;
    }
    if (message.body?.trim()) parts.push(message.body.trim());
    else if (message.type !== "TEXT") media = true;
  }
  const providerIds = messages.map((m) => m.providerMessageId).filter((id): id is string => Boolean(id));
  return { text: parts.join("\n"), last: messages.at(-1)?.createdAt ?? null, failedAudio, media, providerIds };
}

/**
 * An audio the server could not transcribe: like a person who couldn't hear it, the assistant asks the customer to write
 * (at any hour — the out-of-hours notice is only for when a person is really needed). A second one in a row goes to the
 * team, with the audios there for whoever attends.
 */
async function audioNotUnderstood(conv: Conv, session: AiSession, settings: AiAssistantSettingsDTO, data: SessionData) {
  const fails = (data.audioFails ?? 0) + 1;
  if (fails >= MAX_AUDIO_FAILS) {
    await say(conv, settings, phrase("audioFailed")).catch(() => undefined);
    return handToQueue(conv, session, settings, { ...data, audioFails: fails }, "áudios não puderam ser transcritos");
  }
  await say(conv, settings, phrase("audioAskToWrite", { nome: nameOf(conv) }));
  return save(session, session.state as State, { ...data, audioFails: fails });
}

async function run(conversationId: string): Promise<unknown> {
  const conv = await loadConv(conversationId);
  if (!conv) return;
  let session = await prisma.aiSession.findUnique({ where: { conversationId } });
  if (session?.endedAt) return;
  const settings = await getAiAssistantSettings();
  if (!session) session = await prisma.aiSession.create({ data: { conversationId, contactId: conv.contactId, state: "NEW" } });
  let data = dataOf(session);

  // Switched off, the connection taken out, or a tag that stops the assistant: the conversation goes to the queue quietly.
  if (!assistantAnswers(settings, conv.connectionId, conv.phone)) return handToQueue(conv, session, null, data, "assistente desligado para esta conversa", false);
  const tag = await blockingTag(conv.contactId, "AI");
  if (tag) return handToQueue(conv, session, null, data, `etiqueta ${tag.name} não permite o assistente`, false);

  const pending = await pendingText(conv, session);
  // Read (blue ticks) as soon as the assistant takes the messages, like someone who opened the chat.
  if (pending.providerIds.length) void whatsappService.markMessagesRead(conv.connectionId, conv.phone, pending.providerIds).catch(() => undefined);
  if (pending.last) session = await prisma.aiSession.update({ where: { id: session.id }, data: { lastHandledAt: pending.last, lastActivityAt: new Date() } });
  const text = pending.text;
  if (text) data = { ...data, said: [...(data.said ?? []), text.slice(0, 300)], audioFails: 0 };

  const state = (session.state as State) ?? "NEW";
  if (state === "NEW") {
    await takeAsAttendant(conv);
    if (text && ruleIntent(text) === "ENCERRAR") return finish(conv, session, settings, data, { goodbye: GOODBYE_ON_REQUEST, outcome: "cliente pediu para encerrar" });
    if (text && ruleIntent(text) === "SEM_NECESSIDADE") return noNeed(conv, session, settings, data);
    if (settings.greeting.trim()) await say(conv, settings, openingOf(conv, settings.greeting));
    session = await save(session, "AWAIT_INTENT", data);
    if (!text) {
      if (pending.failedAudio) return audioNotUnderstood(conv, session, settings, data);
      if (pending.media) return handToQueue(conv, session, settings, data, "cliente enviou um arquivo");
      return;
    }
    // A plain greeting already got its answer (the greeting itself asks how to help).
    if (ruleIntent(text) === "SAUDACAO") return;
    return onIntent(conv, session, settings, data, text, "AWAIT_INTENT");
  }

  if (!text) {
    if (pending.failedAudio) return audioNotUnderstood(conv, session, settings, data);
    if (pending.media) return handToQueue(conv, session, settings, data, "cliente enviou um arquivo");
    return;
  }

  // "Pode encerrar" / "quero sair da conversa": closed right away, with the survey like any close.
  if (ruleIntent(text) === "ENCERRAR") {
    return finish(conv, session, settings, data, { goodbye: GOODBYE_ON_REQUEST, outcome: data.done?.length ? "resolvido; cliente pediu para encerrar" : "cliente pediu para encerrar" });
  }

  // "Não preciso de nada", "foi engano", "deixa pra lá": a goodbye, not the queue (never while giving the name or address).
  if (state !== "AWAIT_NAME" && state !== "AWAIT_ADDRESS" && ruleIntent(text) === "SEM_NECESSIDADE") return noNeed(conv, session, settings, data);

  // "Quero falar com um atendente" in the middle of anything: straight to the queue.
  if (state !== "AWAIT_NAME" && state !== "AWAIT_ADDRESS" && ruleIntent(text) === "ATENDENTE") {
    return handToQueue(conv, session, settings, data, "cliente pediu um atendente");
  }

  // "Errei o CPF", "não é esse", "o endereço tá errado": back to that step instead of going on with the wrong data.
  const asked = state === "AWAIT_NAME" || state === "AWAIT_ADDRESS" || state === "AWAIT_PARCEL" || state === "AWAIT_MORE" ? correctionTarget(text) : null;
  // Without the address step there is no address to correct.
  const correction = asked === "ENDERECO" && !settings.confirmAddress ? null : asked;
  if (correction) {
    const reset: SessionData = { ...data, nameAttempts: 0, informedName: undefined, nameMatched: undefined, options: undefined, unclear: 0 };
    if (extractCpf(text)) return onCpf(conv, session, settings, { ...reset, cpfAttempts: 0 }, text);
    if (correction === "ENDERECO" && data.cpfKey && data.nameMatched) {
      await say(conv, settings, phrase("correctionAddress"));
      return save(session, "AWAIT_ADDRESS", { ...data, informedAddress: undefined });
    }
    await say(conv, settings, phrase("correctionCpf"));
    return save(session, "AWAIT_CPF", { ...reset, cpfKey: undefined, cpfAttempts: 0, afterEmpty: false });
  }

  switch (state) {
    case "AWAIT_CPF":
      return onCpf(conv, session, settings, data, text);
    case "AWAIT_NAME":
      return onName(conv, session, settings, data, text);
    case "AWAIT_ADDRESS":
      return onAddress(conv, session, settings, data, text);
    case "AWAIT_PARCEL":
      return onParcel(conv, session, settings, data, text);
    case "AWAIT_INTENT":
    case "AWAIT_MORE":
      return onIntent(conv, session, settings, data, text, state);
    default:
      return;
  }
}

/** A failure in the middle never strands the customer: the conversation goes to the queue with a note. */
async function safeRun(conversationId: string): Promise<void> {
  try {
    await run(conversationId);
  } catch (err) {
    logger.error({ err, conversationId }, "assistant failed — handing the conversation to the queue");
    try {
      const conv = await loadConv(conversationId);
      const session = await prisma.aiSession.findUnique({ where: { conversationId } });
      if (conv && session && !session.endedAt) await handToQueue(conv, session, await getAiAssistantSettings(), dataOf(session), "erro no assistente");
    } catch (inner) {
      logger.error({ err: inner, conversationId }, "assistant could not hand the conversation to the queue");
    }
  }
}

// Messages of the same customer are answered one run at a time, in order.
const queues = new Map<string, Promise<void>>();
const timers = new Map<string, NodeJS.Timeout>();

function enqueue(conversationId: string): Promise<void> {
  const previous = queues.get(conversationId) ?? Promise.resolve();
  const next = previous.then(() => safeRun(conversationId));
  queues.set(conversationId, next);
  void next.finally(() => {
    if (queues.get(conversationId) === next) queues.delete(conversationId);
  });
  return next;
}

/**
 * Entry point for each customer message of a conversation in IN_AI. Waits a few seconds so messages sent one after
 * the other ("oi" / "quero o boleto" / "cpf ...") get one answer.
 */
export function handleInboundForAi(conversationId: string, debounceMs = DEBOUNCE_MS): void {
  const existing = timers.get(conversationId);
  if (existing) clearTimeout(existing);
  timers.set(
    conversationId,
    setTimeout(() => {
      timers.delete(conversationId);
      void enqueue(conversationId);
    }, debounceMs)
  );
}

/** Runs right away (tests and the Fluxo hand-over). */
export function runAssistantNow(conversationId: string): Promise<void> {
  const existing = timers.get(conversationId);
  if (existing) clearTimeout(existing);
  timers.delete(conversationId);
  return enqueue(conversationId);
}

/**
 * Every minute: a customer who stopped answering for 30 minutes — closed when the assistant already helped (sent the
 * boleto or the débitos), else to the queue; sessions of conversations someone took away are closed; and messages
 * left unanswered by a restart are answered.
 */
export async function sweepAssistantSessions(now = new Date()): Promise<void> {
  await alertUnusableClientData(now).catch((err) => logger.warn({ err }, "assistant could not check the client data"));
  const open = await prisma.aiSession.findMany({ where: { endedAt: null }, take: 200 });
  for (const session of open) {
    const conversation = await prisma.conversation.findUnique({ where: { id: session.conversationId }, select: { status: true, lastMessageAt: true } });
    if (!conversation || conversation.status !== "IN_AI") {
      await end(session, "TAKEN_AWAY");
      continue;
    }
    const idleSince = session.lastActivityAt.getTime();
    if (now.getTime() - idleSince >= IDLE_MINUTES * 60_000) {
      const conv = await loadConv(session.conversationId);
      if (!conv) continue;
      const data = dataOf(session);
      if (data.done?.some((d) => d.startsWith("Boleto enviado") || d.startsWith("Débitos informados") || d.startsWith("Informado:"))) {
        await finish(conv, session, null, data, { endReason: "IDLE_CLOSED", outcome: `resolvido; cliente sem responder por ${IDLE_MINUTES} minutos` });
      } else if (!data.intent && !data.pendingCpf && !data.summary && !data.unclear) {
        // Only greeted or thanked, never asked for anything: nothing for the team to do.
        await finish(conv, session, null, data, { endReason: "IDLE_CLOSED", outcome: `cliente não fez nenhum pedido e parou de responder por ${IDLE_MINUTES} minutos` });
      } else {
        await handToQueue(conv, session, null, data, `cliente parou de responder por ${IDLE_MINUTES} minutos`, false);
      }
      continue;
    }
    // Unanswered after a restart (the timer was in memory).
    const unanswered = await prisma.message.findFirst({
      where: { conversationId: session.conversationId, direction: "INBOUND", ...(session.lastHandledAt ? { createdAt: { gt: session.lastHandledAt } } : {}) },
      orderBy: { createdAt: "desc" },
    });
    if (unanswered && now.getTime() - unanswered.createdAt.getTime() > 30_000 && !timers.has(session.conversationId) && !queues.has(session.conversationId)) {
      void enqueue(session.conversationId);
    }
  }
}

/** The Fluxo's "Assistente Virtual" step: the conversation leaves the flow for the assistant, which greets first. */
export async function startFromFlow(conversationId: string): Promise<void> {
  const conversation = await prisma.conversation.findUnique({ where: { id: conversationId }, select: { contactId: true } });
  if (!conversation) return;
  // What the customer typed in the flow's menus was already answered by the flow.
  const last = await prisma.message.findFirst({ where: { conversationId, direction: "INBOUND" }, orderBy: { createdAt: "desc" }, select: { createdAt: true } });
  await prisma.aiSession.upsert({
    where: { conversationId },
    create: { conversationId, contactId: conversation.contactId, state: "NEW", lastHandledAt: last?.createdAt ?? null },
    update: { state: "NEW", endedAt: null, endReason: null, lastHandledAt: last?.createdAt ?? null, data: {} },
  });
  await runAssistantNow(conversationId);
}

/** Whether the assistant takes this customer (settings, connection, Modo teste and tags). */
export async function assistantTakes(connectionId: string, contactId: string, phone: string | null): Promise<boolean> {
  const settings = await getAiAssistantSettings();
  if (!assistantAnswers(settings, connectionId, phone)) return false;
  return !(await blockingTag(contactId, "AI"));
}

// --- Client data health and the simulator (Configurações › Assistente Virtual) -----------------------------------

/** Each connection the assistant attends: can it consult the client data right now — and if not, why. */
export async function assistantClientData(now = new Date()): Promise<AiAssistantClientDataDTO[]> {
  const settings = await getAiAssistantSettings();
  if (settings.connectionIds.length === 0) return [];
  const connections = await prisma.whatsAppConnection.findMany({ where: { id: { in: settings.connectionIds } }, select: { id: true, name: true }, orderBy: { name: "asc" } });
  const result: AiAssistantClientDataDTO[] = [];
  for (const connection of connections) {
    const closed = await closedNow({ connectionId: connection.id });
    const toleranceHours = closed ? STALE_TOLERANCE_HOURS_CLOSED : 0;
    const access = await dataAccessFor(connection.id, toleranceHours, now);
    result.push({
      connectionId: connection.id,
      connectionName: connection.name,
      sourceName: access.sourceName,
      status: access.status,
      dataUpdatedAt: access.dataUpdatedAt?.toISOString() ?? null,
      maxAgeHours: access.maxAgeHours,
      closedNow: closed,
      usableNow: access.usable,
      staleToleranceHours: STALE_TOLERANCE_HOURS_CLOSED,
      reason: access.reason,
    });
  }
  return result;
}

const ALERT_EVERY_MS = 10 * 60_000;
const ALERT_REPEAT_MS = 12 * 3_600_000;
let lastAlertCheck = 0;

/**
 * With the assistant on, a connection whose client data it can't consult: the administrators hear it in the bell —
 * once every 12 hours per connection, checked every 10 minutes — before customers start going to the queue for it.
 */
async function alertUnusableClientData(now: Date): Promise<void> {
  if (now.getTime() - lastAlertCheck < ALERT_EVERY_MS) return;
  lastAlertCheck = now.getTime();
  const settings = await getAiAssistantSettings();
  if (!settings.enabled) return;
  for (const item of await assistantClientData(now)) {
    if (item.usableNow) continue;
    const title = `Assistente Virtual sem dados dos clientes em "${item.connectionName}"`;
    const recent = await prisma.notification.findFirst({ where: { type: "AI_ASSISTANT_DATA", title, createdAt: { gt: new Date(Date.now() - ALERT_REPEAT_MS) } } }); // stored with the real clock
    if (recent) continue;
    const admins = await prisma.user.findMany({ where: { role: "ADMIN", status: "ACTIVE", isAssistant: false }, select: { id: true } });
    for (const admin of admins) {
      const notification = await createNotification({
        userId: admin.id,
        type: "AI_ASSISTANT_DATA",
        title,
        body: `Motivo: ${item.reason ?? "dados indisponíveis"}. Enquanto isso, quem pedir boleto ou débitos vai para a equipe com o CPF anotado.`,
        entityType: "AiAssistant",
        entityId: item.connectionId,
      });
      realtimeEvents.notificationCreated(admin.id, toNotificationDTO(notification));
    }
  }
}

const INTENT_LABEL: Record<Intent, string> = {
  BOLETO: "boleto",
  DEBITOS: "débitos em aberto",
  ATENDENTE: "falar com um atendente",
  ENCERRAR: "encerrar a conversa",
  SEM_NECESSIDADE: "não precisa de nada",
  SAUDACAO: "cumprimento",
  AGRADECIMENTO: "agradecimento",
  OUTRO: "outro assunto",
};

/** "Maria Aparecida da Silva" → "Maria A. D. S." — enough to recognize, without the whole name on the screen. */
function shortName(name: string): string {
  const [first, ...rest] = name.trim().split(/\s+/);
  return [first, ...rest.map((w) => `${w.charAt(0).toUpperCase()}.`)].join(" ");
}

/**
 * "Simular atendimento": what the assistant would do with this message (and CPF), step by step — the same checks as a
 * real conversation (understanding, working hours, client data, CPF, open parcels, the boleto), without sending
 * anything to WhatsApp and without creating a conversation.
 */
export async function simulateAssistant(input: { connectionId: string; message: string; cpf?: string | null; when: AiAssistantSimulationWhen }): Promise<AiAssistantSimulationDTO> {
  const steps: AiAssistantSimulationStepDTO[] = [];
  const done = (outcome: string): AiAssistantSimulationDTO => ({ steps, outcome });
  const settings = await getAiAssistantSettings();
  const connection = await prisma.whatsAppConnection.findUnique({ where: { id: input.connectionId }, select: { id: true, name: true } });
  if (!connection) return done("Conexão não encontrada.");

  if (!settings.enabled) steps.push({ title: "Assistente", status: "warn", detail: "Está desligado: hoje a conversa iria para o Fluxo ou para a fila. A simulação continua como se estivesse ligado." });
  else if (!settings.connectionIds.includes(connection.id)) steps.push({ title: "Assistente", status: "warn", detail: `Não atende a conexão ${connection.name}. A simulação continua como se atendesse.` });
  else steps.push({ title: "Assistente", status: "ok", detail: settings.testMode ? `Ligado em ${connection.name}, em Modo teste: só atende os telefones da lista.` : `Ligado em ${connection.name}.` });

  const text = input.message.trim();
  const cpfInMessage = extractCpf(text);
  let intent: Intent | null = ruleIntent(text);
  let how = "pelas palavras da mensagem";
  if (!intent && cpfInMessage) {
    intent = null;
  } else if (!intent && text) {
    const byAi = await classifyIntent(text);
    if (byAi) {
      intent = byAi.intent;
      how = `pela IA local${byAi.summary ? ` ("${byAi.summary}")` : ""}`;
    } else {
      steps.push({ title: "Entendimento", status: "stop", detail: "Nem as palavras da mensagem nem a IA local identificaram o pedido (a IA pode estar fora do ar)." });
      return done("Pediria para o cliente explicar em poucas palavras (boleto, débitos ou outro assunto). Se não entendesse de novo, passaria para a equipe.");
    }
  }
  if (!intent && !cpfInMessage) {
    steps.push({ title: "Entendimento", status: "stop", detail: "Mensagem vazia." });
    return done("Escreva uma mensagem como o cliente escreveria.");
  }
  if (!intent) {
    steps.push({ title: "Entendimento", status: "info", detail: "A mensagem só tem um CPF." });
    return done("Perguntaria se o cliente quer o boleto ou os débitos em aberto, e usaria esse CPF em seguida.");
  }
  steps.push({ title: "Entendimento", status: "ok", detail: `Pedido: ${INTENT_LABEL[intent]} (${how}).` });

  const closed = input.when === "closed" ? true : input.when === "open" ? false : await closedNow({ connectionId: connection.id });
  steps.push({
    title: "Expediente",
    status: "info",
    detail: closed
      ? `Fora do expediente ou feriado${input.when === "now" ? " agora" : " (simulado)"}: usa dados até ${STALE_TOLERANCE_HOURS_CLOSED} horas além do prazo da fonte.`
      : `Dentro do expediente${input.when === "now" ? " agora" : " (simulado)"}: só usa dados dentro do prazo da fonte.`,
  });

  switch (intent) {
    case "ATENDENTE":
      return done(closed ? "Enviaria a mensagem de fora do expediente da conexão, deixaria a conversa na fila e pararia de responder." : "Avisaria que vai transferir e colocaria a conversa na fila, com uma nota do pedido.");
    case "ENCERRAR":
      return done("Encerraria a conversa na hora, com a despedida e a pesquisa de satisfação (seguindo as regras das etiquetas).");
    case "SEM_NECESSIDADE":
      return done("Encerraria como um atendimento: a mensagem de encerramento (a escolhida para o assistente em Respostas, ou \"Tudo bem! Se precisar, é só chamar por aqui.\") e a pesquisa, conforme as regras e as etiquetas.");
    case "SAUDACAO":
    case "AGRADECIMENTO":
      return done("Responderia com a saudação e perguntaria como pode ajudar.");
    case "OUTRO":
      return done(closed ? "Passaria para a equipe com o resumo do assunto e enviaria a mensagem de fora do expediente." : "Passaria para a equipe com o resumo do assunto, avisando que um atendente vai continuar.");
    default:
      break;
  }

  const toleranceHours = closed ? STALE_TOLERANCE_HOURS_CLOSED : 0;
  const access = await dataAccessFor(connection.id, toleranceHours);
  if (!access.usable) {
    steps.push({ title: "Dados dos clientes", status: "stop", detail: `Não dá para consultar: ${access.reason}.` });
    return done(
      `Pediria o CPF, avisaria o cliente que não consegue consultar ${intent === "DEBITOS" ? "os débitos" : "os boletos"} agora e passaria para a equipe com o CPF e o motivo${closed ? ", seguido da mensagem de fora do expediente" : ""}.`
    );
  }
  const staleSince = access.stale && access.dataUpdatedAt ? localDateTime(access.dataUpdatedAt) : null;
  steps.push({
    title: "Dados dos clientes",
    status: staleSince ? "warn" : "ok",
    detail: staleSince
      ? `"${access.sourceName}" passou do prazo (dados de ${staleSince}), mas fora do expediente ainda é usada; o boleto vai com "se já pagou, desconsidere".`
      : `"${access.sourceName}" em dia${access.dataUpdatedAt ? ` (dados de ${localDateTime(access.dataUpdatedAt)})` : ""}.`,
  });

  const cpf = extractCpf(input.cpf ?? "") ?? cpfInMessage;
  if (!cpf) {
    steps.push({ title: "CPF", status: "info", detail: "O assistente pediria o CPF do titular agora." });
    return done("Pediria o CPF do titular. Informe um CPF de teste no simulador para ver o resto.");
  }
  const conv: Conv = { id: "simulacao", connectionId: connection.id, contactId: "", phone: "", contactName: null, firstName: null, dataCpfKey: null, dataClientKey: null };
  const found = await findClientByCpf(conv, cpfKeyOf(cpf)!, toleranceHours);
  if (found === "UNAVAILABLE" || !found) {
    steps.push({ title: "CPF", status: "stop", detail: `${maskCpf(cpf)} não está nos dados dos clientes.` });
    return done("Diria que não conseguiu confirmar os dados e pediria para conferir o CPF (no 3º erro, passaria para a equipe).");
  }
  steps.push({ title: "CPF", status: "ok", detail: `${maskCpf(cpf)}: ${found.name ? shortName(found.name) : "cliente sem nome no cadastro"} — pediria o nome completo${settings.confirmAddress ? " e o endereço" : ""} para confirmar.` });
  if (!found.name) return done("Passaria para a equipe: o cadastro não tem o nome para confirmar.");

  const target = {
    id: "simulacao",
    whatsappConnectionId: connection.id,
    dataClientKey: found.clientKey,
    dataCpfKey: cpfKeyOf(cpf),
    dataSuspensionAckAt: null,
    contact: { phone: null, name: found.name },
    staleToleranceHours: toleranceHours,
  };
  const data = await getClientData(target, "ADMIN");
  const options = data.status === "OK" && data.client ? buildOptions(data.client.contracts) : [];
  if (options.length === 0) {
    steps.push({ title: "Parcelas em aberto", status: "info", detail: "Nenhuma." });
    return done("Diria que não há parcelas em aberto para esse CPF e perguntaria se o boleto é de outra pessoa (o titular).");
  }
  steps.push({ title: "Parcelas em aberto", status: "ok", detail: parcelList(data.client!.contracts).map((line) => `• ${line}`).join("\n") });
  steps.push({ title: "Opções de boleto", status: "info", detail: options.map((o, i) => `${i + 1}. ${o.label}`).join("\n") });
  if (intent === "DEBITOS") return done(`Informaria ${options.length === 1 ? "a parcela em aberto" : `as ${options.length} parcelas em aberto`} e ofereceria o boleto.`);

  const option = options[0];
  try {
    const preview = await previewBoletos(target, [...new Set(option.ids)]);
    const items = preview.items.map((i) => `vencimento ${i.due}, ${i.updatedValue ?? i.value}`).join("; ");
    steps.push({ title: "Boleto", status: staleSince ? "warn" : "ok", detail: `Geraria o boleto da parcela mais antiga: ${items}.` });
  } catch (err) {
    steps.push({ title: "Boleto", status: "stop", detail: `Não geraria: ${(err as Error).message}.` });
    return done("Avisaria que não conseguiu gerar o boleto e passaria para a equipe com o motivo.");
  }
  const confirm = settings.confirmAddress ? "Depois de confirmar nome e endereço" : "Depois de confirmar o nome";
  const caveat = staleSince ? ', com "se já pagou, desconsidere"' : "";
  return done(
    options.length === 1
      ? `${confirm}, enviaria o PDF do boleto e a linha digitável${caveat}.`
      : `${confirm}, mostraria as parcelas em aberto e as ${options.length} opções de boleto (sempre a partir da mais antiga) e enviaria o PDF e a linha digitável da escolhida${caveat}.`
  );
}
