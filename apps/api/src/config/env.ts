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
  // Assistente Virtual: the local AI (Ollama) shared by the systems on the VPS — infrastructure/ia-local, reached over
  // the "ia-local" Docker network. Unreachable means the assistant hands every conversation to the queue.
  AI_OLLAMA_URL: z.string().default("http://ollama:11434"),
  AI_MODEL: z.string().default("qwen2.5:3b"),
  AI_TRANSCRIPTION_MODEL: z.string().default("large-v3-turbo"),
  AI_WHISPER_URL: z.string().default("http://whisper:9000"),
  // Where Auditoria looks up the approximate place of an IP (each IP once). Empty turns the lookup off.
  IP_GEOLOCATION_URL: z.string().default("https://ipwho.is"),
  // Minutes the business is behind UTC (what JS getTimezoneOffset() reports; 240 = UTC-4,
  // Tangará da Serra) — for jobs that run at a local time, like Monday 00:00.
  BUSINESS_TZ_OFFSET_MINUTES: z.coerce.number().default(240),
  UPLOAD_DIR: z.string().default("./uploads"),
  UPLOAD_MAX_SIZE_MB: z.coerce.number().default(100),
  RATE_LIMIT_WINDOW_MS: z.coerce.number().default(60_000),
  RATE_LIMIT_MAX: z.coerce.number().default(300),
  // Google Drive (Configurações › Backup): Google's addresses — changed only by the automated tests, which talk to a
  // stand-in for Google running on the same machine.
  GOOGLE_AUTH_URL: z.string().default("https://accounts.google.com/o/oauth2/v2/auth"),
  GOOGLE_TOKEN_URL: z.string().default("https://oauth2.googleapis.com/token"),
  GOOGLE_REVOKE_URL: z.string().default("https://oauth2.googleapis.com/revoke"),
  GOOGLE_API_URL: z.string().default("https://www.googleapis.com"),
  // A Drive backup needs at least this much free space for its temporary copy; with less, it is skipped and the
  // administrators are told (it never fills the disk the system runs on).
  BACKUP_MIN_FREE_MB: z.coerce.number().default(1024),
  // Local time (BUSINESS_TZ_OFFSET_MINUTES) from which the nightly backup to the Google Drive runs.
  BACKUP_HOUR: z.coerce.number().int().min(0).max(23).default(3),
});

export const env = schema.parse(process.env);
