import type { Notification } from "@prisma/client";
import type { NotificationDTO } from "@whatsatendende/types";

export function toNotificationDTO(row: Notification): NotificationDTO {
  return {
    id: row.id,
    type: row.type,
    title: row.title,
    body: row.body,
    entityType: row.entityType,
    entityId: row.entityId,
    readAt: row.readAt ? row.readAt.toISOString() : null,
    createdAt: row.createdAt.toISOString(),
  };
}
