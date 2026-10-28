import { Router } from "express";
import { z } from "zod";
import { PERMISSION } from "@whatsatendende/types";
import { asyncHandler } from "../../lib/async-handler";
import { requireAuth } from "../../middleware/auth";
import { requirePermission } from "../../lib/permissions";
import { writeAudit } from "../../lib/audit";
import { logger } from "../../lib/logger";
import { prisma } from "../../lib/prisma";
import { Errors } from "../../lib/http-error";
import { getMetaSettings } from "../settings/settings.service";
import { processWebhookPayload, verifyWebhookSignature } from "./meta.service";
import { assertWorkScheduleExists } from "../work-schedules/work-schedules.service";

export const metaRouter = Router();

// ---------------------------------------------------------------------------
// Webhook — public (Meta's servers call these, not a logged-in browser), so
// declared before requireAuth below, same pattern as the public routes in
// settings.routes.ts (branding/manifest/maintenance/landing-page).
// ---------------------------------------------------------------------------

const verifySchema = z.object({
  "hub.mode": z.string(),
  "hub.verify_token": z.string(),
  "hub.challenge": z.string(),
});

/** Meta's one-time verification handshake, run when the webhook URL is first registered (or re-verified) in the App Dashboard. */
metaRouter.get(
  "/webhook",
  asyncHandler(async (req, res) => {
    const parsed = verifySchema.safeParse(req.query);
    if (!parsed.success) return res.status(400).send("Bad Request");
    const settings = await getMetaSettings();
    if (parsed.data["hub.mode"] === "subscribe" && settings.webhookVerifyToken && parsed.data["hub.verify_token"] === settings.webhookVerifyToken) {
      return res.status(200).send(parsed.data["hub.challenge"]);
    }
    res.sendStatus(403);
  })
);

const webhookEventSchema = z.object({
  object: z.string().optional(),
  entry: z.array(z.unknown()).optional(),
});

/** Actual message/event delivery — Messenger and Instagram both post here (same Graph API webhook infrastructure). */
metaRouter.post(
  "/webhook",
  asyncHandler(async (req, res) => {
    // Acknowledge immediately — Meta retries aggressively on anything but a
    // fast 200, and processing below never needs to hold up that response.
    res.sendStatus(200);
    try {
      const settings = await getMetaSettings();
      if (settings.appSecret) {
        const signature = req.headers["x-hub-signature-256"];
        if (!req.rawBody || !verifyWebhookSignature(req.rawBody, typeof signature === "string" ? signature : undefined, settings.appSecret)) {
          logger.warn("rejected a Meta webhook event: missing or invalid X-Hub-Signature-256");
          return;
        }
      } else {
        logger.warn("processing a Meta webhook event with no App Secret configured — signature not verified, see Conexões");
      }
      const body = webhookEventSchema.parse(req.body);
      if (!body.entry) return;
      await processWebhookPayload(body.object ?? "page", body.entry as Parameters<typeof processWebhookPayload>[1]);
    } catch (err) {
      logger.error({ err }, "failed to process Meta webhook event");
    }
  })
);

metaRouter.use(requireAuth);

// ---------------------------------------------------------------------------
// MetaConnection CRUD — gated by the CONEXOES_GERENCIAR umbrella alone
// (rather than a per-channel permission): the per-channel permissions
// already gate which Conexões tab is even visible, which is the practical
// point of enforcement for these — see ConexoesPage.tsx.
// ---------------------------------------------------------------------------

metaRouter.get(
  "/connections",
  requirePermission(PERMISSION.CONEXOES_GERENCIAR),
  asyncHandler(async (_req, res) => {
    res.json(await prisma.metaConnection.findMany({ orderBy: { createdAt: "asc" } }));
  })
);

const createConnectionSchema = z.object({
  channel: z.enum(["INSTAGRAM", "MESSENGER"]),
  name: z.string().trim().min(1).max(60),
  // Facebook Page id (MESSENGER) or Instagram Business Account id (INSTAGRAM).
  externalPageId: z.string().trim().min(1).max(120),
  color: z.string().regex(/^#[0-9A-Fa-f]{6}$/).optional(),
});

metaRouter.post(
  "/connections",
  requirePermission(PERMISSION.CONEXOES_GERENCIAR),
  asyncHandler(async (req, res) => {
    const { channel, name, externalPageId, color } = createConnectionSchema.parse(req.body);
    const settings = await getMetaSettings();
    const hasToken = channel === "INSTAGRAM" ? Boolean(settings.igAccessToken) : Boolean(settings.pageAccessToken);
    const connection = await prisma.metaConnection.create({
      data: { channel, name, externalPageId, color, status: hasToken ? "CONNECTED" : "DISCONNECTED" },
    });
    await writeAudit({ userId: req.auth!.userId, action: "META_CONNECTION_CREATED", entity: "MetaConnection", entityId: connection.id, ipAddress: req.ip ?? null, metadata: { channel, name } });
    res.status(201).json(connection);
  })
);

const updateConnectionSchema = z.object({ workScheduleId: z.string().uuid().nullable() });

metaRouter.patch(
  "/connections/:id",
  requirePermission(PERMISSION.CONEXOES_GERENCIAR),
  asyncHandler(async (req, res) => {
    const { workScheduleId } = updateConnectionSchema.parse(req.body);
    if (workScheduleId) await assertWorkScheduleExists(workScheduleId);
    const connection = await prisma.metaConnection.update({ where: { id: req.params.id }, data: { workScheduleId } });
    await writeAudit({ userId: req.auth!.userId, action: "META_CONNECTION_UPDATED", entity: "MetaConnection", entityId: connection.id, ipAddress: req.ip ?? null, metadata: { workScheduleId } });
    res.json(connection);
  })
);

metaRouter.delete(
  "/connections/:id",
  requirePermission(PERMISSION.CONEXOES_GERENCIAR),
  asyncHandler(async (req, res) => {
    // Same reasoning as whatsapp.service.ts's deleteConnection: history must
    // never silently disappear (also enforced at the DB level — see
    // onDelete: Restrict on Contact/Conversation.metaConnection).
    const contactCount = await prisma.contact.count({ where: { metaConnectionId: req.params.id } });
    if (contactCount > 0) {
      throw Errors.badRequest("Esta conexao tem historico de conversas e nao pode ser excluida — o historico e preservado para sempre.");
    }
    await prisma.metaConnection.delete({ where: { id: req.params.id } });
    await writeAudit({ userId: req.auth!.userId, action: "META_CONNECTION_DELETED", entity: "MetaConnection", entityId: req.params.id, ipAddress: req.ip ?? null });
    res.status(204).end();
  })
);
