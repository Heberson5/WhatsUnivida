import { Router, type Request } from "express";
import { z } from "zod";
import { PERMISSION } from "@whatsatendende/types";
import { asyncHandler } from "../../lib/async-handler";
import { requireAuth } from "../../middleware/auth";
import { requirePermission } from "../../lib/permissions";
import { writeAudit } from "../../lib/audit";
import {
  assertAgentCanAccessConversation,
  assertAgentCanReadConversation,
  notifyInterventionNote,
  getConversationOrThrow,
} from "../conversations/conversations.service";
import * as service from "./client-panel.service";
import * as dataSources from "../data-sources/data-sources.service";
import * as birthdays from "../birthdays/birthdays.service";
import * as whatsappService from "../whatsapp/whatsapp.service";

// Mounted next to conversationsRouter (/api/conversations/:id/...): the
// client panel beside the chat (tags, earlier conversations) and internal notes.
export const clientPanelRouter = Router();
clientPanelRouter.use(requireAuth);
const requireAttendanceAccess = requirePermission(PERMISSION.ATENDIMENTO_ACESSAR);

/** Same rule as reading the messages: an AGENT only sees what's theirs (or what they transferred away). */
async function conversationForRead(req: Request) {
  const conversation = await getConversationOrThrow(req.params.id);
  if (req.auth!.role === "AGENT") await assertAgentCanReadConversation(conversation, req.auth!);
  return conversation;
}

/** Writing (tags, notes) needs the conversation to be the AGENT's own; MANAGER/ADMIN can annotate any. */
async function conversationForWrite(req: Request) {
  const conversation = await getConversationOrThrow(req.params.id);
  if (req.auth!.role === "AGENT") assertAgentCanAccessConversation(conversation, req.auth!);
  return conversation;
}

clientPanelRouter.get(
  "/:id/contact-panel",
  asyncHandler(async (req, res) => {
    const conversation = await conversationForRead(req);
    res.json(await service.getContactPanel(conversation.id, conversation.contactId, conversation.contact.firstConversationAt));
  })
);

// "Mostrar mais" under Conversas anteriores.
const previousPageSchema = z.object({ skip: z.coerce.number().int().min(0), take: z.coerce.number().int().min(1).max(20) });

clientPanelRouter.get(
  "/:id/previous-conversations",
  asyncHandler(async (req, res) => {
    const { skip, take } = previousPageSchema.parse(req.query);
    const conversation = await conversationForRead(req);
    res.json(await service.listPreviousConversations(conversation.id, conversation.contactId, skip, take));
  })
);

clientPanelRouter.get(
  "/:id/previous/:previousId",
  asyncHandler(async (req, res) => {
    const conversation = await conversationForRead(req);
    res.json(await service.getPreviousConversation(conversation.contactId, req.params.previousId));
  })
);

const pinnedNoteSchema = z.object({ text: z.string().trim().max(1000).nullable() });
clientPanelRouter.put(
  "/:id/contact-pinned-note",
  requirePermission(PERMISSION.CONTATOS_OBSERVACAO_EDITAR),
  asyncHandler(async (req, res) => {
    const conversation = await conversationForRead(req);
    const { text } = pinnedNoteSchema.parse(req.body);
    await service.setPinnedNote(conversation.contactId, text || null, req.auth!.displayName);
    await writeAudit({
      userId: req.auth!.userId,
      action: "CONTACT_PINNED_NOTE_UPDATED",
      entity: "Contact",
      entityId: conversation.contactId,
      ipAddress: req.ip ?? null,
      metadata: { text: text || null },
    });
    res.json(await service.getContactPanel(conversation.id, conversation.contactId, conversation.contact.firstConversationAt));
  })
);

// Contatos › Contrato: the attendant corrects or fills it in the client panel.
const contractSchema = z.object({ contractNumber: z.string().trim().max(200).nullable() });
clientPanelRouter.put(
  "/:id/contact-contract",
  asyncHandler(async (req, res) => {
    const conversation = await conversationForWrite(req);
    const { contractNumber } = contractSchema.parse(req.body);
    await service.setContractNumber(conversation.contactId, contractNumber || null);
    await writeAudit({
      userId: req.auth!.userId,
      action: "CONTACT_CONTRACT_UPDATED",
      entity: "Contact",
      entityId: conversation.contactId,
      ipAddress: req.ip ?? null,
      metadata: { contractNumber: contractNumber || null },
    });
    res.json(await service.getContactPanel(conversation.id, conversation.contactId, conversation.contact.firstConversationAt));
  })
);

// Contatos › Primeiro nome — how the customer is called ({{primeiro_nome}}); empty goes back to the first word of the name.
const firstNameSchema = z.object({ firstName: z.string().trim().max(60).nullable() });
clientPanelRouter.put(
  "/:id/contact-first-name",
  asyncHandler(async (req, res) => {
    const conversation = await conversationForWrite(req);
    const { firstName } = firstNameSchema.parse(req.body);
    await service.setFirstName(conversation.contactId, firstName || null);
    await writeAudit({
      userId: req.auth!.userId,
      action: "CONTACT_FIRST_NAME_UPDATED",
      entity: "Contact",
      entityId: conversation.contactId,
      ipAddress: req.ip ?? null,
      metadata: { firstName: firstName || null },
    });
    res.json(await service.getContactPanel(conversation.id, conversation.contactId, conversation.contact.firstConversationAt));
  })
);

// Dados do cliente (Fontes de dados): what the active spreadsheet/database knows about this conversation's phone.
clientPanelRouter.get(
  "/:id/client-data",
  asyncHandler(async (req, res) => {
    const conversation = await conversationForRead(req);
    const data = await dataSources.getClientData(conversation, req.auth!.role);
    await dataSources.rememberContractNumber(conversation.contact, data);
    res.json(data);
  })
);

clientPanelRouter.put(
  "/:id/client-data/client",
  asyncHandler(async (req, res) => {
    const conversation = await conversationForWrite(req);
    const { clientKey } = z.object({ clientKey: z.string().min(1).max(200) }).parse(req.body);
    await dataSources.selectClient(conversation, clientKey);
    await writeAudit({ userId: req.auth!.userId, action: "CLIENT_DATA_CLIENT_SELECTED", entity: "Conversation", entityId: conversation.id, ipAddress: req.ip ?? null, metadata: { clientKey } });
    const data = await dataSources.getClientData({ ...conversation, dataClientKey: clientKey }, req.auth!.role);
    await dataSources.rememberContractNumber(conversation.contact, data);
    res.json(data);
  })
);

clientPanelRouter.post(
  "/:id/client-data/reveal",
  requirePermission(PERMISSION.CLIENTE_DADOS_SENSIVEIS_VER),
  asyncHandler(async (req, res) => {
    const conversation = await conversationForRead(req);
    const { column } = z.object({ column: z.string().min(1).max(120) }).parse(req.body);
    const value = await dataSources.revealColumn(conversation, column);
    await writeAudit({
      userId: req.auth!.userId,
      action: "CLIENT_SENSITIVE_DATA_REVEALED",
      entity: "Conversation",
      entityId: conversation.id,
      ipAddress: req.ip ?? null,
      metadata: { column, contactPhone: conversation.contact.phone },
    });
    res.json({ column, value });
  })
);

clientPanelRouter.post(
  "/:id/client-data/suspension-ack",
  asyncHandler(async (req, res) => {
    const conversation = await conversationForRead(req);
    await dataSources.acknowledgeSuspension(conversation.id);
    await writeAudit({ userId: req.auth!.userId, action: "CLIENT_SUSPENSION_WARNING_SEEN", entity: "Conversation", entityId: conversation.id, ipAddress: req.ip ?? null });
    res.status(204).end();
  })
);

// The attendant started or stopped typing / recording: the customer's WhatsApp shows "digitando…" / "gravando áudio…".
clientPanelRouter.post(
  "/:id/presence",
  asyncHandler(async (req, res) => {
    const conversation = await conversationForWrite(req);
    const { presence } = z.object({ presence: z.enum(["composing", "recording", "paused"]) }).parse(req.body);
    await whatsappService.sendAgentPresence(conversation.id, presence).catch(() => undefined);
    res.status(204).end();
  })
);

// Aniversário do cliente: who of the client's contracts has a birthday today, the message ready, and whether the
// pop-up is still to be shown in this conversation.
clientPanelRouter.get(
  "/:id/birthday",
  asyncHandler(async (req, res) => {
    const conversation = await conversationForRead(req);
    res.json(await birthdays.conversationBirthday(conversation, req.auth!));
  })
);

// Called after the congratulations went out through the normal send — remembered for the year.
clientPanelRouter.post(
  "/:id/birthday/greeted",
  asyncHandler(async (req, res) => {
    const conversation = await conversationForWrite(req);
    const { personKey } = z.object({ personKey: z.string().min(1).max(200) }).parse(req.body);
    await birthdays.markGreeted(conversation, personKey, req.auth!.userId);
    await writeAudit({ userId: req.auth!.userId, action: "BIRTHDAY_GREETING_SENT", entity: "Conversation", entityId: conversation.id, ipAddress: req.ip ?? null, metadata: { personKey } });
    res.status(204).end();
  })
);

// "Agora não": the pop-up doesn't come back in this conversation.
clientPanelRouter.post(
  "/:id/birthday/ack",
  asyncHandler(async (req, res) => {
    const conversation = await conversationForRead(req);
    await birthdays.acknowledge(conversation.id);
    res.status(204).end();
  })
);

clientPanelRouter.post(
  "/:id/client-data/render",
  asyncHandler(async (req, res) => {
    const conversation = await conversationForRead(req);
    const { text } = z.object({ text: z.string().max(4096) }).parse(req.body);
    res.json(await dataSources.renderDataTags(conversation, text, req.auth!.role));
  })
);

// Only tags from Automação › Etiquetas — nobody creates a tag while attending.
const addTagSchema = z.object({ tagId: z.string().uuid() });
clientPanelRouter.post(
  "/:id/contact-tags",
  requireAttendanceAccess,
  asyncHandler(async (req, res) => {
    const conversation = await conversationForWrite(req);
    const { tagId } = addTagSchema.parse(req.body);
    await service.addContactTag(conversation.contactId, tagId, req.auth!.userId);
    await writeAudit({ userId: req.auth!.userId, action: "CONTACT_TAG_ADDED", entity: "Contact", entityId: conversation.contactId, ipAddress: req.ip ?? null, metadata: { tagId } });
    res.status(201).json(await service.getContactPanel(conversation.id, conversation.contactId, conversation.contact.firstConversationAt));
  })
);

clientPanelRouter.delete(
  "/:id/contact-tags/:tagId",
  requireAttendanceAccess,
  asyncHandler(async (req, res) => {
    const conversation = await conversationForWrite(req);
    await service.removeContactTag(conversation.contactId, req.params.tagId);
    await writeAudit({ userId: req.auth!.userId, action: "CONTACT_TAG_REMOVED", entity: "Contact", entityId: conversation.contactId, ipAddress: req.ip ?? null, metadata: { tagId: req.params.tagId } });
    res.json(await service.getContactPanel(conversation.id, conversation.contactId, conversation.contact.firstConversationAt));
  })
);

clientPanelRouter.get(
  "/:id/notes",
  asyncHandler(async (req, res) => {
    const conversation = await conversationForRead(req);
    res.json(await service.listNotes(conversation.id));
  })
);

const noteSchema = z.object({ body: z.string().trim().min(1).max(2000) });
clientPanelRouter.post(
  "/:id/notes",
  asyncHandler(async (req, res) => {
    const conversation = await conversationForWrite(req);
    const { body } = noteSchema.parse(req.body);
    const note = await service.createNote(conversation.id, req.auth!.userId, body);
    await notifyInterventionNote(conversation.id, req.auth!.userId, body);
    await writeAudit({ userId: req.auth!.userId, action: "CONVERSATION_NOTE_CREATED", entity: "Conversation", entityId: conversation.id, ipAddress: req.ip ?? null });
    res.status(201).json(note);
  })
);

export const tagsRouter = Router();
tagsRouter.use(requireAuth);
tagsRouter.get(
  "/",
  asyncHandler(async (_req, res) => {
    res.json(await service.listTags());
  })
);
