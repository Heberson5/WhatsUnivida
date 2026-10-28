import jwt from "jsonwebtoken";
import crypto from "node:crypto";
import { env } from "../../config/env";
import type { Role } from "@prisma/client";

export interface AccessTokenPayload {
  sub: string; // user id
  role: Role;
  displayName: string;
  // The RefreshToken row this access token was minted alongside — see
  // PROMPT: "não poderá acessar 2x ou mais simultaneamente". A JWT is
  // normally self-contained/stateless (no DB hit to verify), which is
  // exactly the problem for instant single-session enforcement: revoking a
  // refresh token stops that device's *next* silent refresh, but its
  // already-issued access token stays valid — and independently
  // verifiable — until its own TTL expires on its own, up to
  // JWT_ACCESS_TTL later. Carrying this id lets every access-token check
  // (requireAuth, the attachment-download route, socket auth) also confirm
  // the backing session hasn't been revoked in the meantime, so a second
  // login elsewhere (or an admin's force-logout) cuts off the first
  // session's API/socket access immediately, not just its ability to
  // refresh.
  sid: string;
}

// Explicit algorithm allowlist on both sign and verify: without this,
// jsonwebtoken infers acceptable algorithms from the secret's type, which
// is the classic surface for algorithm-confusion attacks. Pinning it here
// means a forged token asserting a different "alg" is rejected outright.
const JWT_ALGORITHM = "HS256" as const;

export function signAccessToken(payload: AccessTokenPayload): string {
  return jwt.sign(payload, env.JWT_ACCESS_SECRET, {
    expiresIn: env.JWT_ACCESS_TTL as any,
    algorithm: JWT_ALGORITHM,
  });
}

export function verifyAccessToken(token: string): AccessTokenPayload {
  return jwt.verify(token, env.JWT_ACCESS_SECRET, { algorithms: [JWT_ALGORITHM] }) as AccessTokenPayload;
}

export function signRefreshToken(userId: string): string {
  return jwt.sign(
    // A random jti guarantees two refresh tokens minted for the same user
    // in the same second are never byte-identical — without it, two
    // concurrent refresh calls (React StrictMode's double-effect, multiple
    // open tabs, a retried request) can mint the exact same JWT, which
    // then collides on the refresh_tokens table's unique tokenHash and
    // crashes the second request instead of just succeeding twice.
    { sub: userId, jti: crypto.randomUUID() },
    env.JWT_REFRESH_SECRET,
    { expiresIn: env.JWT_REFRESH_TTL as any, algorithm: JWT_ALGORITHM }
  );
}

export function verifyRefreshToken(token: string): { sub: string } {
  return jwt.verify(token, env.JWT_REFRESH_SECRET, { algorithms: [JWT_ALGORITHM] }) as { sub: string };
}
