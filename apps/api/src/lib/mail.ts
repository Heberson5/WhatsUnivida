import nodemailer from "nodemailer";
import { logger } from "./logger";
import { env } from "../config/env";
import {
  getEmailSettings,
  getEmailTemplates,
  getBranding,
  renderEmailTemplateHtml,
  type EmailTemplateType,
  type EmailTemplateConfig,
} from "../modules/settings/settings.service";

export interface SendMailResult {
  sent: boolean;
  reason?: string;
}

/**
 * Sends an e-mail through the SMTP server configured in Configurações > E-mail.
 * Returns `{ sent: false }` (never throws) when SMTP isn't configured yet or
 * the send fails, so callers (e.g. password reset) can fall back gracefully
 * instead of turning an e-mail outage into a 500 for the whole request.
 */
export async function sendMail(to: string, subject: string, html: string, text: string): Promise<SendMailResult> {
  const settings = await getEmailSettings();
  if (!settings || !settings.host || !settings.fromEmail) {
    return { sent: false, reason: "SMTP nao configurado" };
  }

  try {
    const transporter = nodemailer.createTransport({
      host: settings.host,
      port: settings.port,
      secure: settings.secure,
      auth: settings.username ? { user: settings.username, pass: settings.password ?? undefined } : undefined,
    });
    await transporter.sendMail({
      from: `"${settings.fromName}" <${settings.fromEmail}>`,
      to,
      subject,
      html,
      text,
    });
    return { sent: true };
  } catch (err) {
    logger.error({ err }, "failed to send e-mail via SMTP");
    return { sent: false, reason: "Falha ao enviar e-mail pelo servidor SMTP configurado" };
  }
}

/** Joins the configured web app URL with the branding logo's stored relative path (`/uploads/branding/...`), guarding against a double slash if `WEB_APP_URL` has a trailing one. Mail clients have no page origin to resolve a relative `src` against, so this must always be absolute — unlike the in-app logo (Sidebar, login, etc.), which uses the relative path as-is since it's already rendered from the app's own origin. */
function resolveLogoUrl(logoUrl: string): string {
  return `${env.WEB_APP_URL.replace(/\/$/, "")}${logoUrl}`;
}

function renderTemplate(source: string, vars: Record<string, string>): string {
  return source.replace(/\{\{(\w+)\}\}/g, (_match, key: string) => vars[key] ?? "");
}

/** Crude HTML->text fallback for the plaintext part of a templated e-mail — good enough for mail clients that show it. */
function htmlToPlainText(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<(p|div|tr|br)[^>]*>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s+/g, "\n")
    .trim();
}

/**
 * Turns a template's plain-text fields (title/bodyText/buttonText — see
 * renderEmailTemplateHtml) plus the given tag values into a ready-to-send
 * subject + HTML. `vars` only needs the tags specific to that template type
 * (e.g. `nome`, `link_redefinicao`) — the tags common to every template
 * (empresa, logo_html, cor_primaria, ano) are always resolved here from
 * Identidade visual. Shared by sendTemplatedMail (the real send) and
 * previewTemplatedMail (the admin's live preview while editing), so both
 * can never drift apart.
 */
async function composeTemplatedMail(
  type: EmailTemplateType,
  template: Pick<EmailTemplateConfig, "subject" | "title" | "bodyText" | "buttonText">,
  vars: Record<string, string>
): Promise<{ subject: string; html: string }> {
  const branding = await getBranding();
  const logoHtml = branding.logoUrl
    ? `<img src="${resolveLogoUrl(branding.logoUrl)}" alt="${branding.companyName}" width="160" style="display:block; border:0; max-width:160px; height:auto;">`
    : `<strong style="font-family:Helvetica,Arial,sans-serif; font-size:20px; color:${branding.primaryColor};">${branding.companyName}</strong>`;

  const allVars: Record<string, string> = {
    empresa: branding.companyName,
    logo_html: logoHtml,
    cor_primaria: branding.primaryColor,
    ano: String(new Date().getFullYear()),
    ...vars,
  };

  return {
    subject: renderTemplate(template.subject, allVars),
    html: renderTemplate(renderEmailTemplateHtml(type, template), allVars),
  };
}

/** Renders one of the system's configurable e-mail templates (Configurações > Modelos de e-mail) with the given tag values and sends it. See composeTemplatedMail for how `vars` is resolved. */
export async function sendTemplatedMail(type: EmailTemplateType, to: string, vars: Record<string, string>): Promise<SendMailResult> {
  const template = (await getEmailTemplates())[type];
  if (!template.enabled) {
    return { sent: false, reason: "Este e-mail está desativado em Configurações > Modelos de e-mail" };
  }

  const { subject, html } = await composeTemplatedMail(type, template, vars);
  return sendMail(to, subject, html, htmlToPlainText(html));
}

/** Renders a template with in-progress (possibly unsaved) field values — powers the live preview in Configurações > Modelos de e-mail without sending anything or touching what's stored. */
export async function previewTemplatedMail(
  type: EmailTemplateType,
  draft: Pick<EmailTemplateConfig, "subject" | "title" | "bodyText" | "buttonText">,
  vars: Record<string, string>
): Promise<{ subject: string; html: string }> {
  return composeTemplatedMail(type, draft, vars);
}
