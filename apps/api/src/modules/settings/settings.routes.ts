import { Router } from "express";
import multer from "multer";
import path from "node:path";
import fs from "node:fs";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import rateLimit from "express-rate-limit";
import { asyncHandler } from "../../lib/async-handler";
import { requireAuth, requireRole } from "../../middleware/auth";
import { requirePermission } from "../../lib/permissions";
import { PERMISSION } from "@whatsunivida/types";
import { writeAudit } from "../../lib/audit";
import { sendMail, sendTemplatedMail, previewTemplatedMail } from "../../lib/mail";
import { env } from "../../config/env";
import * as service from "./settings.service";

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
    res.json(await service.getBranding());
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
            { src: iconUrl, sizes: "512x512", type: iconType, purpose: "maskable" },
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
});

settingsRouter.patch(
  "/branding",
  requirePermission(PERMISSION.CONFIGURACOES_GERENCIAR),
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

settingsRouter.post(
  "/branding/app-icon",
  requirePermission(PERMISSION.CONFIGURACOES_GERENCIAR),
  upload.single("file"),
  asyncHandler(async (req, res) => {
    if (!req.file) return res.status(400).json({ error: "BAD_REQUEST", message: "Nenhum arquivo enviado" });
    const fileName = `app-icon-${randomUUID()}${ALLOWED_BRANDING_MIME_TO_EXT[req.file.mimetype]}`;
    fs.writeFileSync(path.join(brandingAssetDir, fileName), req.file.buffer);
    const branding = await service.updateBranding({ appIconUrl: `/uploads/branding/${fileName}` });
    await writeAudit({ userId: req.auth!.userId, action: "SETTINGS_APP_ICON_UPLOADED", entity: "SystemSetting", entityId: "branding", ipAddress: req.ip ?? null });
    res.json(branding);
  })
);

settingsRouter.post(
  "/branding/favicon",
  requirePermission(PERMISSION.CONFIGURACOES_GERENCIAR),
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

const themeSchema = z.object({ theme: z.enum(["LIGHT", "DARK", "AUTO"]) });
settingsRouter.patch(
  "/theme",
  asyncHandler(async (req, res) => {
    const { theme } = themeSchema.parse(req.body);
    await service.setUserThemePreference(req.auth!.userId, theme);
    res.json({ theme });
  })
);

// ---------------------------------------------------------------------------
// E-mail / SMTP (used to deliver the password-reset link — section 5/56).
// ---------------------------------------------------------------------------

const emailTestLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 10, standardHeaders: true, legacyHeaders: false });

settingsRouter.get(
  "/email",
  requirePermission(PERMISSION.CONFIGURACOES_GERENCIAR),
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
  emailTestLimiter,
  asyncHandler(async (req, res) => {
    const { to } = emailTestSchema.parse(req.body);
    const result = await sendMail(
      to,
      "Teste de configuração SMTP - WhatsUnivida",
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
