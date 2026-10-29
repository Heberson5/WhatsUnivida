import type { Prisma } from "@prisma/client";
import type { NoReturnSettingsDTO } from "@whatsatendende/types";
import { prisma } from "../../lib/prisma";
import { encryptSecret, decryptSecret } from "../../lib/crypto";
import { realtimeEvents } from "../../realtime/realtime";

export const BRANDING_KEY = "branding";

export interface BrandingSettings {
  companyName: string;
  primaryColor: string;
  secondaryColor: string;
  logoUrl: string | null;
  faviconUrl: string | null;
  // Identity used when the app is installed as a PWA (Android/iOS/desktop
  // home screen icon + label) — deliberately separate from
  // companyName/logoUrl: the logo shown inside the app can be a wide,
  // non-square image with text, but an OS home-screen/taskbar icon needs a
  // square image, and the installed label has its own length limits. null
  // falls back to companyName / the bundled default icon.
  appName: string | null;
  appIconUrl: string | null;
  // Auto-generated from appIconUrl on every upload (opaque white background,
  // logo confined to Android's safe zone) — used only for the manifest's
  // "maskable" purpose icon. A transparent PNG there (the raw appIconUrl)
  // gets its transparent pixels painted black by Android's own adaptive-icon
  // renderer, and content outside the safe zone gets clipped by the
  // circle/squircle crop. See PROMPT: "a logo... está aparecendo com fundo
  // preto... quero que fique com mais espaço nos cantos".
  appIconMaskableUrl: string | null;
  // Overrides the double-check "lida" (read) tick color, which otherwise
  // follows secondaryColor automatically — null means "no override, use
  // secondaryColor". Exists because the secondary color is sometimes too
  // pastel/light against a given primary to read as a clear status change
  // (see PROMPT: "o risquinho que indica que a mensagem foi lida, seja
  // compatível com a paleta de cores").
  readReceiptColor: string | null;
}

const DEFAULT_BRANDING: BrandingSettings = {
  companyName: "WhatsAtendende",
  primaryColor: "#0097B4",
  secondaryColor: "#FFE450",
  logoUrl: null,
  faviconUrl: null,
  appName: null,
  appIconUrl: null,
  appIconMaskableUrl: null,
  readReceiptColor: null,
};

export async function getBranding(): Promise<BrandingSettings> {
  const record = await prisma.systemSetting.findUnique({ where: { key: BRANDING_KEY } });
  return record ? { ...DEFAULT_BRANDING, ...(record.value as object) } : DEFAULT_BRANDING;
}

export async function updateBranding(patch: Partial<BrandingSettings>): Promise<BrandingSettings> {
  const current = await getBranding();
  const next = { ...current, ...patch };
  await prisma.systemSetting.upsert({
    where: { key: BRANDING_KEY },
    update: { value: next as unknown as Prisma.InputJsonValue },
    create: { key: BRANDING_KEY, value: next as unknown as Prisma.InputJsonValue },
  });
  realtimeEvents.brandingChanged();
  return next;
}

// ---------------------------------------------------------------------------
// Export branding (PowerPoint cover + PDF/Excel reports) — deliberately its
// own logo/cor/nome, independent from the app's own Identidade visual above.
// See PROMPT: "Na guia Exportações... Não é para ter vínculo com a
// Identidade Visual".
export const EXPORT_BRANDING_KEY = "exportBranding";

export interface ExportBrandingSettings {
  companyName: string;
  primaryColor: string;
  logoUrl: string | null;
}

const DEFAULT_EXPORT_BRANDING: ExportBrandingSettings = {
  companyName: "WhatsAtendende",
  primaryColor: "#0097B4",
  logoUrl: null,
};

export async function getExportBranding(): Promise<ExportBrandingSettings> {
  const record = await prisma.systemSetting.findUnique({ where: { key: EXPORT_BRANDING_KEY } });
  return record ? { ...DEFAULT_EXPORT_BRANDING, ...(record.value as object) } : DEFAULT_EXPORT_BRANDING;
}

export async function updateExportBranding(patch: Partial<ExportBrandingSettings>): Promise<ExportBrandingSettings> {
  const current = await getExportBranding();
  const next = { ...current, ...patch };
  await prisma.systemSetting.upsert({
    where: { key: EXPORT_BRANDING_KEY },
    update: { value: next as unknown as Prisma.InputJsonValue },
    create: { key: EXPORT_BRANDING_KEY, value: next as unknown as Prisma.InputJsonValue },
  });
  realtimeEvents.brandingChanged();
  return next;
}

// ---------------------------------------------------------------------------
// Landing Page — customizes the login screen (logo size/alignment/subtitle),
// the main menu (order, label, icon of each item — shared by Sidebar and
// BottomNav) and each page's header title. Its own top-level menu/permission,
// not nested under Configurações — see PROMPT: "planeje um novo menu chamado
// landing page".
export const LANDING_PAGE_KEY = "landingPage";

export interface LandingPageSettings {
  loginLogoSizePx: number;
  loginLogoAlign: "center" | "left";
  loginSubtitle: string | null;
  /** `to` paths (Sidebar's MENU_ITEMS) in the desired order; [] = default order. */
  menuOrder: string[];
  /** `to` path -> only the fields actually customized. */
  menuItems: Record<string, { label?: string; icon?: string }>;
  /** route path -> custom page title (AppLayout's TITLES map). */
  pageTitles: Record<string, string>;
}

const DEFAULT_LANDING_PAGE: LandingPageSettings = {
  loginLogoSizePx: 80,
  loginLogoAlign: "center",
  loginSubtitle: null,
  menuOrder: [],
  menuItems: {},
  pageTitles: {},
};

export async function getLandingPageSettings(): Promise<LandingPageSettings> {
  const record = await prisma.systemSetting.findUnique({ where: { key: LANDING_PAGE_KEY } });
  return record ? { ...DEFAULT_LANDING_PAGE, ...(record.value as object) } : DEFAULT_LANDING_PAGE;
}

export async function updateLandingPageSettings(patch: Partial<LandingPageSettings>): Promise<LandingPageSettings> {
  const current = await getLandingPageSettings();
  const next = { ...current, ...patch };
  await prisma.systemSetting.upsert({
    where: { key: LANDING_PAGE_KEY },
    update: { value: next as unknown as Prisma.InputJsonValue },
    create: { key: LANDING_PAGE_KEY, value: next as unknown as Prisma.InputJsonValue },
  });
  return next;
}

// ---------------------------------------------------------------------------
// Maintenance mode — see PROMPT: "botão em configurações para colocar o
// site em manutenção... somente o administrador" pode acessar durante.
// Read is public (the login screen needs it before anyone authenticates,
// same precedent as branding above); write is ADMIN-only (see
// settings.routes.ts — not the configurable CONFIGURACOES_GERENCIAR
// permission, since this can lock every non-admin out of the whole system).
// ---------------------------------------------------------------------------

const MAINTENANCE_KEY = "maintenance";

export interface MaintenanceSettings {
  enabled: boolean;
  message: string | null;
}

const DEFAULT_MAINTENANCE: MaintenanceSettings = { enabled: false, message: null };

export async function getMaintenanceSettings(): Promise<MaintenanceSettings> {
  const record = await prisma.systemSetting.findUnique({ where: { key: MAINTENANCE_KEY } });
  return record ? { ...DEFAULT_MAINTENANCE, ...(record.value as object) } : DEFAULT_MAINTENANCE;
}

export async function updateMaintenanceSettings(patch: Partial<MaintenanceSettings>): Promise<MaintenanceSettings> {
  const current = await getMaintenanceSettings();
  const next = { ...current, ...patch };
  await prisma.systemSetting.upsert({
    where: { key: MAINTENANCE_KEY },
    update: { value: next as unknown as Prisma.InputJsonValue },
    create: { key: MAINTENANCE_KEY, value: next as unknown as Prisma.InputJsonValue },
  });
  return next;
}

export async function getBusinessSettings(): Promise<Record<string, unknown>> {
  const record = await prisma.systemSetting.findUnique({ where: { key: "business" } });
  // Merge over the defaults (same pattern as getBranding/getMaintenanceSettings
  // below) rather than returning the stored row as-is — a key added to
  // DEFAULT_BUSINESS_SETTINGS after this row was first saved would otherwise
  // come back undefined forever, since nothing here ever re-saves the whole
  // object. See queueReminderIntervalMinutes, added well after this key was
  // already in use in any environment that had touched Configurações > Segurança.
  return record ? { ...DEFAULT_BUSINESS_SETTINGS, ...(record.value as Record<string, unknown>) } : DEFAULT_BUSINESS_SETTINGS;
}

// Roadmap knobs (spec section 52/53): not all are enforced by business
// logic yet, but the settings store and API already support them so the
// enforcement can land without a schema/API break.
const DEFAULT_BUSINESS_SETTINGS = {
  // Now enforced client-side (see useIdleLogout) — 8h covers a full shift
  // without ever tripping mid-workday; an admin can tune it in Configurações.
  inactivityTimeoutMinutes: 8 * 60,
  autoCloseEnabled: false,
  reopenTarget: "QUEUE", // QUEUE | LAST_AGENT
  uploadMaxSizeMb: 25,
  notificationSoundEnabled: true,
  businessHours: null as { start: string; end: string; days: number[] } | null,
  greetingMessage: null as string | null,
  awayMessage: null as string | null,
  // How often (in minutes) an ONLINE agent is reminded that their
  // connection's queue still has a conversation waiting to be accepted —
  // see PROMPT: "notificações a cada um minuto quando tem conversas na
  // fila... parametrizado quanto tempo deverá ser notificado". Checked by
  // the queue-reminder timer in server.ts.
  queueReminderIntervalMinutes: 1,
  // Time alerts (Configurações › Fila): a card turns yellow, then red, after
  // this many minutes without a reply (Meus) or waiting to be accepted (Fila).
  noReplyWarningMinutes: 5,
  noReplyDangerMinutes: 15,
  queueWarningMinutes: 5,
  queueDangerMinutes: 10,
  // Encerramento por falta de retorno (Respostas › Encerramento): off until a manager turns it on. The minutes only
  // count while the connection's work schedule is open.
  noReturnEnabled: false,
  noReturnReminderMinutes: 10,
  noReturnCloseMinutes: 15,
  noReturnReminderText: "Oi, {{cliente}}! Ainda está por aí? 😊 Fico aguardando seu retorno para continuarmos o atendimento.",
  // The satisfaction survey after a no-return close — off by default (it never went out before).
  noReturnSendSurvey: false,
  noReturnCloseText:
    "{{cliente}}, como não tivemos retorno, estamos encerrando este atendimento por enquanto. Quando quiser continuar, é só mandar uma mensagem aqui que retomamos de onde paramos. Até logo! 👋",
  // Avisos de digitação (Configurações › Fila), QR Code connections: the customer sees "digitando…"/"gravando áudio…"
  // while the attendant writes or records, and the attendant sees the customer's.
  typingToCustomer: true,
  typingFromCustomer: true,
};

export async function getNoReturnSettings(): Promise<NoReturnSettingsDTO> {
  const s = await getBusinessSettings();
  return {
    enabled: s.noReturnEnabled as boolean,
    reminderMinutes: s.noReturnReminderMinutes as number,
    closeMinutes: s.noReturnCloseMinutes as number,
    reminderText: s.noReturnReminderText as string,
    closeText: s.noReturnCloseText as string,
    sendSurvey: Boolean(s.noReturnSendSurvey),
  };
}

export async function updateBusinessSettings(patch: Record<string, unknown>) {
  const current = await getBusinessSettings();
  const next = { ...current, ...patch };
  await prisma.systemSetting.upsert({
    where: { key: "business" },
    update: { value: next as unknown as Prisma.InputJsonValue },
    create: { key: "business", value: next as unknown as Prisma.InputJsonValue },
  });
  return next;
}

export async function setUserThemePreference(userId: string, theme: "LIGHT" | "DARK" | "AUTO") {
  await prisma.user.update({ where: { id: userId }, data: { themePreference: theme } });
}

/** Dashboard "Presença ao longo do dia" gear icon's "Definir como padrão" — both null clears back to "show every hour". */
export async function setUserPresenceChartHours(userId: string, startHour: number | null, endHour: number | null) {
  await prisma.user.update({ where: { id: userId }, data: { presenceChartStartHour: startHour, presenceChartEndHour: endHour } });
}

/** Same, for "Conversas que chegam ao longo do dia". */
export async function setUserArrivalsChartHours(userId: string, startHour: number | null, endHour: number | null) {
  await prisma.user.update({ where: { id: userId }, data: { arrivalsChartStartHour: startHour, arrivalsChartEndHour: endHour } });
}

// ---------------------------------------------------------------------------
// SMTP / e-mail delivery (used for password-reset links) — section 5/56.
// ---------------------------------------------------------------------------

const EMAIL_KEY = "email";

export interface EmailSettings {
  host: string;
  port: number;
  secure: boolean; // true = implicit TLS (typically port 465); false = STARTTLS/plaintext (587/25)
  username: string | null;
  password: string | null;
  fromName: string;
  fromEmail: string;
}

export type EmailSettingsMasked = Omit<EmailSettings, "password"> & { configured: boolean; hasPassword: boolean };

const DEFAULT_EMAIL_SETTINGS: EmailSettings = {
  host: "",
  port: 587,
  secure: false,
  username: null,
  password: null,
  fromName: "WhatsAtendende",
  fromEmail: "",
};

/** Internal — includes the password. Never expose this to an HTTP response; use getEmailSettingsMasked instead. */
export async function getEmailSettings(): Promise<EmailSettings | null> {
  const record = await prisma.systemSetting.findUnique({ where: { key: EMAIL_KEY } });
  if (!record) return null;
  const settings = { ...DEFAULT_EMAIL_SETTINGS, ...(record.value as Partial<EmailSettings>) };
  return { ...settings, password: settings.password ? decryptSecret(settings.password) : null };
}

/** Safe to return to the client: the password is never echoed back, only whether one is set. */
export async function getEmailSettingsMasked(): Promise<EmailSettingsMasked> {
  const settings = (await getEmailSettings()) ?? DEFAULT_EMAIL_SETTINGS;
  const { password, ...rest } = settings;
  return { ...rest, configured: Boolean(settings.host && settings.fromEmail), hasPassword: Boolean(password) };
}

export async function updateEmailSettings(patch: Partial<EmailSettings>): Promise<EmailSettingsMasked> {
  const current = (await getEmailSettings()) ?? DEFAULT_EMAIL_SETTINGS;
  const next: EmailSettings = {
    host: patch.host ?? current.host,
    port: patch.port ?? current.port,
    secure: patch.secure ?? current.secure,
    username: patch.username !== undefined ? patch.username : current.username,
    // Only overwrite the stored password when a new non-empty one is sent,
    // so the admin can edit host/port without retyping it — and the API
    // never sends it back, so there's nothing to "leave unchanged" from a form value.
    password: patch.password ? patch.password : current.password,
    fromName: patch.fromName ?? current.fromName,
    fromEmail: patch.fromEmail ?? current.fromEmail,
  };
  // getEmailSettings() above already decrypted `current.password` for the
  // "keep unchanged" branch — encrypt right before writing so the DB never
  // holds it in plain text, whether it's a brand-new password or a
  // legacy-plaintext one being upgraded to encrypted-at-rest just by being
  // re-saved (see decryptSecret's own doc comment).
  const stored = { ...next, password: next.password ? encryptSecret(next.password) : null };
  await prisma.systemSetting.upsert({
    where: { key: EMAIL_KEY },
    update: { value: stored as unknown as Prisma.InputJsonValue },
    create: { key: EMAIL_KEY, value: stored as unknown as Prisma.InputJsonValue },
  });
  return getEmailSettingsMasked();
}

// ---------------------------------------------------------------------------
// E-mail templates (title + body text + subject + on/off, edited as plain
// text — no HTML) for the system's automatic e-mails: password reset,
// new-user welcome, account-deactivated notice, password-changed confirmation.
// ---------------------------------------------------------------------------

export type EmailTemplateType = "PASSWORD_RESET" | "USER_WELCOME" | "USER_DEACTIVATED" | "PASSWORD_CHANGED";

// Plain-text fields only — no HTML editing. The admin types a title, the
// message body (a blank line starts a new paragraph) and, for the 2
// templates that carry a call-to-action link, the button's label; the actual
// markup (layout, logo, colors, button styling) is always generated from
// these by renderEmailTemplateHtml, so nobody who isn't comfortable reading
// HTML has to touch it.
export interface EmailTemplateConfig {
  enabled: boolean;
  subject: string;
  title: string;
  bodyText: string;
  /** Empty string = no button shown. Only meaningful for a type present in EMAIL_TEMPLATE_BUTTON_LINK_TAG. */
  buttonText: string;
}

export type EmailTemplatesSettings = Record<EmailTemplateType, EmailTemplateConfig>;

const EMAIL_TEMPLATES_KEY = "emailTemplates";

/** The tag (without braces) each template's button links to — a type with no entry here never shows a button field at all. */
const EMAIL_TEMPLATE_BUTTON_LINK_TAG: Partial<Record<EmailTemplateType, string>> = {
  PASSWORD_RESET: "link_redefinicao",
  USER_WELCOME: "link_login",
};

export const EMAIL_TEMPLATE_HAS_BUTTON: Record<EmailTemplateType, boolean> = {
  PASSWORD_RESET: true,
  USER_WELCOME: true,
  USER_DEACTIVATED: false,
  PASSWORD_CHANGED: false,
};

function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** A blank line starts a new `<p>`; a single line break inside a paragraph becomes `<br>`. `{{tags}}` pass through untouched (braces/letters need no escaping) so they still get resolved later by renderTemplate in mail.ts. */
function renderBodyParagraphs(bodyText: string): string {
  return bodyText
    .split(/\n\s*\n/)
    .map((block) => block.trim())
    .filter(Boolean)
    .map((block) => `<p>${escapeHtml(block).replace(/\n/g, "<br>")}</p>`)
    .join("\n");
}

/** Builds the full send-ready HTML for a template from its plain-text fields — the single place that turns title/bodyText/buttonText into markup, used both when actually sending (mail.ts) and for the admin's live preview, so the two can never drift apart. */
export function renderEmailTemplateHtml(type: EmailTemplateType, config: Pick<EmailTemplateConfig, "title" | "bodyText" | "buttonText">): string {
  const linkTag = EMAIL_TEMPLATE_BUTTON_LINK_TAG[type];
  const buttonHtml =
    config.buttonText.trim() && linkTag
      ? `<p style="text-align:center; padding:16px 0 0;"><a href="{{${linkTag}}}" style="display:inline-block; background-color:{{cor_primaria}}; color:#ffffff; text-decoration:none; padding:12px 28px; border-radius:6px; font-weight:600;">${escapeHtml(config.buttonText.trim())}</a></p>`
      : "";
  return baseTemplateHtml(escapeHtml(config.title), renderBodyParagraphs(config.bodyText) + buttonHtml);
}

/** The same layout for an e-mail whose text isn't one of the fixed templates (Agendamento da apresentação, alerts). */
export function renderCustomEmailHtml(title: string, bodyText: string): string {
  return baseTemplateHtml(escapeHtml(title), renderBodyParagraphs(bodyText));
}

// Shared table-based layout (works in Outlook/Gmail/etc, unlike flexbox/grid
// e-mail markup) — {{logo_html}}/{{empresa}}/{{cor_primaria}}/{{ano}} are
// always resolved from Configurações > Identidade visual at send time (see
// sendTemplatedMail in mail.ts), so every template stays on-brand for
// whichever company runs this platform without hardcoding any of it here.
function baseTemplateHtml(titleText: string, bodyHtml: string): string {
  return `<!DOCTYPE html>
<html lang="pt-br">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>{{empresa}}</title>
</head>
<body style="margin:0; padding:30px 0; width:100%; background-color:#F4F5F7;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#F4F5F7; border-collapse:collapse;">
    <tr>
      <td align="center">
        <table role="presentation" width="560" cellpadding="0" cellspacing="0" border="0" style="width:100%; max-width:560px; background-color:#ffffff; border-radius:8px; border-collapse:collapse;">
          <tr>
            <td align="center" style="padding:32px 24px 8px;">{{logo_html}}</td>
          </tr>
          <tr>
            <td style="padding:8px 32px 0; font-family:Helvetica,Arial,sans-serif; font-size:19px; font-weight:600; text-align:center; color:{{cor_primaria}};">
              ${titleText}
            </td>
          </tr>
          <tr>
            <td style="padding:20px 32px 32px; font-family:Helvetica,Arial,sans-serif; font-size:14px; line-height:24px; color:#2E363F; text-align:justify;">
              ${bodyHtml}
            </td>
          </tr>
          <tr>
            <td style="padding:16px 32px; border-top:1px solid #EEEEEE; font-family:Helvetica,Arial,sans-serif; font-size:12px; color:#9AA1A9; text-align:center;">
              &copy; {{ano}} {{empresa}}. Todos os direitos reservados.
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

const DEFAULT_EMAIL_TEMPLATES: EmailTemplatesSettings = {
  PASSWORD_RESET: {
    enabled: true,
    subject: "Redefinição de senha - {{empresa}}",
    title: "Redefinição de senha",
    bodyText:
      "Olá, {{nome}}.\n\nRecebemos uma solicitação para redefinir a senha da sua conta. Clique no botão abaixo para continuar (o link é válido por 1 hora).\n\nSe você não solicitou essa alteração, ignore este e-mail — sua senha permanece a mesma.",
    buttonText: "Redefinir senha",
  },
  USER_WELCOME: {
    enabled: true,
    subject: "Bem-vindo(a) à {{empresa}}",
    title: "Bem-vindo(a)!",
    bodyText: "Olá, {{nome}}.\n\nSua conta foi criada em {{empresa}}. Você já pode acessar a plataforma com o e-mail {{email}}.",
    buttonText: "Acessar plataforma",
  },
  USER_DEACTIVATED: {
    enabled: true,
    subject: "Sua conta foi desativada - {{empresa}}",
    title: "Conta desativada",
    bodyText:
      "Olá, {{nome}}.\n\nSua conta em {{empresa}} foi desativada por um administrador. Se você acredita que isso é um engano, entre em contato com o time responsável.",
    buttonText: "",
  },
  PASSWORD_CHANGED: {
    enabled: true,
    subject: "Sua senha foi alterada - {{empresa}}",
    title: "Senha alterada",
    bodyText:
      "Olá, {{nome}}.\n\nConfirmamos que a senha da sua conta em {{empresa}} foi alterada com sucesso.\n\nSe foi você quem fez essa alteração, nenhuma ação é necessária.\n\nSe você não reconhece essa alteração, entre em contato imediatamente com o administrador do sistema.",
    buttonText: "",
  },
};

/** Tags specific to each template type — surfaced in the editor UI so the admin knows what's available. */
export const EMAIL_TEMPLATE_TAGS: Record<EmailTemplateType, { tag: string; description: string }[]> = {
  PASSWORD_RESET: [
    { tag: "{{nome}}", description: "Nome de exibição do usuário" },
    { tag: "{{link_redefinicao}}", description: "Link único para redefinir a senha (expira em 1 hora)" },
  ],
  USER_WELCOME: [
    { tag: "{{nome}}", description: "Nome de exibição do novo usuário" },
    { tag: "{{email}}", description: "E-mail de login do novo usuário" },
    { tag: "{{link_login}}", description: "Link para a tela de login" },
  ],
  USER_DEACTIVATED: [{ tag: "{{nome}}", description: "Nome de exibição do usuário desativado" }],
  PASSWORD_CHANGED: [{ tag: "{{nome}}", description: "Nome de exibição do usuário" }],
};

/** Available in every template regardless of type — resolved automatically from Identidade visual. */
export const EMAIL_TEMPLATE_COMMON_TAGS: { tag: string; description: string }[] = [
  { tag: "{{empresa}}", description: "Nome da empresa (Configurações > Identidade visual)" },
  { tag: "{{logo_html}}", description: "Logo da empresa — ou o nome da empresa em texto, se nenhuma logo foi enviada" },
  { tag: "{{cor_primaria}}", description: "Cor primária configurada em Identidade visual" },
  { tag: "{{ano}}", description: "Ano atual" },
];

export async function getEmailTemplates(): Promise<EmailTemplatesSettings> {
  const record = await prisma.systemSetting.findUnique({ where: { key: EMAIL_TEMPLATES_KEY } });
  const stored = (record?.value as Partial<EmailTemplatesSettings>) ?? {};
  return {
    PASSWORD_RESET: { ...DEFAULT_EMAIL_TEMPLATES.PASSWORD_RESET, ...stored.PASSWORD_RESET },
    USER_WELCOME: { ...DEFAULT_EMAIL_TEMPLATES.USER_WELCOME, ...stored.USER_WELCOME },
    USER_DEACTIVATED: { ...DEFAULT_EMAIL_TEMPLATES.USER_DEACTIVATED, ...stored.USER_DEACTIVATED },
    PASSWORD_CHANGED: { ...DEFAULT_EMAIL_TEMPLATES.PASSWORD_CHANGED, ...stored.PASSWORD_CHANGED },
  };
}

export async function updateEmailTemplate(type: EmailTemplateType, patch: Partial<EmailTemplateConfig>): Promise<EmailTemplatesSettings> {
  const current = await getEmailTemplates();
  const next: EmailTemplatesSettings = { ...current, [type]: { ...current[type], ...patch } };
  await prisma.systemSetting.upsert({
    where: { key: EMAIL_TEMPLATES_KEY },
    update: { value: next as unknown as Prisma.InputJsonValue },
    create: { key: EMAIL_TEMPLATES_KEY, value: next as unknown as Prisma.InputJsonValue },
  });
  return next;
}

// ---------------------------------------------------------------------------
// Meta (Instagram / Messenger) app credentials — see PROMPT: "prepare tudo
// para integrar com Instagram e Facebook". Same shape/pattern as
// EmailSettings above: one SystemSetting row, secrets encrypted at rest,
// never echoed back to an HTTP response.
// ---------------------------------------------------------------------------

export const META_KEY = "meta";

export interface MetaSettings {
  appId: string;
  appSecret: string | null;
  pageAccessToken: string | null;
  igAccessToken: string | null;
  // Arbitrary string chosen by the admin and entered on both sides (here
  // and in the Meta App Dashboard's webhook config) so Meta's verification
  // handshake (GET /webhook?hub.verify_token=...) can be checked against
  // it — not a credential issued by Meta, so it isn't encrypted like the
  // tokens above.
  webhookVerifyToken: string | null;
}

export type MetaSettingsMasked = Omit<MetaSettings, "appSecret" | "pageAccessToken" | "igAccessToken"> & {
  hasAppSecret: boolean;
  hasPageAccessToken: boolean;
  hasIgAccessToken: boolean;
};

const DEFAULT_META_SETTINGS: MetaSettings = {
  appId: "",
  appSecret: null,
  pageAccessToken: null,
  igAccessToken: null,
  webhookVerifyToken: null,
};

/** Internal — includes the secrets. Never expose this to an HTTP response; use getMetaSettingsMasked instead. */
export async function getMetaSettings(): Promise<MetaSettings> {
  const record = await prisma.systemSetting.findUnique({ where: { key: META_KEY } });
  const settings = { ...DEFAULT_META_SETTINGS, ...((record?.value as Partial<MetaSettings>) ?? {}) };
  return {
    ...settings,
    appSecret: settings.appSecret ? decryptSecret(settings.appSecret) : null,
    pageAccessToken: settings.pageAccessToken ? decryptSecret(settings.pageAccessToken) : null,
    igAccessToken: settings.igAccessToken ? decryptSecret(settings.igAccessToken) : null,
  };
}

/** Safe to return to the client: secrets are never echoed back, only whether one is set. */
export async function getMetaSettingsMasked(): Promise<MetaSettingsMasked> {
  const settings = await getMetaSettings();
  const { appSecret, pageAccessToken, igAccessToken, ...rest } = settings;
  return {
    ...rest,
    hasAppSecret: Boolean(appSecret),
    hasPageAccessToken: Boolean(pageAccessToken),
    hasIgAccessToken: Boolean(igAccessToken),
  };
}

export async function updateMetaSettings(patch: Partial<MetaSettings>): Promise<MetaSettingsMasked> {
  const current = await getMetaSettings();
  const next: MetaSettings = {
    appId: patch.appId ?? current.appId,
    // Only overwrite a secret when a new non-empty one is sent, same
    // reasoning as updateEmailSettings — the API never sends it back, so
    // there's nothing to "leave unchanged" from a form value.
    appSecret: patch.appSecret ? patch.appSecret : current.appSecret,
    pageAccessToken: patch.pageAccessToken ? patch.pageAccessToken : current.pageAccessToken,
    igAccessToken: patch.igAccessToken ? patch.igAccessToken : current.igAccessToken,
    webhookVerifyToken: patch.webhookVerifyToken !== undefined ? patch.webhookVerifyToken : current.webhookVerifyToken,
  };
  const stored = {
    ...next,
    appSecret: next.appSecret ? encryptSecret(next.appSecret) : null,
    pageAccessToken: next.pageAccessToken ? encryptSecret(next.pageAccessToken) : null,
    igAccessToken: next.igAccessToken ? encryptSecret(next.igAccessToken) : null,
  };
  await prisma.systemSetting.upsert({
    where: { key: META_KEY },
    update: { value: stored as unknown as Prisma.InputJsonValue },
    create: { key: META_KEY, value: stored as unknown as Prisma.InputJsonValue },
  });
  // Keep every MetaConnection row's status in sync with whether this
  // channel actually has an access token configured — same shallow
  // "configured" semantics getEmailSettingsMasked already uses (a token
  // being present, not a live-verified handshake).
  await prisma.metaConnection.updateMany({ where: { channel: "MESSENGER" }, data: { status: next.pageAccessToken ? "CONNECTED" : "DISCONNECTED" } });
  await prisma.metaConnection.updateMany({ where: { channel: "INSTAGRAM" }, data: { status: next.igAccessToken ? "CONNECTED" : "DISCONNECTED" } });
  return getMetaSettingsMasked();
}
