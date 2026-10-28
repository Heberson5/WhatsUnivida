import { Router } from "express";
import { z } from "zod";
import { PERMISSION } from "@whatsatendende/types";
import { asyncHandler } from "../../lib/async-handler";
import { requireAuth } from "../../middleware/auth";
import { requirePermission } from "../../lib/permissions";
import { realtimeEvents } from "../../realtime/realtime";
import * as service from "./agent-tools.service";

/** Atendimento's own helpers for whoever attends: pin, "lembrar de retornar", "agendar envio" and "Meu dia". */
export const agentToolsRouter = Router();
agentToolsRouter.use(requireAuth, requirePermission(PERMISSION.ATENDIMENTO_ACESSAR));

agentToolsRouter.get(
  "/extras",
  asyncHandler(async (req, res) => {
    res.json(await service.getExtras(req.auth!.userId));
  })
);

agentToolsRouter.get(
  "/my-day",
  asyncHandler(async (req, res) => {
    const { tzOffsetMinutes } = z.object({ tzOffsetMinutes: z.coerce.number().default(0) }).parse(req.query);
    res.json(await service.getMyDay(req.auth!.userId, tzOffsetMinutes));
  })
);

const pinSchema = z.object({ pinned: z.boolean() });
agentToolsRouter.put(
  "/pins/:conversationId",
  asyncHandler(async (req, res) => {
    const { pinned } = pinSchema.parse(req.body);
    await service.assertCanUseConversation(req.params.conversationId, req.auth!);
    await service.setPinned(req.auth!.userId, req.params.conversationId, pinned);
    realtimeEvents.agentExtrasChanged(req.auth!.userId);
    res.status(204).end();
  })
);

const reminderSchema = z.object({ conversationId: z.string().uuid(), remindAt: z.coerce.date(), note: z.string().max(200).nullish() });
agentToolsRouter.post(
  "/reminders",
  asyncHandler(async (req, res) => {
    const input = reminderSchema.parse(req.body);
    await service.assertCanUseConversation(input.conversationId, req.auth!);
    const reminder = await service.createReminder(req.auth!.userId, input);
    realtimeEvents.agentExtrasChanged(req.auth!.userId);
    res.status(201).json(reminder);
  })
);

agentToolsRouter.post(
  "/reminders/:id/snooze",
  asyncHandler(async (req, res) => {
    const { minutes } = z.object({ minutes: z.number().int().min(1).max(24 * 60) }).parse(req.body);
    const reminder = await service.snoozeReminder(req.auth!.userId, req.params.id, minutes);
    realtimeEvents.agentExtrasChanged(req.auth!.userId);
    res.json(reminder);
  })
);

agentToolsRouter.delete(
  "/reminders/:id",
  asyncHandler(async (req, res) => {
    await service.deleteReminder(req.auth!.userId, req.params.id);
    realtimeEvents.agentExtrasChanged(req.auth!.userId);
    res.status(204).end();
  })
);

const scheduleSchema = z.object({ conversationId: z.string().uuid(), body: z.string().trim().min(1).max(4096), sendAt: z.coerce.date() });
agentToolsRouter.post(
  "/scheduled-messages",
  asyncHandler(async (req, res) => {
    const input = scheduleSchema.parse(req.body);
    await service.assertCanUseConversation(input.conversationId, req.auth!);
    const scheduled = await service.scheduleMessage(req.auth!.userId, input);
    realtimeEvents.agentExtrasChanged(req.auth!.userId);
    res.status(201).json(scheduled);
  })
);

agentToolsRouter.delete(
  "/scheduled-messages/:id",
  asyncHandler(async (req, res) => {
    await service.cancelScheduledMessage(req.auth!.userId, req.params.id);
    realtimeEvents.agentExtrasChanged(req.auth!.userId);
    res.status(204).end();
  })
);
