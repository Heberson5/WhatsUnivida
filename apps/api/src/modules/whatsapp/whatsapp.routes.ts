import { Router, type Request } from "express";
import { z } from "zod";
import { asyncHandler } from "../../lib/async-handler";
import { requireAuth, requireRole } from "../../middleware/auth";
import { requirePermission } from "../../lib/permissions";
import { PERMISSION } from "@whatsunivida/types";
import { writeAudit } from "../../lib/audit";
import { logger } from "../../lib/logger";
import { prisma } from "../../lib/prisma";
import { Errors } from "../../lib/http-error";
import { canManagerAccessConnection } from "../../lib/connection-access";
import * as service from "./whatsapp.service";

export const whatsappRouter = Router();
whatsappRouter.use(requireAuth);

// Full list with QR/status — admins see every connection; managers only see
// ones they created or were explicitly granted (see listConnections).
whatsappRouter.get(
  "/connections",
  requireRole("ADMIN", "MANAGER"),
  asyncHandler(async (req, res) => {
    res.json(await service.listConnections(req.auth!));
  })
);

const colorSchema = z.string().regex(/^#[0-9A-Fa-f]{6}$/);
const createSchema = z.object({ name: z.string().trim().min(1).max(60), color: colorSchema.optional() });
const updateSchema = z.object({ name: z.string().trim().min(1).max(60).optional(), color: colorSchema.optional() });

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
  requirePermission(PERMISSION.CONFIGURACOES_GERENCIAR),
  asyncHandler(async (req, res) => {
    const { name, color } = createSchema.parse(req.body);
    const connection = await service.createConnection(name, color, req.auth!.userId);
    await writeAudit({ userId: req.auth!.userId, action: "WHATSAPP_CONNECTION_CREATED", entity: "WhatsAppConnection", entityId: connection.id, ipAddress: req.ip ?? null, metadata: { name } });
    res.status(201).json(connection);
  })
);

whatsappRouter.patch(
  "/connections/:id",
  requirePermission(PERMISSION.CONFIGURACOES_GERENCIAR),
  asyncHandler(async (req, res) => {
    await requireManagerCanManageConnection(req);
    const patch = updateSchema.parse(req.body);
    const connection = await service.updateConnection(req.params.id, patch);
    await writeAudit({ userId: req.auth!.userId, action: "WHATSAPP_CONNECTION_UPDATED", entity: "WhatsAppConnection", entityId: connection.id, ipAddress: req.ip ?? null, metadata: patch });
    res.json(connection);
  })
);

whatsappRouter.delete(
  "/connections/:id",
  requirePermission(PERMISSION.CONFIGURACOES_GERENCIAR),
  asyncHandler(async (req, res) => {
    await requireManagerCanManageConnection(req);
    await service.deleteConnection(req.params.id);
    await writeAudit({ userId: req.auth!.userId, action: "WHATSAPP_CONNECTION_DELETED", entity: "WhatsAppConnection", entityId: req.params.id, ipAddress: req.ip ?? null });
    res.status(204).end();
  })
);

const connectSchema = z.object({ phoneNumber: z.string().trim().regex(/^\d{8,15}$/).optional() });

whatsappRouter.post(
  "/connections/:id/connect",
  requirePermission(PERMISSION.CONFIGURACOES_GERENCIAR),
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
  requirePermission(PERMISSION.CONFIGURACOES_GERENCIAR),
  asyncHandler(async (req, res) => {
    await requireManagerCanManageConnection(req);
    await service.disconnect(req.params.id);
    await writeAudit({ userId: req.auth!.userId, action: "WHATSAPP_DISCONNECTED", entity: "WhatsAppConnection", entityId: req.params.id, ipAddress: req.ip ?? null });
    res.json(await service.getConnectionSummary(req.params.id));
  })
);

whatsappRouter.post(
  "/connections/:id/reconnect",
  requirePermission(PERMISSION.CONFIGURACOES_GERENCIAR),
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
