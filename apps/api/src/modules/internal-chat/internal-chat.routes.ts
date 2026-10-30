import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { Router } from "express";
import multer from "multer";
import { z } from "zod";
import { CHAT_MAX_AUDIO_SECONDS, PERMISSION } from "@whatsatendende/types";
import { asyncHandler } from "../../lib/async-handler";
import { requireAuth, requireAuthFromHeaderOrQuery, requireRole } from "../../middleware/auth";
import { isPermissionAllowed, requirePermission } from "../../lib/permissions";
import { writeAudit } from "../../lib/audit";
import { Errors } from "../../lib/http-error";
import { env } from "../../config/env";
import * as service from "./internal-chat.service";

export const internalChatRouter = Router();

// Before the router-wide requireAuth: a document preview opens the file by URL, with the token in it.
internalChatRouter.get(
  "/attachments/:messageId",
  requireAuthFromHeaderOrQuery,
  asyncHandler(async (req, res) => {
    const oversight = req.auth!.role === "ADMIN" || (await isPermissionAllowed(req.auth!.role, PERMISSION.CHAT_INTERNO_ACOMPANHAR));
    const message = await service.attachmentFor(req.params.messageId, req.auth!.userId, oversight);
    res.setHeader("Content-Type", message.attachmentMimeType!);
    res.setHeader("Content-Disposition", `inline; filename="${encodeURIComponent(message.attachmentName!)}"`);
    res.sendFile(path.resolve(env.UPLOAD_DIR, message.attachmentKey!));
  })
);

internalChatRouter.use(requireAuth);

const MAX_FILE_MB = 25;
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_FILE_MB * 1024 * 1024 } });
const requireUse = requirePermission(PERMISSION.CHAT_INTERNO_USAR);
const requireOversight = requirePermission(PERMISSION.CHAT_INTERNO_ACOMPANHAR);
const beforeSchema = z.object({ before: z.string().datetime().optional() });

// --- Gestão › Chat interno (administrador only): reads everything, never marks anything as read, every read audited. ---

internalChatRouter.get(
  "/oversight/rooms",
  requireOversight,
  asyncHandler(async (_req, res) => {
    res.json(await service.oversightRooms());
  })
);

internalChatRouter.delete(
  "/oversight/messages/:messageId",
  requireRole("ADMIN"),
  asyncHandler(async (req, res) => {
    await service.adminDeleteMessage(req.params.messageId);
    await writeAudit({ userId: req.auth!.userId, action: "INTERNAL_CHAT_MESSAGE_ERASED", entity: "ChatMessage", entityId: req.params.messageId, ipAddress: req.ip ?? null });
    res.status(204).end();
  })
);

internalChatRouter.delete(
  "/oversight/rooms/:roomId",
  requireRole("ADMIN"),
  asyncHandler(async (req, res) => {
    await service.adminDeleteRoom(req.params.roomId);
    await writeAudit({ userId: req.auth!.userId, action: "INTERNAL_CHAT_ROOM_ERASED", entity: "ChatRoom", entityId: req.params.roomId, ipAddress: req.ip ?? null });
    res.status(204).end();
  })
);

internalChatRouter.get(
  "/oversight/rooms/:roomId/messages",
  requireOversight,
  asyncHandler(async (req, res) => {
    const { before } = beforeSchema.parse(req.query);
    const messages = await service.oversightMessages(req.params.roomId, before);
    // One audit line per conversation opened, not per page scrolled back.
    if (!before) await writeAudit({ userId: req.auth!.userId, action: "INTERNAL_CHAT_OVERSIGHT_READ", entity: "ChatRoom", entityId: req.params.roomId, ipAddress: req.ip ?? null });
    res.json(messages);
  })
);

internalChatRouter.get(
  "/oversight/messages/:messageId/info",
  requireOversight,
  asyncHandler(async (req, res) => {
    res.json(await service.messageInfo(req.params.messageId, null));
  })
);

// --- Using the chat ---

internalChatRouter.use(requireUse);

const role = (req: { auth?: { role: "ADMIN" | "MANAGER" | "AGENT" } }) => req.auth!.role;
const durationSeconds = z.number().int().min(1).max(30 * 86_400);

internalChatRouter.get(
  "/users",
  asyncHandler(async (_req, res) => {
    res.json(await service.listChatUsers());
  })
);

internalChatRouter.get(
  "/rooms",
  asyncHandler(async (req, res) => {
    res.json(await service.listRooms(req.auth!.userId, role(req)));
  })
);

internalChatRouter.get(
  "/search",
  asyncHandler(async (req, res) => {
    const { q } = z.object({ q: z.string().trim().min(2).max(100) }).parse(req.query);
    res.json(await service.searchMessages(req.auth!.userId, q));
  })
);

internalChatRouter.post(
  "/direct",
  asyncHandler(async (req, res) => {
    const { userId } = z.object({ userId: z.string().uuid() }).parse(req.body);
    res.json(await service.openDirect(req.auth!.userId, userId, role(req)));
  })
);

internalChatRouter.post(
  "/groups",
  asyncHandler(async (req, res) => {
    const { name, memberIds, description, icon } = z
      .object({
        name: z.string().trim().min(1).max(60),
        memberIds: z.array(z.string().uuid()).min(1).max(200),
        description: z.string().max(200).nullish(),
        icon: z.string().max(16).nullish(),
      })
      .parse(req.body);
    res.status(201).json(await service.createGroup(req.auth!.userId, name, memberIds, { description, icon }));
  })
);

internalChatRouter.patch(
  "/rooms/:roomId",
  asyncHandler(async (req, res) => {
    const input = z.object({ name: z.string().trim().min(1).max(60).optional(), description: z.string().max(200).nullish(), icon: z.string().max(16).nullish() }).parse(req.body);
    res.json(await service.updateGroup(req.params.roomId, req.auth!.userId, input));
  })
);

internalChatRouter.delete(
  "/rooms/:roomId",
  asyncHandler(async (req, res) => {
    await service.deleteGroup(req.params.roomId, req.auth!.userId);
    await writeAudit({ userId: req.auth!.userId, action: "INTERNAL_CHAT_GROUP_DELETED", entity: "ChatRoom", entityId: req.params.roomId, ipAddress: req.ip ?? null });
    res.status(204).end();
  })
);

internalChatRouter.get(
  "/rooms/:roomId/messages",
  asyncHandler(async (req, res) => {
    const { before } = beforeSchema.parse(req.query);
    res.json(await service.listMessages(req.params.roomId, req.auth!.userId, before));
  })
);

const newMessageSchema = z.object({
  body: z.string().max(4000).optional(),
  conversationId: z.string().uuid().optional(),
  replyToId: z.string().uuid().nullish(),
  mentions: z.array(z.string().max(40)).max(200).optional(),
  ttlSeconds: durationSeconds.nullish(),
});

internalChatRouter.post(
  "/rooms/:roomId/messages",
  asyncHandler(async (req, res) => {
    const input = newMessageSchema.parse(req.body);
    res.status(201).json(await service.sendMessage(req.params.roomId, req.auth!.userId, input));
  })
);

// Multipart sends every field as text: these turn "true", "60" and "[...]" back into their values.
const formBool = z.preprocess((v) => v === "true" || v === true, z.boolean());
const formInt = z.preprocess((v) => (v === undefined || v === "" ? undefined : Number(v)), z.number().int().optional());
const formJson = <T extends z.ZodTypeAny>(schema: T) => z.preprocess((v) => (typeof v === "string" && v ? JSON.parse(v) : v), schema);

internalChatRouter.post(
  "/rooms/:roomId/files",
  upload.single("file"),
  asyncHandler(async (req, res) => {
    if (!req.file) throw Errors.badRequest("Nenhum arquivo enviado");
    const fields = z
      .object({
        body: z.string().max(4000).optional(),
        replyToId: z.string().uuid().optional(),
        mentions: formJson(z.array(z.string().max(40)).max(200)).optional(),
        ttlSeconds: formInt.pipe(durationSeconds.optional()),
        viewOnce: formBool.optional(),
        audioDurationMs: formInt.pipe(z.number().int().min(0).max(CHAT_MAX_AUDIO_SECONDS * 1000 + 999).optional()),
        audioWaveform: formJson(z.array(z.number().int().min(0).max(100)).max(120)).optional(),
      })
      .parse(req.body ?? {});
    await service.memberOrThrow(req.params.roomId, req.auth!.userId);
    const isAudio = fields.audioDurationMs !== undefined;
    if (isAudio && !req.file.mimetype.startsWith("audio/")) throw Errors.badRequest("O audio precisa ser um arquivo de audio");
    const key = `${randomUUID()}${path.extname(req.file.originalname)}`;
    fs.writeFileSync(path.join(env.UPLOAD_DIR, key), req.file.buffer);
    res.status(201).json(
      await service.sendMessage(req.params.roomId, req.auth!.userId, {
        body: fields.body,
        replyToId: fields.replyToId,
        mentions: fields.mentions,
        ttlSeconds: fields.ttlSeconds,
        viewOnce: fields.viewOnce,
        attachment: { key, name: req.file.originalname, mimeType: req.file.mimetype, size: req.file.size },
        audio: isAudio ? { durationMs: fields.audioDurationMs!, waveform: fields.audioWaveform ?? [] } : undefined,
      })
    );
  })
);

internalChatRouter.post(
  "/rooms/:roomId/polls",
  asyncHandler(async (req, res) => {
    const input = z
      .object({ question: z.string().trim().min(1).max(300), options: z.array(z.string().trim().min(1).max(100)).min(2).max(12), multiple: z.boolean() })
      .parse(req.body);
    res.status(201).json(await service.createPoll(req.params.roomId, req.auth!.userId, input));
  })
);

internalChatRouter.put(
  "/polls/:pollId/votes",
  asyncHandler(async (req, res) => {
    const { optionIds } = z.object({ optionIds: z.array(z.string().uuid()).max(12) }).parse(req.body);
    res.json(await service.vote(req.params.pollId, req.auth!.userId, optionIds));
  })
);

internalChatRouter.patch(
  "/messages/:messageId",
  asyncHandler(async (req, res) => {
    const { body } = z.object({ body: z.string().max(4000) }).parse(req.body);
    res.json(await service.editMessage(req.params.messageId, req.auth!.userId, body));
  })
);

internalChatRouter.delete(
  "/messages/:messageId",
  asyncHandler(async (req, res) => {
    await service.deleteMessage(req.params.messageId, req.auth!.userId);
    res.status(204).end();
  })
);

internalChatRouter.put(
  "/messages/:messageId/reaction",
  asyncHandler(async (req, res) => {
    const { emoji } = z.object({ emoji: z.string().min(1).max(16).nullable() }).parse(req.body);
    res.json(await service.react(req.params.messageId, req.auth!.userId, emoji));
  })
);

internalChatRouter.get(
  "/messages/:messageId/info",
  asyncHandler(async (req, res) => {
    res.json(await service.messageInfo(req.params.messageId, req.auth!.userId));
  })
);

internalChatRouter.post(
  "/rooms/:roomId/pins",
  asyncHandler(async (req, res) => {
    const { messageId, days } = z.object({ messageId: z.string().uuid(), days: z.union([z.literal(1), z.literal(7), z.literal(30)]).nullable() }).parse(req.body);
    res.json(await service.pinMessage(req.params.roomId, req.auth!.userId, role(req), messageId, days));
  })
);

internalChatRouter.delete(
  "/rooms/:roomId/pins/:messageId",
  asyncHandler(async (req, res) => {
    res.json(await service.unpinMessage(req.params.roomId, req.auth!.userId, role(req), req.params.messageId));
  })
);

internalChatRouter.post(
  "/rooms/:roomId/read",
  asyncHandler(async (req, res) => {
    await service.markRead(req.params.roomId, req.auth!.userId);
    res.status(204).end();
  })
);

internalChatRouter.post(
  "/rooms/:roomId/typing",
  asyncHandler(async (req, res) => {
    const { kind } = z.object({ kind: z.enum(["typing", "recording"]).default("typing") }).parse(req.body ?? {});
    await service.typing(req.params.roomId, req.auth!.userId, kind);
    res.status(204).end();
  })
);

internalChatRouter.post(
  "/rooms/:roomId/nudge",
  asyncHandler(async (req, res) => {
    const { userId } = z.object({ userId: z.string().uuid().optional() }).parse(req.body ?? {});
    res.status(201).json(await service.nudge(req.params.roomId, req.auth!.userId, userId));
  })
);

internalChatRouter.put(
  "/rooms/:roomId/auto-delete",
  asyncHandler(async (req, res) => {
    const { seconds } = z.object({ seconds: durationSeconds.nullable() }).parse(req.body);
    res.json(await service.setAutoDelete(req.params.roomId, req.auth!.userId, seconds));
  })
);

internalChatRouter.put(
  "/rooms/:roomId/mute",
  asyncHandler(async (req, res) => {
    const { until } = z.object({ until: z.string().datetime().nullable() }).parse(req.body);
    res.json(await service.setMuted(req.params.roomId, req.auth!.userId, until ? new Date(until) : null));
  })
);

internalChatRouter.put(
  "/rooms/:roomId/favorite",
  asyncHandler(async (req, res) => {
    const { favorite } = z.object({ favorite: z.boolean() }).parse(req.body);
    res.json(await service.setFavorite(req.params.roomId, req.auth!.userId, favorite));
  })
);

internalChatRouter.post(
  "/rooms/:roomId/members",
  asyncHandler(async (req, res) => {
    const { userIds, canSeeHistory } = z.object({ userIds: z.array(z.string().uuid()).min(1).max(200), canSeeHistory: z.boolean() }).parse(req.body);
    res.json(await service.addMembers(req.params.roomId, req.auth!.userId, userIds, canSeeHistory));
  })
);

internalChatRouter.delete(
  "/rooms/:roomId/members/:userId",
  asyncHandler(async (req, res) => {
    res.json(await service.removeMember(req.params.roomId, req.auth!.userId, req.params.userId));
  })
);

internalChatRouter.put(
  "/rooms/:roomId/members/:userId/admin",
  asyncHandler(async (req, res) => {
    const { admin } = z.object({ admin: z.boolean() }).parse(req.body);
    res.json(await service.setAdmin(req.params.roomId, req.auth!.userId, req.params.userId, admin));
  })
);

internalChatRouter.post(
  "/rooms/:roomId/close",
  asyncHandler(async (req, res) => {
    const { forBoth } = z.object({ forBoth: z.boolean() }).parse(req.body);
    await service.closeDirect(req.params.roomId, req.auth!.userId, forBoth);
    if (forBoth) await writeAudit({ userId: req.auth!.userId, action: "INTERNAL_CHAT_DIRECT_CLOSED", entity: "ChatRoom", entityId: req.params.roomId, ipAddress: req.ip ?? null });
    res.status(204).end();
  })
);

internalChatRouter.post(
  "/rooms/:roomId/leave",
  asyncHandler(async (req, res) => {
    await service.leaveGroup(req.params.roomId, req.auth!.userId);
    res.status(204).end();
  })
);
