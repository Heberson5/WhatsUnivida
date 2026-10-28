import { Router } from "express";
import multer from "multer";
import path from "node:path";
import fs from "node:fs";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { imageSize } from "image-size";
import { Jimp } from "jimp";
import rateLimit from "express-rate-limit";
import { asyncHandler } from "../../lib/async-handler";
import { requireAuth, requireRole } from "../../middleware/auth";
import { requirePermission } from "../../lib/permissions";
import { PERMISSION } from "@whatsatendende/types";
import { writeAudit } from "../../lib/audit";
import { sendMail, sendTemplatedMail, previewTemplatedMail } from "../../lib/mail";
import { env } from "../../config/env";
import * as service from "./settings.service";
import { currentVersion } from "../release-notes/release-notes.service";
import { getPhoneSettings, updatePhoneSettings } from "../phone-numbers/phone-settings.service";

export const settingsRouter = Router();

const brandingAssetDir = path.join(env.UPLOAD_DIR, "branding");
fs.mkdirSync(brandingAssetDir, { recursive: true });

// SVG is intentionally excluded: an uploaded SVG can embed <script>, and
// even though it's only ever rendered via <img src>, that's not a
// guarantee every browser honors — raster formats have no such risk.
const ALLOWED_BRANDING_MIME_TO_EXT: Record<string, string> = {
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/webp": ".webp",
  "image/x-icon": ".ico",
  "image/vnd.microsoft.icon": ".ico",
};

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 2 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (!(file.mimetype in ALLOWED_BRANDING_MIME_TO_EXT)) {
      return cb(new Error("Formato de imagem nao suportado"));
    }
    cb(null, true);
  },
});

const EXT_TO_MIME_TYPE: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/vnd.microsoft.icon",
};

/** Recovers the MIME type of an uploaded branding asset from its stored extension — the manifest's icons[].type needs it, and we only ever store the extension, not the original MIME string. */
function mimeTypeForBrandingAsset(url: string): string {
  return EXT_TO_MIME_TYPE[path.extname(url).toLowerCase()] ?? "image/png";
}

// Public: the login screen needs the logo/colors before the user authenticates.
settingsRouter.get(
  "/branding",
  asyncHandler(async (_req, res) => {
    // The version shown in the menu follows Notas de versão by itself — nobody types it after an update.
    res.json({ ...(await service.getBranding()), appVersion: await currentVersion() });
  })
);

// Public web app manifest — the browser fetches this on its own (from the
// <link rel="manifest"> tag) to decide what to show once the app is
// installed on Android/desktop Chrome/Edge as a home-screen/taskbar icon,
// well before anyone has logged in, so this can never require auth. Built
// live from the current branding settings rather than served as a static
// file so an admin's saved app name/icon takes effect on the very next
// install with no rebuild/redeploy — see PROMPT: "Deve ter nas
// configurações a opção de incluir o ícone e nome do aplicativo".
settingsRouter.get(
  "/manifest.webmanifest",
  asyncHandler(async (_req, res) => {
    const branding = await service.getBranding();
    const name = branding.appName ?? branding.companyName;
    const iconUrl = branding.appIconUrl;
    const iconType = iconUrl ? mimeTypeForBrandingAsset(iconUrl) : "image/png";
    // The raw uploaded icon (often transparent) only ever goes in the "any"
    // entries — Android's own adaptive-icon renderer paints transparent
    // pixels black for "maskable", so that purpose always points at the
    // generated opaque/safe-zone variant instead (falls back to the raw
    // icon for a branding saved before this variant existed).
    const maskableIconUrl = branding.appIconMaskableUrl ?? iconUrl;
    const maskableIconType = branding.appIconMaskableUrl ? "image/png" : iconType;
    res.type("application/manifest+json").json({
      name,
      // Android truncates a long label on the home screen grid — keep it tight.
      short_name: name.slice(0, 12),
      description: "Plataforma de atendimento multiusuário via WhatsApp",
      start_url: "/",
      scope: "/",
      display: "standalone",
      orientation: "portrait-primary",
      background_color: "#F4F6F8",
      theme_color: branding.primaryColor,
      icons: iconUrl
        ? [
            { src: iconUrl, sizes: "192x192", type: iconType, purpose: "any" },
            { src: iconUrl, sizes: "512x512", type: iconType, purpose: "any" },
            { src: maskableIconUrl, sizes: "512x512", type: maskableIconType, purpose: "maskable" },
          ]
        : [
            { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
            { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
            { src: "/icons/icon-maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
          ],
    });
  })
);

// Public, same reasoning as /branding above: the login screen needs to know
// whether maintenance mode is on *before* anyone authenticates, so it can
// show the maintenance screen instead of the normal form for a non-admin.
settingsRouter.get(
  "/maintenance",
  asyncHandler(async (_req, res) => {
    res.json(await service.getMaintenanceSettings());
  })
);

// Public, same reasoning as /branding above: the login screen itself needs
// the logo size/alignment/subtitle before anyone authenticates.
settingsRouter.get(
  "/landing-page",
  asyncHandler(async (_req, res) => {
    res.json(await service.getLandingPageSettings());
  })
);

settingsRouter.use(requireAuth);

const maintenanceSchema = z
  .object({
    enabled: z.boolean().optional(),
    message: z.string().max(500).nullable().optional(),
  })
  .strict();

// ADMIN-only, checked directly via requireRole rather than the configurable
// CONFIGURACOES_GERENCIAR permission — that one's grantable to a MANAGER
// (for WhatsApp connections/branding/email), but toggling this can lock
// every non-admin out of the entire system, so it stays out of that matrix
// entirely (same precedent as the permissions matrix editor itself).
settingsRouter.patch(
  "/maintenance",
  requireRole("ADMIN"),
  asyncHandler(async (req, res) => {
    const patch = maintenanceSchema.parse(req.body ?? {});
    const settings = await service.updateMaintenanceSettings(patch);
    await writeAudit({
      userId: req.auth!.userId,
      action: "SETTINGS_MAINTENANCE_UPDATED",
      entity: "SystemSetting",
      entityId: "maintenance",
      ipAddress: req.ip ?? null,
      metadata: patch,
    });
    res.json(settings);
  })
);

const brandingSchema = z.object({
  companyName: z.string().min(1).optional(),
  primaryColor: z.string().regex(/^#[0-9A-Fa-f]{6}$/).optional(),
  secondaryColor: z.string().regex(/^#[0-9A-Fa-f]{6}$/).optional(),
  // Home-screen label once installed — kept short since Android truncates a
  // long "short_name" on the launcher grid; null clears it back to falling
  // through to companyName.
  appName: z.string().trim().min(1).max(30).nullable().optional(),
  // Free-form version marker (e.g. "1.3.0") — bump it whenever the app
  // icon/name changes to trigger AppUpdateBanner for already-installed
  // users; null/empty clears the notice.
  readReceiptColor: z.string().regex(/^#[0-9A-Fa-f]{6}$/).nullable().optional(),
});

settingsRouter.patch(
  "/branding",
  requirePermission(PERMISSION.CONFIGURACOES_GERENCIAR),
  requirePermission(PERMISSION.CONFIGURACOES_IDENTIDADE_EDITAR),
  asyncHandler(async (req, res) => {
    const patch = brandingSchema.parse(req.body);
    const branding = await service.updateBranding(patch);
    await writeAudit({ userId: req.auth!.userId, action: "SETTINGS_BRANDING_UPDATED", entity: "SystemSetting", entityId: "branding", ipAddress: req.ip ?? null, metadata: patch });
    res.json(branding);
  })
);

settingsRouter.post(
  "/branding/logo",
  requirePermission(PERMISSION.CONFIGURACOES_GERENCIAR),
  requirePermission(PERMISSION.CONFIGURACOES_IDENTIDADE_EDITAR),
  upload.single("file"),
  asyncHandler(async (req, res) => {
    if (!req.file) return res.status(400).json({ error: "BAD_REQUEST", message: "Nenhum arquivo enviado" });
    // The stored extension is derived from the validated MIME type, never
    // from the client-supplied filename — closes off any path/extension trickery at the source.
    const fileName = `logo-${randomUUID()}${ALLOWED_BRANDING_MIME_TO_EXT[req.file.mimetype]}`;
    fs.writeFileSync(path.join(brandingAssetDir, fileName), req.file.buffer);
    const branding = await service.updateBranding({ logoUrl: `/uploads/branding/${fileName}` });
    await writeAudit({ userId: req.auth!.userId, action: "SETTINGS_LOGO_UPLOADED", entity: "SystemSetting", entityId: "branding", ipAddress: req.ip ?? null });
    res.json(branding);
  })
);

// Minimum this app's own manifest.webmanifest ever declares for this icon
// (see the 512x512 "any"/"maskable" entries below) — Chrome's install
// criteria fetches the icon and checks its REAL pixel size against that
// declared size, so an upload smaller than this would make the manifest
// fail installability entirely (no working "Instalar" on Android) even
// though the icon still displays fine everywhere else it's just shown
// smaller. See PROMPT: "no celular não está aparecendo para baixar e
// instalar o app".
const APP_ICON_MIN_SIZE = 512;

// The logo confined to this fraction of the canvas (centered), comfortably
// inside Android's maskable safe zone (spec minimum: an 80%-diameter
// circle) — approved size from the before/after mockups shown to the user.
const MASKABLE_SAFE_ZONE_FRAC = 0.6;

/** Composites the uploaded (often transparent) icon onto an opaque white
 * canvas, logo confined to the safe zone — see BrandingSettings.appIconMaskableUrl. */
async function generateMaskableIcon(sourceBuffer: Buffer): Promise<Buffer> {
  const source = await Jimp.fromBuffer(sourceBuffer);
  const scale = (MASKABLE_SAFE_ZONE_FRAC * APP_ICON_MIN_SIZE) / Math.max(source.width, source.height);
  const resized = source.clone().resize({ w: Math.round(source.width * scale), h: Math.round(source.height * scale) });
  const canvas = new Jimp({ width: APP_ICON_MIN_SIZE, height: APP_ICON_MIN_SIZE, color: 0xffffffff });
  canvas.composite(resized, Math.round((APP_ICON_MIN_SIZE - resized.width) / 2), Math.round((APP_ICON_MIN_SIZE - resized.height) / 2));
  return canvas.getBuffer("image/png");
}

settingsRouter.post(
  "/branding/app-icon",
  requirePermission(PERMISSION.CONFIGURACOES_GERENCIAR),
  requirePermission(PERMISSION.CONFIGURACOES_IDENTIDADE_EDITAR),
  upload.single("file"),
  asyncHandler(async (req, res) => {
    if (!req.file) return res.status(400).json({ error: "BAD_REQUEST", message: "Nenhum arquivo enviado" });

    let width: number | undefined;
    let height: number | undefined;
    try {
      ({ width, height } = imageSize(req.file.buffer));
    } catch {
      return res.status(400).json({ error: "BAD_REQUEST", message: "Não foi possível ler as dimensões dessa imagem" });
    }
    if (!width || !height || width < APP_ICON_MIN_SIZE || height < APP_ICON_MIN_SIZE || width !== height) {
      return res.status(400).json({
        error: "BAD_REQUEST",
        message: `O ícone precisa ser uma imagem quadrada de pelo menos ${APP_ICON_MIN_SIZE}x${APP_ICON_MIN_SIZE} pixels (enviada: ${width ?? "?"}x${height ?? "?"}) — abaixo disso o Android recusa a instalação do aplicativo.`,
      });
    }

    const fileName = `app-icon-${randomUUID()}${ALLOWED_BRANDING_MIME_TO_EXT[req.file.mimetype]}`;
    fs.writeFileSync(path.join(brandingAssetDir, fileName), req.file.buffer);

    const maskableFileName = `app-icon-maskable-${randomUUID()}.png`;
    const maskableBuffer = await generateMaskableIcon(req.file.buffer);
    fs.writeFileSync(path.join(brandingAssetDir, maskableFileName), maskableBuffer);

    const branding = await service.updateBranding({
      appIconUrl: `/uploads/branding/${fileName}`,
      appIconMaskableUrl: `/uploads/branding/${maskableFileName}`,
    });
    await writeAudit({ userId: req.auth!.userId, action: "SETTINGS_APP_ICON_UPLOADED", entity: "SystemSetting", entityId: "branding", ipAddress: req.ip ?? null });
    res.json(branding);
  })
);

// Own logo/cor/nome for the PowerPoint cover and PDF/Excel reports —
// independent from Identidade visual above (a company might want its
// in-app theme to differ from what goes out in an exported deck/report).
// See PROMPT: "Na guia Exportações... Não é para ter vínculo com a
// Identidade Visual".
const exportBrandingSchema = z.object({
  companyName: z.string().min(1).optional(),
  primaryColor: z.string().regex(/^#[0-9A-Fa-f]{6}$/).optional(),
});

settingsRouter.get(
  "/export-branding",
  asyncHandler(async (_req, res) => {
    res.json(await service.getExportBranding());
  })
);

settingsRouter.patch(
  "/export-branding",
  requirePermission(PERMISSION.CONFIGURACOES_GERENCIAR),
  requirePermission(PERMISSION.CONFIGURACOES_IDENTIDADE_EDITAR),
  asyncHandler(async (req, res) => {
    const patch = exportBrandingSchema.parse(req.body);
    const branding = await service.updateExportBranding(patch);
    await writeAudit({ userId: req.auth!.userId, action: "SETTINGS_EXPORT_BRANDING_UPDATED", entity: "SystemSetting", entityId: "exportBranding", ipAddress: req.ip ?? null, metadata: patch });
    res.json(branding);
  })
);

settingsRouter.post(
  "/export-branding/logo",
  requirePermission(PERMISSION.CONFIGURACOES_GERENCIAR),
  requirePermission(PERMISSION.CONFIGURACOES_IDENTIDADE_EDITAR),
  upload.single("file"),
  asyncHandler(async (req, res) => {
    if (!req.file) return res.status(400).json({ error: "BAD_REQUEST", message: "Nenhum arquivo enviado" });
    const fileName = `export-logo-${randomUUID()}${ALLOWED_BRANDING_MIME_TO_EXT[req.file.mimetype]}`;
    fs.writeFileSync(path.join(brandingAssetDir, fileName), req.file.buffer);
    const branding = await service.updateExportBranding({ logoUrl: `/uploads/branding/${fileName}` });
    await writeAudit({ userId: req.auth!.userId, action: "SETTINGS_EXPORT_LOGO_UPLOADED", entity: "SystemSetting", entityId: "exportBranding", ipAddress: req.ip ?? null });
    res.json(branding);
  })
);

// Standalone (not layered under CONFIGURACOES_GERENCIAR) — Landing Page is
// its own top-level menu, not a Configurações tab. See PROMPT: "planeje um
// novo menu chamado landing page".
const landingPageSchema = z.object({
  loginLogoSizePx: z.number().int().min(32).max(200).optional(),
  loginLogoAlign: z.enum(["center", "left"]).optional(),
  loginSubtitle: z.string().trim().max(120).nullable().optional(),
  menuOrder: z.array(z.string()).optional(),
  menuItems: z.record(z.string(), z.object({ label: z.string().trim().max(30).optional(), icon: z.string().optional() })).optional(),
  pageTitles: z.record(z.string(), z.string().trim().max(40)).optional(),
});

settingsRouter.patch(
  "/landing-page",
  requirePermission(PERMISSION.LANDING_PAGE_EDITAR),
  asyncHandler(async (req, res) => {
    const patch = landingPageSchema.parse(req.body);
    const settings = await service.updateLandingPageSettings(patch);
    await writeAudit({ userId: req.auth!.userId, action: "SETTINGS_LANDING_PAGE_UPDATED", entity: "SystemSetting", entityId: "landingPage", ipAddress: req.ip ?? null, metadata: patch });
    res.json(settings);
  })
);

settingsRouter.post(
  "/branding/favicon",
  requirePermission(PERMISSION.CONFIGURACOES_GERENCIAR),
  requirePermission(PERMISSION.CONFIGURACOES_IDENTIDADE_EDITAR),
  upload.single("file"),
  asyncHandler(async (req, res) => {
    if (!req.file) return res.status(400).json({ error: "BAD_REQUEST", message: "Nenhum arquivo enviado" });
    const fileName = `favicon-${randomUUID()}${ALLOWED_BRANDING_MIME_TO_EXT[req.file.mimetype]}`;
    fs.writeFileSync(path.join(brandingAssetDir, fileName), req.file.buffer);
    const branding = await service.updateBranding({ faviconUrl: `/uploads/branding/${fileName}` });
    await writeAudit({ userId: req.auth!.userId, action: "SETTINGS_FAVICON_UPLOADED", entity: "SystemSetting", entityId: "branding", ipAddress: req.ip ?? null });
    res.json(branding);
  })
);

const businessSettingsSchema = z
  .object({
    inactivityTimeoutMinutes: z.number().int().positive().max(1440).optional(),
    autoCloseEnabled: z.boolean().optional(),
    reopenTarget: z.enum(["QUEUE", "LAST_AGENT"]).optional(),
    uploadMaxSizeMb: z.number().int().positive().max(100).optional(),
    notificationSoundEnabled: z.boolean().optional(),
    businessHours: z
      .object({ start: z.string(), end: z.string(), days: z.array(z.number().int().min(0).max(6)) })
      .nullable()
      .optional(),
    greetingMessage: z.string().max(1000).nullable().optional(),
    awayMessage: z.string().max(1000).nullable().optional(),
  })
  // Rejects unknown keys — this is an admin-only endpoint, but without
  // .strict() it would still happily persist arbitrary attacker-shaped JSON
  // into system_settings.
  .strict();

// Any authenticated user can read these (not just an admin): the client
// needs inactivityTimeoutMinutes to enforce the idle-logout timer for
// every logged-in session, not only for whoever can edit it. Nothing in
// here is sensitive — see EmailSettings for the one that actually is,
// which stays admin-gated. PATCH below is still admin-only.
settingsRouter.get(
  "/business",
  asyncHandler(async (_req, res) => {
    res.json(await service.getBusinessSettings());
  })
);

settingsRouter.patch(
  "/business",
  requirePermission(PERMISSION.CONFIGURACOES_GERENCIAR),
  asyncHandler(async (req, res) => {
    const patch = businessSettingsSchema.parse(req.body ?? {});
    const settings = await service.updateBusinessSettings(patch);
    await writeAudit({ userId: req.auth!.userId, action: "SETTINGS_BUSINESS_UPDATED", entity: "SystemSetting", entityId: "business", ipAddress: req.ip ?? null, metadata: patch });
    res.json(settings);
  })
);

// Encerramento por falta de retorno (Respostas › Encerramento): who edits the closing messages edits this rule too.
const noReturnSettingsSchema = z
  .object({
    enabled: z.boolean(),
    reminderMinutes: z.number().int().min(1).max(240),
    closeMinutes: z.number().int().min(1).max(240),
    reminderText: z.string().trim().min(1).max(1000),
    closeText: z.string().trim().min(1).max(1000),
    sendSurvey: z.boolean().default(false),
  })
  .strict();

settingsRouter.get(
  "/no-return",
  asyncHandler(async (_req, res) => {
    res.json(await service.getNoReturnSettings());
  })
);

settingsRouter.put(
  "/no-return",
  requirePermission(PERMISSION.RESPOSTAS_ENCERRAMENTO_EDITAR),
  asyncHandler(async (req, res) => {
    const input = noReturnSettingsSchema.parse(req.body ?? {});
    await service.updateBusinessSettings({
      noReturnEnabled: input.enabled,
      noReturnReminderMinutes: input.reminderMinutes,
      noReturnCloseMinutes: input.closeMinutes,
      noReturnReminderText: input.reminderText,
      noReturnCloseText: input.closeText,
      noReturnSendSurvey: input.sendSurvey,
    });
    await writeAudit({ userId: req.auth!.userId, action: "SETTINGS_NO_RETURN_UPDATED", entity: "SystemSetting", entityId: "business", ipAddress: req.ip ?? null, metadata: input });
    res.json(await service.getNoReturnSettings());
  })
);

// Its own route/permission pair (not folded into the generic /business PATCH
// above) so the new "Fila" tab's own CONFIGURACOES_FILA_EDITAR permission
// governs just this one field — same SystemSetting "business" bag
// underneath, read back through the same GET /business any authenticated
// user already has.
const queueSettingsSchema = z
  .object({
    queueReminderIntervalMinutes: z.number().int().min(1).max(60).optional(),
    noReplyWarningMinutes: z.number().int().min(1).max(240).optional(),
    noReplyDangerMinutes: z.number().int().min(1).max(240).optional(),
    queueWarningMinutes: z.number().int().min(1).max(240).optional(),
    queueDangerMinutes: z.number().int().min(1).max(240).optional(),
    typingToCustomer: z.boolean().optional(),
    typingFromCustomer: z.boolean().optional(),
  })
  .strict()
  .refine((s) => !s.noReplyWarningMinutes || !s.noReplyDangerMinutes || s.noReplyDangerMinutes > s.noReplyWarningMinutes, {
    message: "O alerta vermelho de sem resposta precisa vir depois do amarelo",
  })
  .refine((s) => !s.queueWarningMinutes || !s.queueDangerMinutes || s.queueDangerMinutes > s.queueWarningMinutes, {
    message: "O alerta vermelho da fila precisa vir depois do amarelo",
  });

settingsRouter.patch(
  "/queue",
  requirePermission(PERMISSION.CONFIGURACOES_GERENCIAR),
  requirePermission(PERMISSION.CONFIGURACOES_FILA_EDITAR),
  asyncHandler(async (req, res) => {
    const patch = queueSettingsSchema.parse(req.body ?? {});
    const settings = await service.updateBusinessSettings(patch);
    await writeAudit({ userId: req.auth!.userId, action: "SETTINGS_QUEUE_UPDATED", entity: "SystemSetting", entityId: "business", ipAddress: req.ip ?? null, metadata: patch });
    res.json(settings);
  })
);

// How a number typed by hand is completed (DDI padrão and the extra 9). Any
// authenticated user can read it — Nova conversa previews what will be used —
// but only the tab's own permission can change it.
const phoneSettingsSchema = z
  .object({
    defaultCountryCodeEnabled: z.boolean(),
    defaultCountryCode: z.string().regex(/^\d{1,3}$/, "Informe o DDI com 1 a 3 números"),
    fixExtraNineEnabled: z.boolean(),
  })
  .strict();

settingsRouter.get(
  "/phone",
  asyncHandler(async (_req, res) => {
    res.json(await getPhoneSettings());
  })
);

settingsRouter.patch(
  "/phone",
  requirePermission(PERMISSION.CONFIGURACOES_GERENCIAR),
  requirePermission(PERMISSION.CONFIGURACOES_TELEFONE_EDITAR),
  asyncHandler(async (req, res) => {
    const input = phoneSettingsSchema.parse(req.body ?? {});
    const settings = await updatePhoneSettings(input);
    await writeAudit({ userId: req.auth!.userId, action: "SETTINGS_PHONE_UPDATED", entity: "SystemSetting", entityId: "phoneNumbers", ipAddress: req.ip ?? null, metadata: input });
    res.json(settings);
  })
);

const themeSchema = z.object({ theme: z.enum(["LIGHT", "DARK", "AUTO"]) });
settingsRouter.patch(
  "/theme",
  asyncHandler(async (req, res) => {
    const { theme } = themeSchema.parse(req.body);
    await service.setUserThemePreference(req.auth!.userId, theme);
    res.json({ theme });
  })
);

// Dashboard chart's gear icon — both null clears back to "show every hour";
// otherwise startHour must be strictly before endHour. Personal preference,
// same as theme above: no permission beyond being logged in.
const presenceChartHoursSchema = z
  .object({ startHour: z.number().int().min(0).max(23).nullable(), endHour: z.number().int().min(0).max(23).nullable() })
  .refine((v) => (v.startHour === null) === (v.endHour === null), { message: "Informe os dois horários ou nenhum" })
  .refine((v) => v.startHour === null || v.startHour! < v.endHour!, { message: "O horário inicial deve ser antes do final" });

settingsRouter.patch(
  "/presence-chart-hours",
  asyncHandler(async (req, res) => {
    const { startHour, endHour } = presenceChartHoursSchema.parse(req.body);
    await service.setUserPresenceChartHours(req.auth!.userId, startHour, endHour);
    res.json({ startHour, endHour });
  })
);

settingsRouter.patch(
  "/arrivals-chart-hours",
  asyncHandler(async (req, res) => {
    const { startHour, endHour } = presenceChartHoursSchema.parse(req.body);
    await service.setUserArrivalsChartHours(req.auth!.userId, startHour, endHour);
    res.json({ startHour, endHour });
  })
);

// ---------------------------------------------------------------------------
// E-mail / SMTP (used to deliver the password-reset link — section 5/56).
// ---------------------------------------------------------------------------

const emailTestLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 10, standardHeaders: true, legacyHeaders: false });

settingsRouter.get(
  "/email",
  requirePermission(PERMISSION.CONFIGURACOES_GERENCIAR),
  requirePermission(PERMISSION.CONFIGURACOES_EMAIL_VISUALIZAR),
  asyncHandler(async (_req, res) => {
    res.json(await service.getEmailSettingsMasked());
  })
);

const emailSchema = z.object({
  host: z.string().min(1).optional(),
  port: z.coerce.number().int().min(1).max(65535).optional(),
  secure: z.boolean().optional(),
  username: z.string().nullable().optional(),
  password: z.string().optional(),
  fromName: z.string().min(1).max(120).optional(),
  fromEmail: z.string().email().optional(),
});

settingsRouter.patch(
  "/email",
  requirePermission(PERMISSION.CONFIGURACOES_GERENCIAR),
  requirePermission(PERMISSION.CONFIGURACOES_EMAIL_EDITAR),
  asyncHandler(async (req, res) => {
    const patch = emailSchema.parse(req.body ?? {});
    const settings = await service.updateEmailSettings(patch);
    // Never audit-log the password itself.
    const { password: _password, ...safeMetadata } = patch;
    await writeAudit({ userId: req.auth!.userId, action: "SETTINGS_EMAIL_UPDATED", entity: "SystemSetting", entityId: "email", ipAddress: req.ip ?? null, metadata: { ...safeMetadata, passwordChanged: Boolean(patch.password) } });
    res.json(settings);
  })
);

const emailTestSchema = z.object({ to: z.string().email() });
settingsRouter.post(
  "/email/test",
  requirePermission(PERMISSION.CONFIGURACOES_GERENCIAR),
  requirePermission(PERMISSION.CONFIGURACOES_EMAIL_EDITAR),
  emailTestLimiter,
  asyncHandler(async (req, res) => {
    const { to } = emailTestSchema.parse(req.body);
    const result = await sendMail(
      to,
      "Teste de configuração SMTP - WhatsAtendende",
      "<p>Este é um e-mail de teste. Se você o recebeu, a configuração de SMTP está funcionando corretamente.</p>",
      "Este é um e-mail de teste. Se você o recebeu, a configuração de SMTP está funcionando corretamente."
    );
    await writeAudit({ userId: req.auth!.userId, action: "SETTINGS_EMAIL_TEST_SENT", entity: "SystemSetting", entityId: "email", ipAddress: req.ip ?? null, metadata: { to, sent: result.sent } });
    if (!result.sent) {
      return res.status(400).json({ error: "SMTP_TEST_FAILED", message: result.reason ?? "Falha ao enviar e-mail de teste" });
    }
    res.json({ message: "E-mail de teste enviado com sucesso." });
  })
);

// ---------------------------------------------------------------------------
// E-mail templates (HTML + subject + on/off) for the system's automatic
// e-mails: password reset, new-user welcome, account-deactivated notice.
// ---------------------------------------------------------------------------

const emailTemplateTypeSchema = z.enum(["PASSWORD_RESET", "USER_WELCOME", "USER_DEACTIVATED", "PASSWORD_CHANGED"]);

// Fake values for every tag the sample preview needs — same names sendTemplatedMail
// resolves for real, so what the admin sees in "Pré-visualizar" matches what gets sent.
const PREVIEW_SAMPLE_VARS: Record<string, Record<string, string>> = {
  PASSWORD_RESET: { nome: "Maria Souza", link_redefinicao: "https://exemplo.com/reset-password?token=amostra" },
  USER_WELCOME: { nome: "João Pereira", email: "joao.pereira@exemplo.com", link_login: "https://exemplo.com/login" },
  USER_DEACTIVATED: { nome: "Carlos Lima" },
  PASSWORD_CHANGED: { nome: "Ana Torres" },
};

settingsRouter.get(
  "/email-templates",
  requirePermission(PERMISSION.CONFIGURACOES_GERENCIAR),
  requirePermission(PERMISSION.CONFIGURACOES_EMAIL_MODELOS_VISUALIZAR),
  asyncHandler(async (_req, res) => {
    res.json({
      templates: await service.getEmailTemplates(),
      tags: service.EMAIL_TEMPLATE_TAGS,
      commonTags: service.EMAIL_TEMPLATE_COMMON_TAGS,
      hasButton: service.EMAIL_TEMPLATE_HAS_BUTTON,
    });
  })
);

const emailTemplatePatchSchema = z
  .object({
    enabled: z.boolean().optional(),
    subject: z.string().min(1).max(200).optional(),
    title: z.string().min(1).max(200).optional(),
    bodyText: z.string().min(1).max(20_000).optional(),
    // Empty string is a valid value here — it's how the admin removes the button.
    buttonText: z.string().max(100).optional(),
  })
  .strict();

settingsRouter.patch(
  "/email-templates/:type",
  requirePermission(PERMISSION.CONFIGURACOES_GERENCIAR),
  requirePermission(PERMISSION.CONFIGURACOES_EMAIL_MODELOS_EDITAR),
  asyncHandler(async (req, res) => {
    const type = emailTemplateTypeSchema.parse(req.params.type);
    const patch = emailTemplatePatchSchema.parse(req.body ?? {});
    const templates = await service.updateEmailTemplate(type, patch);
    await writeAudit({
      userId: req.auth!.userId,
      action: "SETTINGS_EMAIL_TEMPLATE_UPDATED",
      entity: "SystemSetting",
      entityId: `emailTemplates:${type}`,
      ipAddress: req.ip ?? null,
      metadata: { type, ...patch, bodyText: patch.bodyText ? "(alterado)" : undefined },
    });
    res.json(templates);
  })
);

const emailTemplatePreviewSchema = z.object({
  subject: z.string().min(1).max(200),
  title: z.string().min(1).max(200),
  bodyText: z.string().min(1).max(20_000),
  buttonText: z.string().max(100).optional().default(""),
});

settingsRouter.post(
  "/email-templates/:type/preview",
  requirePermission(PERMISSION.CONFIGURACOES_GERENCIAR),
  requirePermission(PERMISSION.CONFIGURACOES_EMAIL_MODELOS_EDITAR),
  asyncHandler(async (req, res) => {
    const type = emailTemplateTypeSchema.parse(req.params.type);
    const draft = emailTemplatePreviewSchema.parse(req.body ?? {});
    res.json(await previewTemplatedMail(type, draft, PREVIEW_SAMPLE_VARS[type]));
  })
);

const emailTemplateTestSchema = z.object({ to: z.string().email() });
settingsRouter.post(
  "/email-templates/:type/test",
  requirePermission(PERMISSION.CONFIGURACOES_GERENCIAR),
  requirePermission(PERMISSION.CONFIGURACOES_EMAIL_MODELOS_EDITAR),
  emailTestLimiter,
  asyncHandler(async (req, res) => {
    const type = emailTemplateTypeSchema.parse(req.params.type);
    const { to } = emailTemplateTestSchema.parse(req.body);
    const result = await sendTemplatedMail(type, to, PREVIEW_SAMPLE_VARS[type]);
    await writeAudit({ userId: req.auth!.userId, action: "SETTINGS_EMAIL_TEMPLATE_TEST_SENT", entity: "SystemSetting", entityId: `emailTemplates:${type}`, ipAddress: req.ip ?? null, metadata: { type, to, sent: result.sent } });
    if (!result.sent) {
      return res.status(400).json({ error: "SMTP_TEST_FAILED", message: result.reason ?? "Falha ao enviar e-mail de teste" });
    }
    res.json({ message: "E-mail de teste enviado com sucesso." });
  })
);

// ---------------------------------------------------------------------------
// Meta (Instagram / Messenger) app credentials — shared by both Conexões
// tabs (same Meta App/Page), so gated by the CONEXOES_GERENCIAR umbrella
// alone rather than a per-channel permission.
// ---------------------------------------------------------------------------

settingsRouter.get(
  "/meta",
  requirePermission(PERMISSION.CONEXOES_GERENCIAR),
  asyncHandler(async (_req, res) => {
    res.json(await service.getMetaSettingsMasked());
  })
);

const metaSchema = z.object({
  appId: z.string().max(60).optional(),
  appSecret: z.string().optional(),
  pageAccessToken: z.string().optional(),
  igAccessToken: z.string().optional(),
  webhookVerifyToken: z.string().max(120).nullable().optional(),
});

settingsRouter.patch(
  "/meta",
  requirePermission(PERMISSION.CONEXOES_GERENCIAR),
  asyncHandler(async (req, res) => {
    const patch = metaSchema.parse(req.body ?? {});
    const settings = await service.updateMetaSettings(patch);
    // Never audit-log the secrets themselves.
    const { appSecret, pageAccessToken, igAccessToken, ...safeMetadata } = patch;
    await writeAudit({
      userId: req.auth!.userId,
      action: "SETTINGS_META_UPDATED",
      entity: "SystemSetting",
      entityId: "meta",
      ipAddress: req.ip ?? null,
      metadata: { ...safeMetadata, appSecretChanged: Boolean(appSecret), pageAccessTokenChanged: Boolean(pageAccessToken), igAccessTokenChanged: Boolean(igAccessToken) },
    });
    res.json(settings);
  })
);
