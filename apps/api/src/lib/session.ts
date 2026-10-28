import { prisma } from "./prisma";

/**
 * Whether the RefreshToken row an access token was minted alongside (its
 * `sid` claim — see jwt.ts's AccessTokenPayload) is still in good standing.
 * An access token's own JWT signature/expiry says nothing about this — a
 * still-unexpired token from a session that was revoked seconds ago (a
 * second login elsewhere, an admin's force-logout) would otherwise keep
 * working for up to JWT_ACCESS_TTL longer. Every place that accepts an
 * access token (requireAuth, the attachment-download route's header-or-
 * query variant, socket auth) calls this so "revoked" actually means
 * revoked immediately — see PROMPT: "não poderá acessar 2x ou mais
 * simultaneamente".
 */
export async function isSessionActive(sid: string): Promise<boolean> {
  const session = await prisma.refreshToken.findUnique({ where: { id: sid }, select: { revokedAt: true, expiresAt: true } });
  return Boolean(session && !session.revokedAt && session.expiresAt > new Date());
}
