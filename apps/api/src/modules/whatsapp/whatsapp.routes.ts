import { Router, type Request } from "express";
import { z } from "zod";
import { asyncHandler } from "../../lib/async-handler";
import { requireAuth, requireRole } from "../../middleware/auth";
import { requirePermission } from "../../lib/permissions";
import { PERMISSION, type PhoneLookupDTO } from "@whatsatendende/types";
import { writeAudit } from "../../lib/audit";
import { logger } from "../../lib/logger";
import { prisma } from "../../lib/prisma";
import { Errors } from "../../lib/http-error";
import { canManagerAccessConnection } from "../../lib/connection-access";
import * as service from "./whatsapp.service";
import { resolveTypedNumber } from "../phone-numbers/resolve-number.service";

export const whatsappRouter = Router();

// ---------------------------------------------------------------------------
// WhatsApp Oficial (Cloud API) webhook — public (Meta's servers call these,
// not a logged-in browser), so declared before requireAuth below, same
// pattern as meta.routes.ts's own webhook pair. One shared URL/verify
// handshake serves every OFFICIAL_API connection — see
// verifyAndIngestOfficialWebhook/officialWebhookVerifyTokenExists's own doc
// comments in whatsapp.service.ts for why.
// ---------------------------------------------------------------------------

const officialVerifySchema = z.object({
  "hub.mode": z.string(),
  "hub.verify_token": z.string(),
  "hub.challenge": z.string(),
});

whatsappRouter.get(
  "/oficial/webhook",
  asyncHandler(async (req, res) => {
    const parsed = officialVerifySchema.safeParse(req.query);
    if (!parsed.success) return res.status(400).send("Bad Request");
    if (parsed.data["hub.mode"] === "subscribe" && (await service.officialWebhookVerifyTokenExists(parsed.data["hub.verify_token"]))) {
      return res.status(200).send(parsed.data["hub.challenge"]);
    }
    res.sendStatus(403);
  })
);

whatsappRouter.post(
  "/oficial/webhook",
  asyncHandler(async (req, res) => {
    // Acknowledge immediately — Meta retries aggressively on anything but a
    // fast 200, and processing below never needs to hold up that response.
    res.sendStatus(200);
    try {
      const signature = req.headers["x-hub-signature-256"];
      await service.verifyAndIngestOfficialWebhook(req.rawBody ?? Buffer.alloc(0), typeof signature === "string" ? signature : undefined, req.body);
    } catch (err) {
      logger.error({ err }, "failed to process a WhatsApp Cloud API webhook event");
    }
  })
);

whatsappRouter.use(requireAuth);

// Full list with QR/status — admins see every connection; managers only see
// ones they created or were explicitly granted (see listConnections).
// Deliberately NOT gated by CONEXOES_WHATSAPP_VISUALIZAR — this same list
// feeds the connection pickers in Usuários/Respostas rápidas/Nova conversa
// and the ConnectionFilter used across Dashboard/Gestão/Relatórios, not just
// the Conexões page itself. "Curating" connections (create/edit/delete) is
// the part that's gated below; everyone who can reach this role pair needs
// to be able to see the list to pick from it.
whatsappRouter.get(
  "/connections",
  requireRole("ADMIN", "MANAGER"),
  asyncHandler(async (req, res) => {
    res.json(await service.listConnections(req.auth!));
  })
);

const colorSchema = z.string().regex(/^#[0-9A-Fa-f]{6}$/);
// Present (and required) only when creating/editing a WhatsApp Oficial
// (Cloud API) connection — see PROMPT: "entra no mesmo formato que a
// conexão pelo QRCode". A QRCODE connection never sends this object at all.
const officialSchema = z.object({
  phoneNumberId: z.string().trim().min(1),
  wabaId: z.string().trim().min(1),
  accessToken: z.string().trim().min(1),
  appSecret: z.string().trim().min(1).optional(),
  webhookVerifyToken: z.string().trim().min(1).optional(),
});
const officialPatchSchema = officialSchema.extend({ accessToken: z.string().trim().min(1).optional() });
const createSchema = z.object({ name: z.string().trim().min(1).max(60), color: colorSchema.optional(), official: officialSchema.optional() });
const updateSchema = z.object({ name: z.string().trim().min(1).max(60).optional(), color: colorSchema.optional(), workScheduleId: z.string().uuid().nullable().optional(), deviceReplyTimeoutMinutes: z.number().int().min(1).max(1440).nullable().optional(), official: officialPatchSchema.optional() });

// A MANAGER may only manage (update/delete/connect/disconnect) a connection
// they created themselves or were explicitly granted "view/edit" on — see
// PROMPT: "somente nas conexões que foram cadastradas pelos gestores" (plus
// whatever an admin additionally designates). ADMIN is never restricted.
async function requireManagerCanManageConnection(req: Request): Promise<void> {
  if (req.auth!.role !== "MANAGER") return;
  if (!(await canManagerAccessConnection(req.auth!.userId, req.params.id, "manage"))) {
    throw Errors.forbidden("Voce nao tem permissao para gerenciar esta conexao");
  }
}

whatsappRouter.post(
  "/connections",
  requirePermission(PERMISSION.CONEXOES_GERENCIAR),
  requirePermission(PERMISSION.CONEXOES_WHATSAPP_ADICIONAR),
  asyncHandler(async (req, res) => {
    const { name, color, official } = createSchema.parse(req.body);
    const connection = await service.createConnection(name, color, req.auth!.userId, official);
    await writeAudit({
      userId: req.auth!.userId,
      action: "WHATSAPP_CONNECTION_CREATED",
      entity: "WhatsAppConnection",
      entityId: connection.id,
      ipAddress: req.ip ?? null,
      // Never audit-log the raw secrets themselves.
      metadata: { name, connectionMode: official ? "OFFICIAL_API" : "QRCODE" },
    });
    res.status(201).json(connection);
  })
);

whatsappRouter.patch(
  "/connections/:id",
  requirePermission(PERMISSION.CONEXOES_GERENCIAR),
  requirePermission(PERMISSION.CONEXOES_WHATSAPP_EDITAR),
  asyncHandler(async (req, res) => {
    await requireManagerCanManageConnection(req);
    const patch = updateSchema.parse(req.body);
    const connection = await service.updateConnection(req.params.id, patch);
    await writeAudit({
      userId: req.auth!.userId,
      action: "WHATSAPP_CONNECTION_UPDATED",
      entity: "WhatsAppConnection",
      entityId: connection.id,
      ipAddress: req.ip ?? null,
      // Never audit-log the raw secrets themselves — just which fields changed.
      metadata: { name: patch.name, color: patch.color, workScheduleId: patch.workScheduleId, deviceReplyTimeoutMinutes: patch.deviceReplyTimeoutMinutes, officialFieldsChanged: patch.official ? Object.keys(patch.official) : undefined },
    });
    res.json(connection);
  })
);

whatsappRouter.delete(
  "/connections/:id",
  requirePermission(PERMISSION.CONEXOES_GERENCIAR),
  requirePermission(PERMISSION.CONEXOES_WHATSAPP_EXCLUIR),
  asyncHandler(async (req, res) => {
    await requireManagerCanManageConnection(req);
    await service.deleteConnection(req.params.id);
    await writeAudit({ userId: req.auth!.userId, action: "WHATSAPP_CONNECTION_DELETED", entity: "WhatsAppConnection", entityId: req.params.id, ipAddress: req.ip ?? null });
    res.status(204).end();
  })
);

const connectSchema = z.object({ phoneNumber: z.string().trim().regex(/^\d{8,15}$/).optional() });

// Atendimento's Grupos tab for this number — administrators only: it decides what every attendant of it sees.
const groupsSchema = z.object({ enabled: z.boolean() });
whatsappRouter.patch(
  "/connections/:id/groups",
  requireRole("ADMIN"),
  asyncHandler(async (req, res) => {
    const { enabled } = groupsSchema.parse(req.body);
    const connection = await service.setConnectionGroupsEnabled(req.params.id, enabled);
    await writeAudit({
      userId: req.auth!.userId,
      action: enabled ? "CONNECTION_GROUPS_ENABLED" : "CONNECTION_GROUPS_DISABLED",
      entity: "WhatsAppConnection",
      entityId: connection.id,
      ipAddress: req.ip ?? null,
      metadata: { name: connection.name },
    });
    res.json(connection);
  })
);

whatsappRouter.post(
  "/connections/:id/connect",
  requirePermission(PERMISSION.CONEXOES_GERENCIAR),
  requirePermission(PERMISSION.CONEXOES_WHATSAPP_EDITAR),
  asyncHandler(async (req, res) => {
    await requireManagerCanManageConnection(req);
    // Connecting (QR/pairing-code generation, then the real handshake) takes
    // seconds — the client polls GET /connections (and listens for the
    // whatsapp:status socket event) rather than blocking this request on the
    // whole flow. phoneNumber, when given, requests a WhatsApp-Web-style
    // pairing code instead of a QR code — see PROMPT: "conexão... também
    // poderá ser feito via código".
    const { phoneNumber } = connectSchema.parse(req.body ?? {});
    service.connect(req.params.id, phoneNumber).catch((err) => logger.error({ err }, "whatsapp connect failed"));
    await writeAudit({ userId: req.auth!.userId, action: "WHATSAPP_CONNECT_REQUESTED", entity: "WhatsAppConnection", entityId: req.params.id, ipAddress: req.ip ?? null, metadata: { viaPairingCode: Boolean(phoneNumber) } });
    res.status(202).json(await service.getConnectionSummary(req.params.id));
  })
);

whatsappRouter.post(
  "/connections/:id/disconnect",
  requirePermission(PERMISSION.CONEXOES_GERENCIAR),
  requirePermission(PERMISSION.CONEXOES_WHATSAPP_EDITAR),
  asyncHandler(async (req, res) => {
    await requireManagerCanManageConnection(req);
    await service.disconnect(req.params.id);
    await writeAudit({ userId: req.auth!.userId, action: "WHATSAPP_DISCONNECTED", entity: "WhatsAppConnection", entityId: req.params.id, ipAddress: req.ip ?? null });
    res.json(await service.getConnectionSummary(req.params.id));
  })
);

whatsappRouter.post(
  "/connections/:id/reconnect",
  requirePermission(PERMISSION.CONEXOES_GERENCIAR),
  requirePermission(PERMISSION.CONEXOES_WHATSAPP_EDITAR),
  asyncHandler(async (req, res) => {
    await requireManagerCanManageConnection(req);
    await service.disconnect(req.params.id);
    service.connect(req.params.id).catch((err) => logger.error({ err }, "whatsapp reconnect failed"));
    await writeAudit({ userId: req.auth!.userId, action: "WHATSAPP_RECONNECT_REQUESTED", entity: "WhatsAppConnection", entityId: req.params.id, ipAddress: req.ip ?? null });
    res.status(202).json(await service.getConnectionSummary(req.params.id));
  })
);

// ADMIN-only editor for a MANAGER's per-connection access — see PROMPT:
// "no acesso do administrador, poderá designar qual conexão os gestores
// poderão ver/editar e também poderão receber novas conversas". Lives here
// (rather than in the users module) since it's fundamentally about
// WhatsAppConnection access, mirroring where connect/disconnect/etc. live.
whatsappRouter.get(
  "/managers/:userId/access",
  requireRole("ADMIN"),
  asyncHandler(async (req, res) => {
    res.json(await service.listConnectionAccessForManager(req.params.userId));
  })
);

const accessEntrySchema = z.object({
  whatsappConnectionId: z.string().uuid(),
  canManage: z.boolean(),
  canReceiveConversations: z.boolean(),
});
const setAccessSchema = z.object({ entries: z.array(accessEntrySchema).max(500) });

whatsappRouter.put(
  "/managers/:userId/access",
  requireRole("ADMIN"),
  asyncHandler(async (req, res) => {
    const { entries } = setAccessSchema.parse(req.body);
    await service.setConnectionAccessForManager(req.params.userId, entries);
    await writeAudit({
      userId: req.auth!.userId,
      action: "MANAGER_CONNECTION_ACCESS_UPDATED",
      entity: "User",
      entityId: req.params.userId,
      ipAddress: req.ip ?? null,
      metadata: { entries },
    });
    res.json(await service.listConnectionAccessForManager(req.params.userId));
  })
);

// Device contacts, for "start a new conversation" in Atendimento — see
// PROMPT: "adicionar uma nova conversa através dos contatos salvos no
// celular de cada instância". An agent may only browse their own
// connection's contacts; managers/admins (who can attend any connection)
// may browse any.
whatsappRouter.get(
  "/connections/:id/contacts",
  asyncHandler(async (req, res) => {
    if (req.auth!.role === "AGENT") {
      const agent = await prisma.user.findUnique({ where: { id: req.auth!.userId }, select: { whatsappConnectionId: true } });
      if (agent?.whatsappConnectionId !== req.params.id) throw Errors.forbidden("Voce so pode ver os contatos da sua propria conexao");
    }
    res.json(await service.listContacts(req.params.id));
  })
);

// Loads the phone's address book on demand — it also runs by itself every
// Monday 00:00 (lib/contacts-sync.ts), this is the admin's manual trigger.
whatsappRouter.post(
  "/connections/:id/sync-contacts",
  requirePermission(PERMISSION.CONEXOES_GERENCIAR),
  requirePermission(PERMISSION.CONEXOES_WHATSAPP_EDITAR),
  asyncHandler(async (req, res) => {
    const result = await service.syncDeviceContacts(req.params.id);
    await writeAudit({
      userId: req.auth!.userId,
      action: "WHATSAPP_CONTACTS_SYNCED",
      entity: "WhatsAppConnection",
      entityId: req.params.id,
      ipAddress: req.ip ?? null,
      metadata: { count: result.count, created: result.created },
    });
    res.json({ count: result.count, created: result.created, syncedAt: result.syncedAt.toISOString() });
  })
);

const lookupNumberSchema = z.object({ phone: z.string().min(8) });

// One-off "does this number exist on WhatsApp" check for the "Novo número"
// tab in Nova conversa — same access scope as /contacts above, but a
// single bounded server query instead of the linked phone's address book.
whatsappRouter.get(
  "/connections/:id/lookup-number",
  asyncHandler(async (req, res) => {
    if (req.auth!.role === "AGENT") {
      const agent = await prisma.user.findUnique({ where: { id: req.auth!.userId }, select: { whatsappConnectionId: true } });
      if (agent?.whatsappConnectionId !== req.params.id) throw Errors.forbidden("Voce so pode usar a sua propria conexao");
    }
    const { phone } = lookupNumberSchema.parse(req.query);
    // The typed number goes through Configurações › Números de telefone (DDI padrão, 9 a mais) before it is
    // asked about; what comes back is the number WhatsApp itself knows, which is what the conversation will use.
    const result = await resolveTypedNumber(req.params.id, phone);
    res.json({
      exists: result.exists,
      phone: result.exists ? result.phone : null,
      normalizedPhone: result.normalized,
      unverifiable: result.unverifiable,
      checkedByConnectionName: result.checkedByConnectionName,
    } satisfies PhoneLookupDTO);
  })
);
