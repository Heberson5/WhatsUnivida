import path from "node:path";
import fs from "node:fs";
import { randomUUID } from "node:crypto";
import type { MessageTemplateButton } from "@whatsatendende/types";
import { prisma } from "../../lib/prisma";
import { env } from "../../config/env";
import { logger } from "../../lib/logger";
import { Errors } from "../../lib/http-error";
import { decryptSecret } from "../../lib/crypto";

const UPLOAD_SUBDIR = path.join(env.UPLOAD_DIR, "message-templates");
fs.mkdirSync(UPLOAD_SUBDIR, { recursive: true });

const GRAPH_API_BASE_URL = "https://graph.facebook.com/v20.0";

const EXT_BY_MIME: Record<string, string> = {
  "image/jpeg": ".jpg",
  "image/png": ".png",
  "video/mp4": ".mp4",
  "application/pdf": ".pdf",
};

export interface CreateTemplateInput {
  name: string;
  category: "MARKETING" | "UTILITY" | "AUTHENTICATION";
  language: string;
  headerType: "NONE" | "TEXT" | "IMAGE" | "VIDEO" | "DOCUMENT";
  headerText?: string;
  bodyText: string;
  footerText?: string;
  buttons?: MessageTemplateButton[];
  whatsappConnectionId: string;
}

export interface HeaderSampleFile {
  buffer: Buffer;
  originalname: string;
  mimetype: string;
}

const templateInclude = { whatsappConnection: { select: { name: true } } } as const;

export async function listTemplates(filter: { whatsappConnectionId?: string; category?: string; status?: string }) {
  return prisma.messageTemplate.findMany({
    where: {
      whatsappConnectionId: filter.whatsappConnectionId,
      category: filter.category as never,
      status: filter.status as never,
    },
    include: templateInclude,
    orderBy: { createdAt: "desc" },
  });
}

export async function getTemplate(id: string) {
  const row = await prisma.messageTemplate.findUnique({ where: { id }, include: templateInclude });
  if (!row) throw Errors.notFound("Template nao encontrado");
  return row;
}

async function getOfficialConnectionOrThrow(whatsappConnectionId: string) {
  const connection = await prisma.whatsAppConnection.findUnique({ where: { id: whatsappConnectionId } });
  if (!connection) throw Errors.notFound("Conexao nao encontrada");
  if (connection.connectionMode !== "OFFICIAL_API" || !connection.wabaId || !connection.accessToken) {
    throw Errors.badRequest("Templates so podem ser cadastrados em conexoes WhatsApp Oficial com credenciais configuradas");
  }
  return connection;
}

/**
 * Meta's Resumable Upload API — the only way to attach a sample media file
 * to a template submission (distinct from the regular /media endpoint used
 * to send messages). Two round trips: start a session scoped to this Meta
 * App, then upload the bytes to get back the header_handle the template
 * creation call needs. See PROMPT: "tem que ter a opção de incluir anexo
 * (imagem, documento ou vídeo)".
 */
async function uploadResumableMedia(appId: string, accessToken: string, file: HeaderSampleFile): Promise<string> {
  const startRes = await fetch(`${GRAPH_API_BASE_URL}/${appId}/uploads?file_length=${file.buffer.length}&file_type=${encodeURIComponent(file.mimetype)}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  const startBody = (await startRes.json().catch(() => null)) as { id?: string; error?: { message?: string } } | null;
  if (!startRes.ok || !startBody?.id) {
    throw new Error(startBody?.error?.message ?? `Falha ao iniciar upload da amostra (HTTP ${startRes.status})`);
  }

  const uploadRes = await fetch(`${GRAPH_API_BASE_URL}/${startBody.id}`, {
    method: "POST",
    headers: { Authorization: `OAuth ${accessToken}`, file_offset: "0" },
    body: new Uint8Array(file.buffer),
  });
  const uploadBody = (await uploadRes.json().catch(() => null)) as { h?: string; error?: { message?: string } } | null;
  if (!uploadRes.ok || !uploadBody?.h) {
    throw new Error(uploadBody?.error?.message ?? `Falha ao enviar a amostra do cabecalho (HTTP ${uploadRes.status})`);
  }
  return uploadBody.h;
}

function buildComponents(input: CreateTemplateInput, headerHandle: string | null): Record<string, unknown>[] {
  const components: Record<string, unknown>[] = [];
  if (input.headerType === "TEXT" && input.headerText) {
    components.push({ type: "HEADER", format: "TEXT", text: input.headerText });
  } else if (input.headerType !== "NONE" && input.headerType !== "TEXT" && headerHandle) {
    components.push({ type: "HEADER", format: input.headerType, example: { header_handle: [headerHandle] } });
  }
  components.push({ type: "BODY", text: input.bodyText });
  if (input.footerText) components.push({ type: "FOOTER", text: input.footerText });
  if (input.buttons?.length) {
    components.push({
      type: "BUTTONS",
      buttons: input.buttons.map((b) =>
        b.type === "URL"
          ? { type: "URL", text: b.text, url: b.url }
          : b.type === "PHONE_NUMBER"
            ? { type: "PHONE_NUMBER", text: b.text, phone_number: b.phoneNumber }
            : { type: "QUICK_REPLY", text: b.text }
      ),
    });
  }
  return components;
}

/**
 * Submits the template to the Graph API — POST /{waba-id}/message_templates.
 * Meta either accepts it (status usually comes back PENDING, sometimes
 * APPROVED instantly for simple ones) or rejects it outright (e.g. a
 * malformed component) with an error in the same response, separate from
 * the async message_template_status_update webhook that arrives later for
 * the normal review outcome — see handleStatusWebhook.
 */
async function submitToMeta(
  connection: { wabaId: string; accessToken: string },
  input: CreateTemplateInput,
  headerHandle: string | null
): Promise<{ metaTemplateId: string; status: "PENDING" | "APPROVED" | "REJECTED" }> {
  const accessToken = decryptSecret(connection.accessToken);
  const res = await fetch(`${GRAPH_API_BASE_URL}/${connection.wabaId}/message_templates`, {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      name: input.name,
      category: input.category,
      language: input.language,
      components: buildComponents(input, headerHandle),
    }),
  });
  const body = (await res.json().catch(() => null)) as { id?: string; status?: string; error?: { message?: string } } | null;
  if (!res.ok || !body?.id) {
    throw Errors.badRequest(body?.error?.message ?? `A Meta recusou o template (HTTP ${res.status})`);
  }
  const status = body.status === "APPROVED" ? "APPROVED" : body.status === "REJECTED" ? "REJECTED" : "PENDING";
  return { metaTemplateId: body.id, status };
}

export async function createTemplate(input: CreateTemplateInput, headerSample?: HeaderSampleFile) {
  if (input.headerType !== "NONE" && input.headerType !== "TEXT" && !headerSample) {
    throw Errors.badRequest("Envie o arquivo de amostra para o tipo de cabecalho escolhido");
  }
  const connection = await getOfficialConnectionOrThrow(input.whatsappConnectionId);

  let headerSampleStorageKey: string | null = null;
  if (headerSample) {
    const ext = EXT_BY_MIME[headerSample.mimetype] ?? path.extname(headerSample.originalname) ?? "";
    headerSampleStorageKey = `${randomUUID()}${ext}`;
    fs.writeFileSync(path.join(UPLOAD_SUBDIR, headerSampleStorageKey), headerSample.buffer);
  }

  const row = await prisma.messageTemplate.create({
    data: {
      name: input.name,
      category: input.category,
      language: input.language,
      headerType: input.headerType,
      headerText: input.headerType === "TEXT" ? input.headerText : null,
      headerSampleFileName: headerSample?.originalname ?? null,
      headerSampleMimeType: headerSample?.mimetype ?? null,
      headerSampleSizeBytes: headerSample?.buffer.length ?? null,
      headerSampleStorageKey,
      bodyText: input.bodyText,
      footerText: input.footerText || null,
      buttons: input.buttons?.length ? (input.buttons as object[]) : undefined,
      whatsappConnectionId: input.whatsappConnectionId,
      status: "DRAFT",
    },
    include: templateInclude,
  });

  // Submission is best-effort at creation time — a failure here leaves the
  // template saved as DRAFT (visible, editable, re-submittable) instead of
  // losing the admin's work, same "never lose what was typed" precedent as
  // every other form in this app.
  try {
    let headerHandle: string | null = null;
    if (headerSample && connection.appId) {
      headerHandle = await uploadResumableMedia(connection.appId, decryptSecret(connection.accessToken!), headerSample);
    } else if (headerSample && !connection.appId) {
      throw new Error("Esta conexao nao tem o App ID da Meta configurado — necessario para enviar a amostra do cabecalho");
    }
    const result = await submitToMeta(connection as { wabaId: string; accessToken: string }, input, headerHandle);
    return prisma.messageTemplate.update({
      where: { id: row.id },
      data: { status: result.status, metaTemplateId: result.metaTemplateId },
      include: templateInclude,
    });
  } catch (err) {
    logger.error({ err, templateId: row.id }, "failed to submit message template to Meta — left as DRAFT");
    return row;
  }
}

export async function deleteTemplate(id: string): Promise<void> {
  const row = await prisma.messageTemplate.findUnique({ where: { id }, include: { whatsappConnection: true } });
  if (!row) throw Errors.notFound("Template nao encontrado");

  if (row.metaTemplateId && row.whatsappConnection.wabaId && row.whatsappConnection.accessToken) {
    const accessToken = decryptSecret(row.whatsappConnection.accessToken);
    await fetch(`${GRAPH_API_BASE_URL}/${row.whatsappConnection.wabaId}/message_templates?name=${encodeURIComponent(row.name)}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${accessToken}` },
    }).catch((err) => logger.error({ err, templateId: id }, "failed to delete template on Meta — deleting local record anyway"));
  }

  if (row.headerSampleStorageKey) {
    fs.rm(path.join(UPLOAD_SUBDIR, row.headerSampleStorageKey), { force: true }, () => undefined);
  }
  await prisma.messageTemplate.delete({ where: { id } });
}

/**
 * Handles the async message_template_status_update webhook event — Meta's
 * review outcome arrives here, separate from (and usually much later than)
 * submitToMeta's immediate response. See whatsapp.service.ts's
 * verifyAndIngestOfficialWebhook, which routes this event type here.
 */
export async function handleStatusWebhook(event: { message_template_id: string; event: string; reason?: string }): Promise<void> {
  const status = mapMetaEventToStatus(event.event);
  if (!status) {
    logger.warn({ event: event.event }, "unrecognized message_template_status_update event — ignored");
    return;
  }
  const result = await prisma.messageTemplate.updateMany({
    where: { metaTemplateId: event.message_template_id },
    data: { status, rejectionReason: status === "REJECTED" ? (event.reason ?? null) : null },
  });
  if (result.count === 0) {
    logger.warn({ metaTemplateId: event.message_template_id }, "message_template_status_update for an unknown template — ignored");
  }
}

function mapMetaEventToStatus(event: string): "APPROVED" | "REJECTED" | "PAUSED" | "DISABLED" | null {
  switch (event) {
    case "APPROVED":
      return "APPROVED";
    case "REJECTED":
      return "REJECTED";
    case "PAUSED":
      return "PAUSED";
    case "DISABLED":
      return "DISABLED";
    default:
      return null;
  }
}

// Meta lets a business message a customer freely only within 24h of the customer's last message.
const CUSTOMER_WINDOW_MS = 24 * 60 * 60 * 1000;

/** Highest {{n}} placeholder in a template text — how many parameters it needs. */
export function templateParamCount(text: string | null): number {
  return Math.max(0, ...[...(text ?? "").matchAll(/\{\{(\d+)\}\}/g)].map((m) => Number(m[1])));
}

function fill(text: string, params: string[]): string {
  return text.replace(/\{\{(\d+)\}\}/g, (_, n: string) => params[Number(n) - 1] ?? "");
}

/** What the conversation shows for a sent template: header, body and footer with the parameters filled in. */
export function renderTemplateText(template: { headerType: string; headerText: string | null; bodyText: string; footerText: string | null }, headerParams: string[], bodyParams: string[]): string {
  const header = template.headerType === "TEXT" && template.headerText ? `*${fill(template.headerText, headerParams)}*` : null;
  return [header, fill(template.bodyText, bodyParams), template.footerText ? `_${template.footerText}_` : null].filter(Boolean).join("\n\n");
}

/** Whether a free-text reply can still go out on the Cloud API, and which approved templates can be used instead. */
export async function getTemplateContext(conversation: { contactId: string; whatsappConnectionId: string | null }) {
  const connection = conversation.whatsappConnectionId
    ? await prisma.whatsAppConnection.findUnique({ where: { id: conversation.whatsappConnectionId }, select: { connectionMode: true } })
    : null;
  if (connection?.connectionMode !== "OFFICIAL_API") return { official: false, windowOpen: true, windowClosesAt: null, templates: [] };
  const lastInbound = await prisma.message.findFirst({
    where: { direction: "INBOUND", conversation: { contactId: conversation.contactId, whatsappConnectionId: conversation.whatsappConnectionId } },
    orderBy: { createdAt: "desc" },
    select: { createdAt: true },
  });
  const closesAt = lastInbound ? new Date(lastInbound.createdAt.getTime() + CUSTOMER_WINDOW_MS) : null;
  const templates = await prisma.messageTemplate.findMany({
    where: { whatsappConnectionId: conversation.whatsappConnectionId!, status: "APPROVED" },
    include: templateInclude,
    orderBy: { name: "asc" },
  });
  return { official: true, windowOpen: Boolean(closesAt && closesAt > new Date()), windowClosesAt: closesAt?.toISOString() ?? null, templates };
}
