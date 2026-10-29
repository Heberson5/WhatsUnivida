import { Router } from "express";
import rateLimit from "express-rate-limit";
import { z } from "zod";
import { PERMISSION, SMS_PROVIDERS, type SmsProviderId } from "@whatsatendende/types";
import { asyncHandler } from "../../lib/async-handler";
import { requireAuth } from "../../middleware/auth";
import { requirePermission } from "../../lib/permissions";
import { writeAudit } from "../../lib/audit";
import * as service from "./sms.service";

/** Configurações › SMS. */
export const smsRouter = Router();
smsRouter.use(requireAuth);

const settings = requirePermission(PERMISSION.CONFIGURACOES_GERENCIAR);
const providerIds = Object.keys(SMS_PROVIDERS) as [SmsProviderId, ...SmsProviderId[]];

// Each test is a real, paid SMS.
const testLimiter = rateLimit({ windowMs: 60_000, limit: 5, standardHeaders: true, legacyHeaders: false });

/** Whether the "avisar por SMS" option can show — any schedule editor asks this. */
smsRouter.get(
  "/availability",
  asyncHandler(async (_req, res) => {
    res.json(await service.availability());
  })
);

smsRouter.get(
  "/",
  settings,
  requirePermission(PERMISSION.CONFIGURACOES_SMS_VISUALIZAR),
  asyncHandler(async (_req, res) => {
    res.json(await service.getMaskedSettings());
  })
);

smsRouter.put(
  "/",
  settings,
  requirePermission(PERMISSION.CONFIGURACOES_SMS_EDITAR),
  asyncHandler(async (req, res) => {
    const body = z
      .object({ enabled: z.boolean(), provider: z.enum(providerIds).nullable(), config: z.record(z.string().max(4000)).default({}) })
      .parse(req.body ?? {});
    const saved = await service.saveSettings(body);
    await writeAudit({ userId: req.auth!.userId, action: "SETTINGS_SMS_UPDATED", entity: "SystemSetting", entityId: "sms", ipAddress: req.ip ?? null, metadata: { provider: body.provider, enabled: body.enabled } });
    res.json(saved);
  })
);

smsRouter.post(
  "/test",
  settings,
  requirePermission(PERMISSION.CONFIGURACOES_SMS_EDITAR),
  testLimiter,
  asyncHandler(async (req, res) => {
    const { phone } = z.object({ phone: z.string().min(8, "Informe o celular") }).parse(req.body ?? {});
    const result = await service.sendTest(phone).finally(() =>
      writeAudit({ userId: req.auth!.userId, action: "SETTINGS_SMS_TEST_SENT", entity: "SystemSetting", entityId: "sms", ipAddress: req.ip ?? null, metadata: { phone } })
    );
    res.json(result);
  })
);
