import { Router } from "express";
import { asyncHandler } from "../../lib/async-handler";
import { requireAuth } from "../../middleware/auth";
import { toNotificationDTO } from "./notifications.mapper";
import * as service from "./notifications.service";

export const notificationsRouter = Router();

notificationsRouter.use(requireAuth);

notificationsRouter.get(
  "/",
  asyncHandler(async (req, res) => {
    const [rows, unreadCount] = await Promise.all([service.listNotifications(req.auth!.userId), service.countUnread(req.auth!.userId)]);
    res.json({ items: rows.map(toNotificationDTO), unreadCount });
  })
);

notificationsRouter.post(
  "/:id/read",
  asyncHandler(async (req, res) => {
    await service.markNotificationRead(req.params.id, req.auth!.userId);
    res.status(204).end();
  })
);

notificationsRouter.post(
  "/read-all",
  asyncHandler(async (req, res) => {
    await service.markAllNotificationsRead(req.auth!.userId);
    res.status(204).end();
  })
);
