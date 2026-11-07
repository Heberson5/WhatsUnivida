import type { AiSession, Prisma } from "@prisma/client";
import { AI_ASSISTANT_AUTOMATED_BY, aiAssistantReply, type AiAssistantSettingsDTO, type ClientContractDTO } from "@whatsatendende/types";
import { prisma } from "../../lib/prisma";
import { logger } from "../../lib/logger";
import { writeAudit } from "../../lib/audit";
import { blockingTag } from "../../lib/auto-messages";
import { fillSendTags } from "../../lib/customer-tags";
import { realtimeEvents } from "../../realtime/realtime";
import { addAttachment } from "../messages/messages.service";
import * as whatsappService from "../whatsapp/whatsapp.service";
import { getClosedMessageForConnection } from "../work-schedules/work-schedules.service";
import { clientRows, cpfKeyOf, getClientData, usableSource, type ColumnMap, type Row } from "../data-sources/data-sources.service";
import { prepareBoletos, previewBoletos } from "../boletos/boletos.service";
import { assistantAnswers, getAiAssistantSettings } from "./ai-assistant.service";
import { classifyIntent, transcribeAudio } from "./ai-llm";
import {
  addressesMatch,
  extractCpf,
  formatBrl,
  isNo,
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
  cpfAttempts?: number;
  nameAttempts?: number;
  unclear?: number;
  informedName?: string;
  nameMatched?: boolean;
  informedAddress?: string;
  addressDiffers?: boolean | null;
  options?: ParcelOption[];
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

async function recordAiMessage(conversationId: string, type: "TEXT" | "DOCUMENT", body: string | null) {
  const message = await prisma.message.create({
    data: { conversationId, direction: "OUTBOUND", type, status: "PENDING", body, automatedBy: AI_ASSISTANT_AUTOMATED_BY },
  });
  await prisma.conversation.update({ where: { id: conversationId }, data: { lastMessageAt: new Date(), lastMessageDirection: "OUTBOUND" } });
  return message;
}

async function say(conv: Conv, settings: AiAssistantSettingsDTO, text: string): Promise<void> {
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
    if (text.trim()) await say(conv, settings, text.trim()).catch((err) => logger.warn({ err }, "assistant could not send the transfer notice"));
  }
  await prisma.conversationNote.create({ data: { conversationId: conv.id, authorId: null, body: noteOf(data, outcome) } });
  await prisma.conversation.update({ where: { id: conv.id }, data: { status: "NEW", enteredQueueAt: new Date() } });
  await prisma.conversationEvent.create({ data: { conversationId: conv.id, type: "AI_TO_QUEUE", payload: { reason: outcome } } });
  await end(session, "QUEUE");
  realtimeEvents.newQueueConversation(conv.connectionId, conv.id, conv.contactName ?? conv.phone);
}

/** Done with the customer: thanks, note, closed — nobody needed to take it. */
async function finish(conv: Conv, session: AiSession, settings: AiAssistantSettingsDTO | null, data: SessionData, tellCustomer = true): Promise<void> {
  if (tellCustomer && settings) await say(conv, settings, "Obrigado pelo contato! Sempre que precisar, é só chamar por aqui. 👋");
  await prisma.conversationNote.create({ data: { conversationId: conv.id, authorId: null, body: noteOf(data, "resolvido pelo assistente") } });
  await prisma.conversation.update({ where: { id: conv.id }, data: { status: "CLOSED", closedAt: new Date(), closeReason: "AI_ASSISTANT" } });
  await prisma.conversationEvent.create({ data: { conversationId: conv.id, type: "CLOSED", payload: { byAssistant: true } } });
  await end(session, "RESOLVED");
  realtimeEvents.newMessage(conv.id, null);
}

// --- Client data ------------------------------------------------------------------------------------------

interface ClientFound {
  clientKey: string;
  name: string | null;
  address: string | null;
}

async function findClientByCpf(conv: Conv, cpfKey: string): Promise<ClientFound | null | "UNAVAILABLE"> {
  const source = await usableSource({ whatsappConnectionId: conv.connectionId });
  if (!source) return "UNAVAILABLE";
  const { map, byClient } = await clientRows(source, { id: conv.id, whatsappConnectionId: conv.connectionId, dataClientKey: null, dataCpfKey: cpfKey, dataSuspensionAckAt: null, contact: { phone: conv.phone } });
  const first = [...byClient.entries()][0];
  if (!first) return null;
  const [clientKey, rows] = first;
  const col = (row: Row, role: keyof ColumnMap) => (map[role] ? (row[map[role]!] ?? "").trim() : "");
  const row = rows[0].data;
  const address = [col(row, "payerAddress"), col(row, "payerCity"), col(row, "payerZip")].filter(Boolean).join(", ");
  return { clientKey, name: col(row, "clientName") || null, address: address || null };
}

async function openContracts(conv: Conv): Promise<ClientContractDTO[] | null> {
  const fresh = await prisma.conversation.findUniqueOrThrow({ where: { id: conv.id } });
  const data = await getClientData({ ...fresh, contact: { phone: conv.phone } }, "ADMIN");
  if (data.status !== "OK" || !data.client) return null;
  return data.client.contracts;
}

function parcelLine(parcel: ClientContractDTO["parcels"][number], contract: string, showContract: boolean): string {
  const month = monthOf(parcel.due) ?? parcel.due ?? "sem vencimento";
  const value = formatBrl(parcel.overdue ? (parcel.updatedValue ?? parcel.value) : parcel.value) ?? "valor não informado";
  const late = parcel.overdue ? ` — vencida em ${parcel.due}, valor atualizado para hoje` : parcel.due ? ` — vence em ${parcel.due}` : "";
  return `${month}: ${value}${late}${showContract ? ` (contrato ${contract})` : ""}`;
}

function buildOptions(contracts: ClientContractDTO[]): ParcelOption[] {
  const showContract = contracts.filter((c) => c.parcels.length > 0).length > 1;
  const options: ParcelOption[] = [];
  for (const contract of contracts) {
    contract.parcels.forEach((parcel, index) => {
      options.push({ id: parcel.id, contract: contract.number, label: parcelLine(parcel, contract.number, showContract), ids: contract.parcels.slice(0, index + 1).map((p) => p.id) });
    });
  }
  return options.slice(0, MAX_PARCELS_LISTED);
}

// --- Steps ------------------------------------------------------------------------------------------------

async function askCpf(conv: Conv, session: AiSession, settings: AiAssistantSettingsDTO, data: SessionData) {
  await say(conv, settings, "Para consultar, me informe o CPF do titular do plano (ou o CNPJ, se for empresa).");
  await save(session, "AWAIT_CPF", data);
}

/** Boleto or débitos asked: a phone that already confirmed this CPF skips the questions. */
async function startFinance(conv: Conv, session: AiSession, settings: AiAssistantSettingsDTO, data: SessionData, intent: FinanceIntent) {
  const next: SessionData = { ...data, intent };
  if (!(await usableSource({ whatsappConnectionId: conv.connectionId }))) {
    return handToQueue(conv, session, settings, next, "dados dos clientes indisponíveis no momento");
  }
  if (conv.dataCpfKey) return deliver(conv, session, settings, { ...next, cpfKey: conv.dataCpfKey });
  const verified = await prisma.contactCpfVerification.findMany({ where: { contactId: conv.contactId } });
  if (verified.length === 1) {
    const found = await findClientByCpf(conv, verified[0].cpfKey);
    if (found && found !== "UNAVAILABLE") {
      await confirmClient(conv, verified[0].cpfKey, found.clientKey);
      return deliver(conv, session, settings, { ...next, cpfKey: verified[0].cpfKey, done: [...(next.done ?? []), "CPF já confirmado antes por este telefone"] });
    }
  }
  return askCpf(conv, session, settings, next);
}

async function confirmClient(conv: Conv, cpfKey: string, clientKey: string) {
  await prisma.conversation.update({ where: { id: conv.id }, data: { dataCpfKey: cpfKey, dataClientKey: clientKey } });
  conv.dataCpfKey = cpfKey;
  conv.dataClientKey = clientKey;
}

async function onCpf(conv: Conv, session: AiSession, settings: AiAssistantSettingsDTO, data: SessionData, text: string) {
  const cpf = extractCpf(text);
  if (!cpf) {
    const attempts = (data.cpfAttempts ?? 0) + 1;
    if (attempts >= MAX_CPF_ATTEMPTS) return handToQueue(conv, session, settings, { ...data, cpfAttempts: attempts }, "CPF não informado ou inválido");
    const hint = looksLikeDocumentAttempt(text) ? "Esse número não é um CPF válido. Confira e envie os 11 números do CPF (ou os 14 do CNPJ)." : "Não identifiquei o CPF na mensagem. Envie os 11 números do CPF do titular (ou os 14 do CNPJ).";
    await say(conv, settings, hint);
    return save(session, "AWAIT_CPF", { ...data, cpfAttempts: attempts });
  }
  const found = await findClientByCpf(conv, cpfKeyOf(cpf)!);
  if (found === "UNAVAILABLE") return handToQueue(conv, session, settings, data, "dados dos clientes indisponíveis no momento");
  if (!found) {
    const attempts = (data.cpfAttempts ?? 0) + 1;
    if (attempts >= MAX_CPF_ATTEMPTS) return handToQueue(conv, session, settings, { ...data, cpfAttempts: attempts, cpfKey: cpf }, "CPF não encontrado no cadastro");
    await say(conv, settings, "Não consegui confirmar seus dados. Confira o CPF e envie de novo, por favor.");
    return save(session, "AWAIT_CPF", { ...data, cpfAttempts: attempts });
  }
  const next: SessionData = { ...data, cpfKey: cpf };
  const already = await prisma.contactCpfVerification.findUnique({ where: { contactId_cpfKey: { contactId: conv.contactId, cpfKey: cpf } } });
  if (already) {
    await confirmClient(conv, cpf, found.clientKey);
    return deliver(conv, session, settings, { ...next, done: [...(next.done ?? []), "CPF já confirmado antes por este telefone"] });
  }
  if (!found.name) return handToQueue(conv, session, settings, next, "cadastro sem nome do cliente para confirmar");
  await say(conv, settings, "Obrigado! Para sua segurança, informe o nome completo do titular, como está no cadastro.");
  return save(session, "AWAIT_NAME", next);
}

async function onName(conv: Conv, session: AiSession, settings: AiAssistantSettingsDTO, data: SessionData, text: string) {
  const found = data.cpfKey ? await findClientByCpf(conv, data.cpfKey) : null;
  if (!found || found === "UNAVAILABLE" || !found.name) return handToQueue(conv, session, settings, data, "dados dos clientes indisponíveis no momento");
  const informedName = text.trim().slice(0, 200);
  if (!namesMatch(informedName, found.name)) {
    const attempts = (data.nameAttempts ?? 0) + 1;
    const next: SessionData = { ...data, informedName, nameMatched: false, nameAttempts: attempts };
    if (attempts >= MAX_NAME_ATTEMPTS) {
      await say(conv, settings, "Não consegui confirmar seus dados por aqui.");
      return handToQueue(conv, session, settings, next, "nome informado não confere com o CPF");
    }
    await say(conv, settings, "Não consegui confirmar seus dados. Pode conferir o nome completo do titular?");
    return save(session, "AWAIT_NAME", next);
  }
  await say(conv, settings, "Certo! Agora informe o endereço do cadastro (rua, número e bairro).");
  return save(session, "AWAIT_ADDRESS", { ...data, informedName, nameMatched: true });
}

async function onAddress(conv: Conv, session: AiSession, settings: AiAssistantSettingsDTO, data: SessionData, text: string) {
  const found = data.cpfKey ? await findClientByCpf(conv, data.cpfKey) : null;
  if (!found || found === "UNAVAILABLE") return handToQueue(conv, session, settings, data, "dados dos clientes indisponíveis no momento");
  const informedAddress = text.trim().slice(0, 300);
  const addressDiffers = found.address ? !addressesMatch(informedAddress, found.address) : null;
  if (addressDiffers) {
    await prisma.clientDataCorrection.create({
      data: {
        contactId: conv.contactId,
        conversationId: conv.id,
        cpfKey: data.cpfKey!,
        clientName: found.name,
        registeredAddress: found.address,
        informedName: data.informedName ?? null,
        informedAddress,
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
    metadata: { cpf: maskCpf(data.cpfKey!), addressDiffers },
  });
  return deliver(conv, session, settings, { ...data, informedAddress, addressDiffers, done: [...(data.done ?? []), "Dados confirmados pelo cliente"] });
}

/** With the client confirmed: the open parcels, then the boleto. */
async function deliver(conv: Conv, session: AiSession, settings: AiAssistantSettingsDTO, data: SessionData) {
  const contracts = await openContracts(conv);
  if (!contracts) return handToQueue(conv, session, settings, data, "dados dos clientes indisponíveis no momento");
  const options = buildOptions(contracts);
  if (options.length === 0) {
    await say(conv, settings, "Não encontrei parcelas em aberto no seu cadastro. 😊\nPosso ajudar em algo mais?");
    return save(session, "AWAIT_MORE", { ...data, done: [...(data.done ?? []), "Informado: nenhuma parcela em aberto"] });
  }
  const list = options.map((o, i) => `*${i + 1}.* ${o.label}`).join("\n");
  const done = [...(data.done ?? []), `Débitos informados: ${options.map((o) => o.label).join("; ")}`];
  if (data.intent === "BOLETO" && options.length === 1) {
    return sendBoletos(conv, session, settings, { ...data, done }, options[0]);
  }
  if (data.intent === "BOLETO") {
    await say(conv, settings, `Estas são as parcelas em aberto:\n${list}\n\nResponda com o *número* da parcela que deseja o boleto${options.length > 1 ? ", ou *todas*" : ""}.`);
  } else {
    await say(conv, settings, `Estas são as parcelas em aberto:\n${list}\n\nQuer receber o boleto? Responda com o *número* da parcela${options.length > 1 ? ", *todas*" : ""} ou *não*.`);
  }
  return save(session, "AWAIT_PARCEL", { ...data, options, done });
}

async function onParcel(conv: Conv, session: AiSession, settings: AiAssistantSettingsDTO, data: SessionData, text: string) {
  const options = data.options ?? [];
  if (isNo(text)) {
    await say(conv, settings, "Tudo bem! Posso ajudar em algo mais?");
    return save(session, "AWAIT_MORE", data);
  }
  let choice = parseChoice(text, options.length);
  if (choice === null && isYes(text) && options.length === 1) choice = 1;
  if (choice === null) {
    const unclear = (data.unclear ?? 0) + 1;
    if (unclear >= MAX_UNCLEAR) return handToQueue(conv, session, settings, { ...data, unclear }, "não entendeu qual parcela o cliente queria");
    await say(conv, settings, `Não entendi qual parcela. Responda só com o número (de 1 a ${options.length})${options.length > 1 ? " ou *todas*" : ""}.`);
    return save(session, "AWAIT_PARCEL", { ...data, unclear });
  }
  if (choice === 0) {
    // Every listed parcel, contract by contract (one PDF with all of them).
    return sendBoletos(conv, session, settings, { ...data, unclear: 0 }, { id: "all", contract: "", label: "todas as parcelas em aberto", ids: options.map((o) => o.id) });
  }
  return sendBoletos(conv, session, settings, { ...data, unclear: 0 }, options[choice - 1]);
}

async function sendBoletos(conv: Conv, session: AiSession, settings: AiAssistantSettingsDTO, data: SessionData, option: ParcelOption) {
  const ids = [...new Set(option.ids)];
  const fresh = await prisma.conversation.findUniqueOrThrow({ where: { id: conv.id } });
  const target = { ...fresh, contact: { name: conv.contactName, phone: conv.phone } };
  try {
    const preview = await previewBoletos(target, ids);
    const prepared = await prepareBoletos(target, ids, true);
    const olderIncluded = ids.length > 1 && option.id !== "all";
    const intro = olderIncluded ? "Enviei no mesmo PDF também as parcelas anteriores em aberto desse contrato, que precisam ser pagas antes.\n\n" : "";
    const caption = aiAssistantReply(settings.name, `${intro}${preview.message}`.trim());
    const document = await recordAiMessage(conv.id, "DOCUMENT", caption);
    await addAttachment(document.id, { fileName: prepared.fileName, mimeType: "application/pdf", sizeBytes: prepared.pdf.length, storageKey: prepared.storageKey, kind: "DOCUMENT" });
    await whatsappService.sendOutboundFile(conv.connectionId, document.id, conv.phone, prepared.pdf, prepared.fileName, "application/pdf", null, caption);
    realtimeEvents.newMessage(conv.id, null);
    for (const item of prepared.items) {
      await sayRaw(conv, item.linha.replace(/\D/g, ""));
      if (item.pix) await sayRaw(conv, item.pix);
    }
    const sent = prepared.items.map((i) => `contrato ${i.contract}, vencimento ${i.due}, ${i.updatedValue ?? i.value}`).join("; ");
    await prisma.conversationNote.create({ data: { conversationId: conv.id, authorId: null, body: `Boleto enviado pelo Assistente Virtual: ${sent}.` } });
    for (const item of prepared.items) {
      await writeAudit({ userId: null, action: "BOLETO_SENT", entity: "Conversation", entityId: conv.id, ipAddress: null, metadata: { ...item, byAssistant: true, contactPhone: conv.phone } });
    }
    await say(conv, settings, "Pronto! O boleto está no PDF acima e a linha digitável logo abaixo dele, para copiar.\nPosso ajudar em algo mais?");
    return save(session, "AWAIT_MORE", { ...data, done: [...(data.done ?? []), `Boleto enviado: ${sent}`] });
  } catch (err) {
    const reason = (err as Error).message ?? "erro ao gerar o boleto";
    logger.warn({ err, conversationId: conv.id }, "assistant could not send the boleto");
    await say(conv, settings, "Não consegui gerar o boleto agora.").catch(() => undefined);
    return handToQueue(conv, session, settings, { ...data, done: [...(data.done ?? []), `Boleto não gerado: ${reason}`] }, "boleto não pôde ser gerado automaticamente");
  }
}

/** What the customer wants, by the obvious words first and the local AI only when they don't say it. */
async function intentOf(text: string, data: SessionData): Promise<{ intent: Intent | null; data: SessionData }> {
  const byRule = ruleIntent(text);
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
      return startFinance(conv, session, settings, { ...next, unclear: 0 }, intent);
    case "AGRADECIMENTO":
      if (state === "AWAIT_MORE") return finish(conv, session, settings, next);
      await say(conv, settings, "Por nada! Posso ajudar com boleto, linha digitável ou débitos em aberto. É só dizer.");
      return save(session, state, next);
    case "SAUDACAO":
      await say(conv, settings, state === "AWAIT_MORE" ? "Posso ajudar em algo mais? Boleto, linha digitável ou débitos em aberto." : "Como posso ajudar? Posso enviar boleto, linha digitável ou informar débitos em aberto.");
      return save(session, state, next);
    case "OUTRO":
      return handToQueue(conv, session, settings, next, "assunto para a equipe");
    default: {
      if (state === "AWAIT_MORE" && isNo(text)) return finish(conv, session, settings, next);
      const unclear = (next.unclear ?? 0) + 1;
      if (unclear >= MAX_UNCLEAR) return handToQueue(conv, session, settings, { ...next, unclear }, "assistente não entendeu o pedido");
      await say(conv, settings, "Desculpe, não entendi. Você precisa de boleto, linha digitável ou saber os débitos em aberto? Se for outro assunto, me conte em poucas palavras que passo para a equipe.");
      return save(session, state, { ...next, unclear });
    }
  }
}

// --- One run ------------------------------------------------------------------------------------------------

/** The customer's messages not answered yet, as text — audio transcribed first (the assistant only answers after it). */
async function pendingText(conv: Conv, session: AiSession): Promise<{ text: string; last: Date | null; failedAudio: boolean; media: boolean }> {
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
  return { text: parts.join("\n"), last: messages.at(-1)?.createdAt ?? null, failedAudio, media };
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
  if (pending.last) session = await prisma.aiSession.update({ where: { id: session.id }, data: { lastHandledAt: pending.last, lastActivityAt: new Date() } });
  const text = pending.text;
  if (text) data = { ...data, said: [...(data.said ?? []), text.slice(0, 300)] };

  const state = (session.state as State) ?? "NEW";
  if (state === "NEW") {
    if (settings.greeting.trim()) await say(conv, settings, settings.greeting.trim());
    session = await save(session, "AWAIT_INTENT", data);
    if (!text) {
      if (pending.failedAudio) return handToQueue(conv, session, settings, data, "áudio não pôde ser transcrito");
      if (pending.media) return handToQueue(conv, session, settings, data, "cliente enviou um arquivo");
      return;
    }
    // A plain greeting already got its answer (the greeting itself asks how to help).
    if (ruleIntent(text) === "SAUDACAO") return;
    return onIntent(conv, session, settings, data, text, "AWAIT_INTENT");
  }

  if (!text) {
    if (pending.failedAudio) {
      await say(conv, settings, "Não consegui ouvir o seu áudio.").catch(() => undefined);
      return handToQueue(conv, session, settings, data, "áudio não pôde ser transcrito");
    }
    if (pending.media) return handToQueue(conv, session, settings, data, "cliente enviou um arquivo");
    return;
  }

  // "Quero falar com um atendente" in the middle of anything: straight to the queue.
  if (state !== "AWAIT_NAME" && state !== "AWAIT_ADDRESS" && ruleIntent(text) === "ATENDENTE") {
    return handToQueue(conv, session, settings, data, "cliente pediu um atendente");
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
        await finish(conv, session, null, data, false);
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
