import { Router } from "express";
import { z } from "zod";
import { OWNER_ALERT_EVENTS, SMS_PROVIDERS, type OwnerAlertEvent, type SmsProviderId } from "@whatsatendende/types";
import { asyncHandler } from "../../lib/async-handler";
import { requireAuth, requireRole } from "../../middleware/auth";
import { writeAudit } from "../../lib/audit";
import { userActionLimiter } from "../../lib/rate-limit";
import * as service from "./owner-alerts.service";

/**
 * Configurações › Avisos do administrador — the Administrador alone, checked by role and not by a permission: this
 * is the one part of Configurações a Gestor must never be given (see owner-alerts.service.ts).
 */
export const ownerAlertsRouter = Router();
ownerAlertsRouter.use(requireAuth, requireRole("ADMIN"));

const eventKeys = Object.keys(OWNER_ALERT_EVENTS) as [OwnerAlertEvent, ...OwnerAlertEvent[]];
const providerIds = Object.keys(SMS_PROVIDERS) as [SmsProviderId, ...SmsProviderId[]];

const schema = z
  .object({
    events: z.record(z.enum(eventKeys), z.boolean()),
    email: z
      .object({
        enabled: z.boolean(),
        host: z.string().max(200),
        port: z.number().int().min(1).max(65535),
        secure: z.boolean(),
        username: z.string().max(200),
        password: z.string().max(500).optional(),
        fromName: z.string().max(100),
        fromEmail: z.union([z.literal(""), z.string().email().max(200)]),
        recipients: z.array(z.string().trim().email().max(200)).max(10),
      })
      .strict(),
    sms: z
      .object({
        enabled: z.boolean(),
        provider: z.enum(providerIds).nullable(),
        config: z.record(z.string().max(500)),
        recipients: z.array(z.string().trim().min(8).max(20)).max(10),
      })
      .strict(),
  })
  .strict();

ownerAlertsRouter.get(
  "/",
  asyncHandler(async (_req, res) => {
    res.json(await service.getOwnerAlerts());
  })
);

ownerAlertsRouter.put(
  "/",
  asyncHandler(async (req, res) => {
    const patch = schema.parse(req.body);
    const saved = await service.saveOwnerAlerts(patch);
    // Never the secrets: only what was switched on and who receives.
    await writeAudit({
      userId: req.auth!.userId,
      action: "OWNER_ALERTS_UPDATED",
      entity: "SystemSetting",
      entityId: "ownerAlerts",
      ipAddress: req.ip ?? null,
      metadata: { events: saved.events, email: { enabled: saved.email.enabled, recipients: saved.email.recipients }, sms: { enabled: saved.sms.enabled, provider: saved.sms.provider, recipients: saved.sms.recipients } },
    });
    res.json(saved);
  })
);

const testLimiter = userActionLimiter({ windowMs: 60_000, limit: 5 });

ownerAlertsRouter.post(
  "/test",
  testLimiter,
  asyncHandler(async (req, res) => {
    const { channel } = z.object({ channel: z.enum(["email", "sms"]) }).parse(req.body);
    res.json(await service.sendOwnerAlertTest(channel));
  })
);
