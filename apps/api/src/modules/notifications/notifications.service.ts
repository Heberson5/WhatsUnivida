import { prisma } from "../../lib/prisma";
import { Errors } from "../../lib/http-error";

export interface CreateNotificationInput {
  userId: string;
  type: string;
  title: string;
  body?: string | null;
  entityType?: string | null;
  entityId?: string | null;
}

export async function createNotification(input: CreateNotificationInput) {
  return prisma.notification.create({
    data: {
      userId: input.userId,
      type: input.type,
      title: input.title,
      body: input.body ?? null,
      entityType: input.entityType ?? null,
      entityId: input.entityId ?? null,
    },
  });
}

/** Most recent first, capped — this is a bell dropdown, not an archive to page through. */
export async function listNotifications(userId: string, limit = 30) {
  return prisma.notification.findMany({ where: { userId }, orderBy: { createdAt: "desc" }, take: limit });
}

export async function countUnread(userId: string): Promise<number> {
  return prisma.notification.count({ where: { userId, readAt: null } });
}

export async function markNotificationRead(id: string, userId: string) {
  const result = await prisma.notification.updateMany({ where: { id, userId, readAt: null }, data: { readAt: new Date() } });
  if (result.count === 0) {
    const exists = await prisma.notification.findFirst({ where: { id, userId } });
    if (!exists) throw Errors.notFound("Notificacao nao encontrada");
    // Already read — idempotent, not an error.
  }
}

export async function markAllNotificationsRead(userId: string): Promise<void> {
  await prisma.notification.updateMany({ where: { userId, readAt: null }, data: { readAt: new Date() } });
}
