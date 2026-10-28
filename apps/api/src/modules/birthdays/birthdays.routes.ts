import { Router } from "express";
import { z } from "zod";
import { PERMISSION } from "@whatsatendende/types";
import { asyncHandler } from "../../lib/async-handler";
import { requireAuth } from "../../middleware/auth";
import { requirePermission } from "../../lib/permissions";
import { writeAudit } from "../../lib/audit";
import { NO_REPLY_MEDIA, assertCaptionFits, deleteReplyMediaFile, replyMediaUpload, sendReplyMedia, storeReplyMedia } from "../../lib/reply-media";
import * as service from "./birthdays.service";

/** Respostas › Aniversários: the message for the client and for the beneficiary, with an optional card (image). */
export const birthdayMessagesRouter = Router();
birthdayMessagesRouter.use(requireAuth);

const kindSchema = z.enum(["HOLDER", "BENEFICIARY"]);
const requireView = requirePermission(PERMISSION.RESPOSTAS_ANIVERSARIO_VISUALIZAR);
const requireEdit = requirePermission(PERMISSION.RESPOSTAS_ANIVERSARIO_EDITAR);

birthdayMessagesRouter.get(
  "/",
  requireView,
  asyncHandler(async (_req, res) => {
    res.json(await Promise.all((await service.birthdayMessages()).map(service.toBirthdayMessageDTO)));
  })
);

birthdayMessagesRouter.patch(
  "/:kind",
  requireEdit,
  asyncHandler(async (req, res) => {
    const kind = kindSchema.parse(req.params.kind);
    const input = z.object({ text: z.string().trim().min(1).max(4000).optional(), active: z.boolean().optional() }).parse(req.body);
    const current = (await service.birthdayMessages()).find((m) => m.kind === kind)!;
    assertCaptionFits(input.text ?? current.text, Boolean(current.mediaStorageKey));
    const row = await service.updateBirthdayMessage(kind, input, req.auth!.userId);
    await writeAudit({ userId: req.auth!.userId, action: "BIRTHDAY_MESSAGE_UPDATED", entity: "BirthdayMessage", entityId: row.id, ipAddress: req.ip ?? null, metadata: { kind, ...input } });
    res.json(await service.toBirthdayMessageDTO(row));
  })
);

// The pop-up of any attendant shows (and sends) the card, so reading it only needs to be logged in.
birthdayMessagesRouter.get(
  "/:kind/media",
  asyncHandler(async (req, res) => {
    const kind = kindSchema.parse(req.params.kind);
    sendReplyMedia(req, res, (await service.birthdayMessages()).find((m) => m.kind === kind)!);
  })
);

// POST, like every other Respostas attachment (see ReplyMediaField's saveReplyMedia).
birthdayMessagesRouter.post(
  "/:kind/media",
  requireEdit,
  replyMediaUpload.single("file"),
  asyncHandler(async (req, res) => {
    const kind = kindSchema.parse(req.params.kind);
    const current = (await service.birthdayMessages()).find((m) => m.kind === kind)!;
    assertCaptionFits(current.text, true);
    const media = storeReplyMedia(req.file);
    const { row, previousKey } = await service.setBirthdayMedia(kind, media, req.auth!.userId);
    deleteReplyMediaFile(previousKey);
    await writeAudit({ userId: req.auth!.userId, action: "BIRTHDAY_MESSAGE_MEDIA_SET", entity: "BirthdayMessage", entityId: row.id, ipAddress: req.ip ?? null, metadata: { kind, fileName: media.mediaFileName } });
    res.json(await service.toBirthdayMessageDTO(row));
  })
);

birthdayMessagesRouter.delete(
  "/:kind/media",
  requireEdit,
  asyncHandler(async (req, res) => {
    const kind = kindSchema.parse(req.params.kind);
    const { row, previousKey } = await service.setBirthdayMedia(kind, NO_REPLY_MEDIA, req.auth!.userId);
    deleteReplyMediaFile(previousKey);
    res.json(await service.toBirthdayMessageDTO(row));
  })
);
