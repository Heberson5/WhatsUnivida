import express from "express";
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
import { holidaysRouter } from "./modules/holidays/holidays.routes";

export function createApp() {
  const app = express();

  // Belt-and-suspenders: Express doesn't send X-Powered-By by default once
  // this is set, removing a free hint of the backend stack to a scanner.
  app.disable("x-powered-by");

  // Only meaningful (and only safe) when a trusted reverse proxy is the
  // sole path to this process — see the TRUST_PROXY comment in env.ts/.env.example.
  if (env.TRUST_PROXY) app.set("trust proxy", 1);

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
  app.use(express.json({ limit: "2mb" }));
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

  app.get("/api/health", (_req, res) => res.json({ status: "ok", timestamp: new Date().toISOString() }));

  app.use("/api/auth", authRouter);
  app.use("/api/users", usersRouter);
  app.use("/api/agents", agentsRouter);
  app.use("/api/conversations", conversationsRouter);
  app.use("/api/messages", messagesRouter);
  app.use("/api/dashboard", dashboardRouter);
  app.use("/api/reports", reportsRouter);
  app.use("/api/settings", settingsRouter);
  app.use("/api/audit-logs", auditRouter);
  app.use("/api/whatsapp", whatsappRouter);
  app.use("/api/profile", profileRouter);
  app.use("/api/permissions", permissionsRouter);
  app.use("/api/quick-replies", quickRepliesRouter);
  app.use("/api/holidays", holidaysRouter);

  app.use((req, res) => {
    res.status(404).json({ error: "NOT_FOUND", message: `Rota nao encontrada: ${req.method} ${req.path}` });
  });

  app.use(errorHandler);

  return app;
}
