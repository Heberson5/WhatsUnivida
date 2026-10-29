import express, { type Request } from "express";
import cors from "cors";
import helmet from "helmet";
import compression from "compression";
import cookieParser from "cookie-parser";
import rateLimit from "express-rate-limit";
import path from "node:path";
import pinoHttp from "pino-http";
import { env } from "./config/env";
import { logger } from "./lib/logger";
import { errorHandler } from "./middleware/error-handler";
import { authRouter } from "./modules/auth/auth.routes";
import { usersRouter } from "./modules/users/users.routes";
import { agentsRouter } from "./modules/users/agents.routes";
import { conversationsRouter } from "./modules/conversations/conversations.routes";
import { messagesRouter } from "./modules/messages/messages.routes";
import { dashboardRouter } from "./modules/dashboard/dashboard.routes";
import { reportsRouter } from "./modules/reports/reports.routes";
import { settingsRouter } from "./modules/settings/settings.routes";
import { auditRouter } from "./modules/audit/audit.routes";
import { whatsappRouter } from "./modules/whatsapp/whatsapp.routes";
import { profileRouter } from "./modules/profile/profile.routes";
import { permissionsRouter } from "./modules/permissions/permissions.routes";
import { quickRepliesRouter } from "./modules/quick-replies/quick-replies.routes";
import { closingMessagesRouter } from "./modules/closing-messages/closing-messages.routes";
import { queueWaitMessagesRouter } from "./modules/queue-wait-messages/queue-wait-messages.routes";
import { birthdayMessagesRouter } from "./modules/birthdays/birthdays.routes";
import { announcementsRouter } from "./modules/announcements/announcements.routes";
import { reportSchedulesRouter } from "./modules/report-schedules/report-schedules.routes";
import { smsRouter } from "./modules/sms/sms.routes";
import { backupRouter } from "./modules/backup/backup.routes";
import { autoMessageTemplatesRouter } from "./modules/auto-message-templates/auto-message-templates.routes";
import { satisfactionRouter } from "./modules/satisfaction/satisfaction.routes";
import { workSchedulesRouter } from "./modules/work-schedules/work-schedules.routes";
import { columnViewsRouter } from "./modules/column-views/column-views.routes";
import { agentToolsRouter } from "./modules/agent-tools/agent-tools.routes";
import { goalsRouter } from "./modules/goals/goals.routes";
import { dataSourcesRouter } from "./modules/data-sources/data-sources.routes";
import { boletosRouter } from "./modules/boletos/boletos.routes";
import { internalChatRouter } from "./modules/internal-chat/internal-chat.routes";
import { contactsRouter } from "./modules/contacts/contacts.routes";
import { linkPreviewRouter } from "./modules/link-preview/link-preview.routes";
import { notificationsRouter } from "./modules/notifications/notifications.routes";
import { holidaysRouter } from "./modules/holidays/holidays.routes";
import { metaRouter } from "./modules/meta/meta.routes";
import { writingAssistRouter } from "./modules/writing-assist/writing-assist.routes";
import { messageTemplatesRouter } from "./modules/message-templates/message-templates.routes";
import { pauseReasonsRouter } from "./modules/pause-reasons/pause-reasons.routes";
import { clientPanelRouter, tagsRouter } from "./modules/client-panel/client-panel.routes";
import { flowsRouter } from "./modules/flows/flows.routes";
import { releaseNotesRouter } from "./modules/release-notes/release-notes.routes";
import { groupsRouter } from "./modules/groups/groups.routes";

export function createApp() {
  const app = express();

  // Belt-and-suspenders: Express doesn't send X-Powered-By by default once
  // this is set, removing a free hint of the backend stack to a scanner.
  app.disable("x-powered-by");

  // The visitor's real IP (Auditoria, rate limiting) comes in X-Forwarded-For from the proxies in front of the API:
  // the web container's nginx and, on a VPS, the host's HTTPS proxy. Only hops on private/loopback addresses are
  // trusted, so a client reaching the API directly from the internet still can't fake its IP with that header.
  app.set("trust proxy", "loopback, linklocal, uniquelocal");

  app.use(
    helmet({
      // Helmet's default img-src ('self' data:) blocks contact profile
      // photos: those are stored as the raw WhatsApp CDN URL returned by
      // Baileys' profilePictureUrl() (see whatsapp.service.ts /
      // conversations.mapper.ts photoUrl), fetched directly by the
      // browser rather than downloaded and re-served from this app — so
      // the CSP has to explicitly allow WhatsApp's photo/media host.
      // Never surfaced before because production had been stuck on a
      // build from before this app.ts even existed — see PROMPT: "não
      // está mais trazendo as fotos de perfil dos clientes".
      contentSecurityPolicy: {
        directives: {
          ...helmet.contentSecurityPolicy.getDefaultDirectives(),
          "img-src": ["'self'", "data:", "https://*.whatsapp.net"],
        },
      },
    })
  );
  app.use(
    cors({
      origin: env.WEB_APP_URL,
      credentials: true,
    })
  );
  app.use(compression());
  app.use(
    express.json({
      limit: "2mb",
      // Captures the exact bytes received, alongside the normal parsed
      // body — the Meta webhook needs this to verify X-Hub-Signature-256
      // (see modules/meta/meta.routes.ts). Every other route ignores it.
      // body-parser's verify callback types `req` as the bare Node
      // http.IncomingMessage (it's framework-agnostic), not Express's own
      // augmented Request — cast to reach the rawBody field declared in
      // middleware/auth.ts's Express.Request augmentation.
      verify: (req, _res, buf) => {
        (req as Request).rawBody = buf;
      },
    })
  );
  app.use(cookieParser());
  app.use(
    pinoHttp({
      logger,
      autoLogging: env.NODE_ENV !== "test",
      // Access/refresh tokens and session cookies must never land in logs
      // — a log line is a much easier thing to accidentally expose (shipped
      // to a log aggregator, a support ticket, a screen share) than the
      // request itself.
      redact: {
        paths: ["req.headers.authorization", "req.headers.cookie", 'res.headers["set-cookie"]'],
        remove: true,
      },
    })
  );

  app.use(
    rateLimit({
      windowMs: env.RATE_LIMIT_WINDOW_MS,
      max: env.RATE_LIMIT_MAX,
      standardHeaders: true,
      legacyHeaders: false,
    })
  );

  app.use("/uploads/branding", express.static(path.join(env.UPLOAD_DIR, "branding")));
  app.use("/uploads/profile", express.static(path.join(env.UPLOAD_DIR, "profile")));
  app.use("/uploads/contacts", express.static(path.join(env.UPLOAD_DIR, "contacts")));
  app.use("/uploads/message-templates", express.static(path.join(env.UPLOAD_DIR, "message-templates")));
  app.use("/uploads/release-notes", express.static(path.join(env.UPLOAD_DIR, "release-notes")));
  // Pop Up › Avisos: images and PDFs of the notices (random names).
  app.use("/uploads/announcements", express.static(path.join(env.UPLOAD_DIR, "announcements")));

  app.get("/api/health", (_req, res) => res.json({ status: "ok", timestamp: new Date().toISOString() }));

  app.use("/api/auth", authRouter);
  app.use("/api/users", usersRouter);
  app.use("/api/agents", agentsRouter);
  app.use("/api/conversations", conversationsRouter);
  app.use("/api/conversations", clientPanelRouter);
  app.use("/api/tags", tagsRouter);
  app.use("/api/contacts", contactsRouter);
  app.use("/api/link-preview", linkPreviewRouter);
  app.use("/api/messages", messagesRouter);
  app.use("/api/dashboard", dashboardRouter);
  app.use("/api/reports", reportsRouter);
  app.use("/api/settings/backup", backupRouter);
  app.use("/api/settings/sms", smsRouter);
  app.use("/api/settings", settingsRouter);
  app.use("/api/audit-logs", auditRouter);
  app.use("/api/whatsapp", whatsappRouter);
  app.use("/api/message-templates", messageTemplatesRouter);
  app.use("/api/profile", profileRouter);
  app.use("/api/permissions", permissionsRouter);
  app.use("/api/quick-replies", quickRepliesRouter);
  app.use("/api/closing-messages", closingMessagesRouter);
  app.use("/api/queue-wait-messages", queueWaitMessagesRouter);
  app.use("/api/birthday-messages", birthdayMessagesRouter);
  app.use("/api/announcements", announcementsRouter);
  app.use("/api/report-schedules", reportSchedulesRouter);
  app.use("/api/auto-message-templates", autoMessageTemplatesRouter);
  app.use("/api/satisfaction-survey", satisfactionRouter);
  app.use("/api/work-schedules", workSchedulesRouter);
  app.use("/api/column-views", columnViewsRouter);
  app.use("/api/agent-tools", agentToolsRouter);
  app.use("/api/goals", goalsRouter);
  app.use("/api/data-sources", dataSourcesRouter);
  app.use("/api/boletos", boletosRouter);
  app.use("/api/internal-chat", internalChatRouter);
  app.use("/api/notifications", notificationsRouter);
  app.use("/api/holidays", holidaysRouter);
  app.use("/api/groups", groupsRouter);
  app.use("/api/meta", metaRouter);
  app.use("/api/writing-assist", writingAssistRouter);
  app.use("/api/pause-reasons", pauseReasonsRouter);
  app.use("/api/flows", flowsRouter);
  app.use("/api/release-notes", releaseNotesRouter);

  app.use((req, res) => {
    res.status(404).json({ error: "NOT_FOUND", message: `Rota nao encontrada: ${req.method} ${req.path}` });
  });

  app.use(errorHandler);

  return app;
}
