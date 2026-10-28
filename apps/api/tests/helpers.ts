import bcrypt from "bcryptjs";
import { prisma } from "../src/lib/prisma";
import type { Role } from "@prisma/client";

export async function resetDatabase() {
  // Order matters: children before parents.
  await prisma.messageReaction.deleteMany();
  await prisma.messageAttachment.deleteMany();
  await prisma.message.deleteMany();
  await prisma.conversationEvent.deleteMany();
  await prisma.conversationTransfer.deleteMany();
  await prisma.conversationAssignment.deleteMany();
  await prisma.conversation.deleteMany();
  await prisma.contact.deleteMany();
  await prisma.auditLog.deleteMany();
  await prisma.notification.deleteMany();
  await prisma.refreshToken.deleteMany();
  await prisma.passwordResetToken.deleteMany();
  await prisma.user.deleteMany();
  await prisma.systemSetting.deleteMany();
  await prisma.quickReply.deleteMany();
  await prisma.whatsAppConnection.deleteMany();
  await prisma.rolePermission.deleteMany();
  await prisma.holiday.deleteMany();
  await prisma.holidaySyncCursor.deleteMany();
}

// Defaults to CONNECTED — nearly every test using this helper is actually
// exercising conversation/message flows that now require a live connection
// (see acceptConversation / loadConversationForAgent's CONNECTED gate), not
// testing connection status itself. Pass "DISCONNECTED" explicitly for a
// test that specifically covers that gate.
export async function createTestConnection(name: string, status: "DISCONNECTED" | "CONNECTED" = "CONNECTED") {
  return prisma.whatsAppConnection.create({ data: { name, status } });
}

export async function createTestUser(input: {
  email: string;
  role: Role;
  displayName?: string;
  status?: "ACTIVE" | "INACTIVE";
  presence?: "ONLINE" | "AWAY" | "OFFLINE";
  whatsappConnectionId?: string;
  workState?: string;
  workCity?: string;
  accessSchedule?: object;
}) {
  const passwordHash = await bcrypt.hash("Test@1234", 4);
  return prisma.user.create({
    data: {
      email: input.email,
      fullName: input.displayName ?? input.email,
      displayName: input.displayName ?? input.email,
      role: input.role,
      status: input.status ?? "ACTIVE",
      presence: input.presence ?? "OFFLINE",
      passwordHash,
      whatsappConnectionId: input.whatsappConnectionId,
      workState: input.workState,
      workCity: input.workCity,
      accessSchedule: input.accessSchedule,
    },
  });
}

// A MANAGER only sees/receives from a connection they created themselves
// or were explicitly granted (see connection-access.ts) — call this in a
// test's setup to grant a test MANAGER access to a connection they didn't
// create, same as an ADMIN would via PUT /whatsapp/managers/:userId/access.
export async function grantManagerConnectionAccess(
  managerId: string,
  connectionId: string,
  opts: { canManage?: boolean; canReceiveConversations?: boolean } = {}
) {
  return prisma.managerConnectionAccess.create({
    data: {
      managerId,
      whatsappConnectionId: connectionId,
      canManage: opts.canManage ?? true,
      canReceiveConversations: opts.canReceiveConversations ?? true,
    },
  });
}

export async function createWaitingConversation(phone: string, connectionId: string) {
  const contact = await prisma.contact.create({ data: { phone, name: `Cliente ${phone}`, whatsappConnectionId: connectionId } });
  const conversation = await prisma.conversation.create({
    data: { contactId: contact.id, whatsappConnectionId: connectionId, status: "WAITING", enteredQueueAt: new Date(), lastMessageAt: new Date() },
  });
  return { contact, conversation };
}

export const TEST_PASSWORD = "Test@1234";
