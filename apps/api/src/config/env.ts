import "dotenv/config";
import { z } from "zod";

const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().default(4000),
  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().optional(),
  // 32+ chars keeps HMAC-SHA256 secrets at a real security margin (the
  // README recommends `openssl rand -hex 32` = 64 chars) — 16 was too easy
  // to satisfy with a weak, short, guessable value.
  JWT_ACCESS_SECRET: z.string().min(32),
  JWT_REFRESH_SECRET: z.string().min(32),
  // Encrypts secrets stored in SystemSetting.value (currently the SMTP
  // password) at rest — see lib/crypto.ts. Same length rationale/generation
  // command as the JWT secrets above; never reuse either of those for this.
  SETTINGS_ENCRYPTION_KEY: z.string().min(32),
  JWT_ACCESS_TTL: z.string().default("15m"),
  JWT_REFRESH_TTL: z.string().default("7d"),
  WHATSAPP_PROVIDER: z.enum(["mock", "baileys"]).default("mock"),
  WHATSAPP_AUTH_DIR: z.string().default("./whatsapp-sessions"),
  WEB_APP_URL: z.string().default("http://localhost:5173"),
  // Self-hosted LanguageTool instance (see docker-compose.yml) backing the
  // Composer's writing-suggestion chip. Best-effort only — a down/slow
  // instance degrades to no suggestions, never blocks sending.
  LANGUAGETOOL_URL: z.string().default("http://localhost:8010"),
  // Where Auditoria looks up the approximate place of an IP (each IP once). Empty turns the lookup off.
  IP_GEOLOCATION_URL: z.string().default("https://ipwho.is"),
  // Minutes the business is behind UTC (what JS getTimezoneOffset() reports; 240 = UTC-4,
  // Tangará da Serra) — for jobs that run at a local time, like Monday 00:00.
  BUSINESS_TZ_OFFSET_MINUTES: z.coerce.number().default(240),
  UPLOAD_DIR: z.string().default("./uploads"),
  UPLOAD_MAX_SIZE_MB: z.coerce.number().default(25),
  RATE_LIMIT_WINDOW_MS: z.coerce.number().default(60_000),
  RATE_LIMIT_MAX: z.coerce.number().default(300),
});

export const env = schema.parse(process.env);
