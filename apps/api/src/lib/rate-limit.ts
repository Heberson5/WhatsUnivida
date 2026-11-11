import type { Request, RequestHandler, Response } from "express";
import rateLimit from "express-rate-limit";
import { env } from "../config/env";
import { readAccessTokenUserId } from "../modules/auth/jwt";

/**
 * Who a request is counted against. A whole office reaches the system from one public IP, so counting by IP made
 * every person there share one quota: with each open screen asking for the queue, the groups and the notices a
 * couple dozen times a minute, about a dozen people were enough to have everybody refused (HTTP 429). A signed-in
 * request is counted against its own user; only what carries no valid token (the login screen, a stranger) is
 * counted by IP.
 */
export function requestKey(req: Request): string {
  const header = req.headers.authorization;
  // Attachment and backup downloads carry the token in the query (an <img> can't send a header).
  const token = header?.startsWith("Bearer ") ? header.slice("Bearer ".length) : typeof req.query.token === "string" ? req.query.token : null;
  const userId = token ? readAccessTokenUserId(token) : null;
  return userId ? `user:${userId}` : `ip:${req.ip}`;
}

/** The API answers JSON everywhere — the screens show `message`, so a refusal has to explain itself there too. */
function tooMany(message: string) {
  return (_req: Request, res: Response) => {
    res.status(429).json({ error: "TOO_MANY_REQUESTS", message });
  };
}

const GENERAL_MESSAGE = "Muitas requisições em pouco tempo. Aguarde um instante e tente novamente.";
const LOGIN_MESSAGE = "Muitas tentativas de login. Aguarde alguns minutos e tente novamente.";

/**
 * The limit on everything: RATE_LIMIT_MAX a minute for each signed-in user, RATE_LIMIT_ANON_MAX a minute for each IP
 * with no session. Photos, logos and the health check are left out — plain files an <img> asks for with no token,
 * which would otherwise all land on the office's shared IP.
 */
export function apiLimiter(): RequestHandler {
  return rateLimit({
    windowMs: env.RATE_LIMIT_WINDOW_MS,
    limit: (req) => (requestKey(req).startsWith("user:") ? env.RATE_LIMIT_MAX : env.RATE_LIMIT_ANON_MAX),
    keyGenerator: requestKey,
    skip: (req) => req.path.startsWith("/uploads/") || req.path === "/api/health",
    standardHeaders: true,
    legacyHeaders: false,
    handler: tooMany(GENERAL_MESSAGE),
  });
}

/** A limit on one costly action of a signed-in user (a test e-mail, a history download...), counted per user. */
export function userActionLimiter(options: { windowMs: number; limit: number; skip?: () => boolean }): RequestHandler {
  return rateLimit({ ...options, keyGenerator: requestKey, standardHeaders: true, legacyHeaders: false, handler: tooMany(GENERAL_MESSAGE) });
}

/**
 * Login brute-force protection. Only failed attempts count (a morning with fifty people signing in from the same
 * office is not an attack): 10 wrong passwords in 15 minutes for one e-mail from one IP, and 100 for one IP whatever
 * the e-mail, so trying many accounts from one place is stopped too.
 */
export function loginLimiters(options: { skip?: () => boolean } = {}): RequestHandler[] {
  const shared = { windowMs: 15 * 60 * 1000, skipSuccessfulRequests: true, standardHeaders: true, legacyHeaders: false, handler: tooMany(LOGIN_MESSAGE), ...options };
  const email = (req: Request) => (typeof req.body?.email === "string" ? req.body.email.trim().toLowerCase() : "");
  return [
    rateLimit({ ...shared, limit: 100, keyGenerator: (req) => `ip:${req.ip}` }),
    rateLimit({ ...shared, limit: 10, keyGenerator: (req) => `ip:${req.ip}|${email(req)}` }),
  ];
}
