import { Router } from "express";
import { z } from "zod";
import rateLimit from "express-rate-limit";
import { asyncHandler } from "../../lib/async-handler";
import { env } from "../../config/env";
import { requireAuth } from "../../middleware/auth";
import { toUserDTO } from "../users/users.mapper";
import * as authService from "./auth.service";
import { refreshCookieOptions } from "./auth.service";
import { prisma } from "../../lib/prisma";
import { getPermissionsForRole } from "../../lib/permissions";
import { resolveAccessDecision, resolveLocalNow } from "../../lib/access-schedule";
import { findApplicableHoliday } from "../holidays/holidays.service";
import type { AccessSchedule } from "@whatsatendende/types";

export const authRouter = Router();

// Skipped only under NODE_ENV=test: every request in a test run shares the
// same source IP, and a single test file can legitimately log in well past
// 20 times (one per agent/scenario) — that's test volume, not the login
// brute-forcing this limiter exists to stop. Never skipped outside tests.
const skipInTests = () => env.NODE_ENV === "test";
const loginLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 20, standardHeaders: true, legacyHeaders: false, skip: skipInTests });
// Password-reset endpoints are unauthenticated by nature — without their
// own limiter they'd let an attacker spam e-mails to arbitrary addresses
// (forgot-password) or brute-force reset tokens (reset-password).
const passwordResetLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 10, standardHeaders: true, legacyHeaders: false, skip: skipInTests });

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
  // Browser's Date.prototype.getTimezoneOffset() — see lib/access-schedule.ts
  // for why this (not the server's own clock) decides "what time is it for
  // this person right now" when checking their access window/holiday.
  tzOffsetMinutes: z.coerce.number().int().optional().default(0),
});

authRouter.post(
  "/login",
  loginLimiter,
  asyncHandler(async (req, res) => {
    const { email, password, tzOffsetMinutes } = loginSchema.parse(req.body);
    const { accessToken, refreshToken, user } = await authService.login(email, password, req.ip ?? null, tzOffsetMinutes);
    res.cookie("refreshToken", refreshToken, refreshCookieOptions());
    res.json({ accessToken, user: toUserDTO(user), permissions: await getPermissionsForRole(user.role) });
  })
);

const refreshQuerySchema = z.object({ tzOffsetMinutes: z.coerce.number().int().optional().default(0) });

authRouter.post(
  "/refresh",
  asyncHandler(async (req, res) => {
    const token = req.cookies?.refreshToken as string | undefined;
    if (!token) return res.status(401).json({ error: "UNAUTHORIZED", message: "Sessao nao encontrada" });
    const { tzOffsetMinutes } = refreshQuerySchema.parse(req.query);
    const { accessToken, refreshToken, user } = await authService.refresh(token, tzOffsetMinutes, req.ip ?? null);
    res.cookie("refreshToken", refreshToken, refreshCookieOptions());
    res.json({ accessToken, user: toUserDTO(user), permissions: await getPermissionsForRole(user.role) });
  })
);

// The browser reports that the person is using the system (mouse, keyboard, touch) — at most every 30 seconds.
// Background requests don't count: without these reports the session ends at the inactivity limit.
authRouter.post(
  "/activity",
  requireAuth,
  asyncHandler(async (req, res) => {
    if (req.auth!.sessionId) await authService.recordSessionActivity(req.auth!.sessionId);
    res.status(204).end();
  })
);

authRouter.post(
  "/logout",
  requireAuth,
  asyncHandler(async (req, res) => {
    const token = req.cookies?.refreshToken as string | undefined;
    await authService.logout(token, req.auth!.userId, req.ip ?? null);
    res.clearCookie("refreshToken", { path: "/api/auth" });
    res.status(204).end();
  })
);

authRouter.get(
  "/me",
  requireAuth,
  asyncHandler(async (req, res) => {
    const user = await prisma.user.findUniqueOrThrow({ where: { id: req.auth!.userId }, include: { whatsappConnection: true } });
    res.json({ ...toUserDTO(user), permissions: await getPermissionsForRole(user.role) });
  })
);

const accessStatusQuerySchema = z.object({ tzOffsetMinutes: z.coerce.number().int().optional().default(0) });

// Polled live by the frontend (see useAccessWindow) to drive the 20/10/1
// minute warnings and the forced logout when today's allowed window closes
// or a holiday starts mid-session — see PROMPT: "quando está próximo de
// encerrar o horário limite de acesso, aparece um pop up". Read-only: this
// never itself ends the session (login()/refresh() are the authoritative
// enforcement points) — the frontend calls POST /auth/logout once
// minutesRemainingToday hits zero.
authRouter.get(
  "/access-status",
  requireAuth,
  asyncHandler(async (req, res) => {
    // ADMIN always bypasses — same exemption as login()/refresh()'s own
    // check (see assertWithinAccessWindow's doc comment) — otherwise an
    // admin would see spurious 20/10/1-minute warnings for a logout that,
    // per that same exemption, is never actually going to happen.
    if (req.auth!.role === "ADMIN") {
      return res.json({ allowed: true, minutesRemainingToday: null });
    }
    const { tzOffsetMinutes } = accessStatusQuerySchema.parse(req.query);
    const user = await prisma.user.findUniqueOrThrow({ where: { id: req.auth!.userId } });
    const now = new Date();
    const { dateKey } = resolveLocalNow(now, tzOffsetMinutes);
    const holiday = await findApplicableHoliday(dateKey, user.workState, user.workCity);
    const decision = resolveAccessDecision(now, tzOffsetMinutes, user.accessSchedule as AccessSchedule | null, holiday?.name ?? null);
    res.json(decision);
  })
);

const forgotSchema = z.object({ email: z.string().email() });
authRouter.post(
  "/forgot-password",
  passwordResetLimiter,
  asyncHandler(async (req, res) => {
    const { email } = forgotSchema.parse(req.body);
    const result = await authService.requestPasswordReset(email);
    // Response is intentionally identical whether or not the e-mail exists.
    // devToken is only surfaced outside production, and only when SMTP
    // isn't configured (so the e-mail genuinely wasn't sent) — once e-mail
    // delivery works, the token never appears in the API response.
    res.json({
      message: "Se o e-mail existir, um link de redefinicao foi enviado.",
      devToken: env.NODE_ENV !== "production" && !result?.emailSent ? result?.token : undefined,
    });
  })
);

const resetSchema = z.object({ token: z.string().min(1), password: z.string().min(8) });
authRouter.post(
  "/reset-password",
  passwordResetLimiter,
  asyncHandler(async (req, res) => {
    const { token, password } = resetSchema.parse(req.body);
    await authService.resetPassword(token, password);
    res.json({ message: "Senha redefinida com sucesso." });
  })
);
