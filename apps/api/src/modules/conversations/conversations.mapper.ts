import type { Conversation, Contact, ConversationTransfer, User, WhatsAppConnection, MetaConnection } from "@prisma/client";
import { birthdaysToday, businessDay, type ContactBirthdayEntry, type ConversationListItemDTO } from "@whatsatendende/types";
import { autoMessageBlocksOf } from "../../lib/auto-messages";
import { env } from "../../config/env";

type ConversationWithRelations = Conversation & {
  contact: Contact & { tags?: { tag: { id?: string; name: string; color?: string; blockedAutoMessages: string[] } }[] };
  assignedAgent: User | null;
  interventionBy?: User | null;
  // Exactly one of these two is non-null, depending on `channel` — see
  // the Channel enum's doc comment in schema.prisma.
  whatsappConnection: WhatsAppConnection | null;
  metaConnection: MetaConnection | null;
  transfers: (ConversationTransfer & { fromAgent: User; toAgent: User })[];
  _lastMessageBody?: string | null;
  _unreadCount?: number;
  _count?: { scheduledMessages?: number };
};

// True when this contact's `phone` is still just the raw digits of its @lid
// privacy id — a placeholder stored because nothing better was known yet
// (see findOrCreateContact), not a real phone number. Showing it as "the
// number" in Atendimento/Gestão is what used to look like "aparece o número
// do WhatsApp e não o número real do cliente" — see PROMPT.
function isUnresolvedLidPhone(contact: Contact): boolean {
  return Boolean(contact.providerChatId?.endsWith("@lid") && contact.phone === contact.providerChatId.split("@")[0]);
}

/**
 * Maps a conversation for queue/list display. `revealPreview` controls the
 * privacy rule from PROMPT section 9/10: before an agent accepts a
 * conversation, no message preview/content may reach the client at all —
 * so this is enforced here, server-side, not just hidden by CSS.
 */
export function toConversationListItemDTO(
  conversation: ConversationWithRelations,
  revealPreview: boolean
): ConversationListItemDTO {
  const latestTransfer = conversation.transfers[0];
  // Exactly one of these is populated (see Channel's doc comment) — reading
  // through whichever one it is lets every existing consumer of
  // whatsappConnection* keep working unchanged for an Instagram/Messenger
  // conversation too, instead of blowing up on a null WhatsAppConnection.
  const connection = conversation.whatsappConnection ?? conversation.metaConnection!;
  return {
    id: conversation.id,
    contact: {
      id: conversation.contact.id,
      phone: isUnresolvedLidPhone(conversation.contact) ? null : conversation.contact.phone,
      name: conversation.contact.name,
      photoUrl: conversation.contact.photoUrl,
      firstConversationAt: conversation.contact.firstConversationAt.toISOString(),
      lastInteractionAt: conversation.contact.lastInteractionAt.toISOString(),
    },
    status: conversation.status,
    assignedAgentId: conversation.assignedAgentId,
    assignedAgentName: conversation.assignedAgent?.displayName ?? null,
    intervention: conversation.interventionById
      ? { userId: conversation.interventionById, name: conversation.interventionBy?.displayName ?? "Gestor", startedAt: (conversation.interventionStartedAt ?? new Date()).toISOString() }
      : null,
    channel: conversation.channel,
    whatsappConnectionId: connection.id,
    whatsappConnectionName: connection.name,
    whatsappConnectionColor: connection.color,
    whatsappConnectionStatus: connection.status,
    enteredQueueAt: conversation.enteredQueueAt.toISOString(),
    acceptedAt: conversation.acceptedAt ? conversation.acceptedAt.toISOString() : null,
    lastMessageAt: conversation.lastMessageAt.toISOString(),
    lastMessagePreview: revealPreview ? (conversation._lastMessageBody ?? null) : null,
    startedOnDevice: conversation.startedOnDevice,
    awaitingReplySince: revealPreview && conversation.awaitingReplySince ? conversation.awaitingReplySince.toISOString() : null,
    noReturnCloseAt: conversation.noReturnCloseAt?.toISOString() ?? null,
    noReturnHold: conversation.noReturnHold,
    autoMessageBlocks: autoMessageBlocksOf(conversation.contact.tags),
    tags: (conversation.contact.tags ?? []).flatMap(({ tag }) => (tag.id && tag.color ? [{ id: tag.id, name: tag.name, color: tag.color }] : [])),
    scheduledMessagePending: (conversation._count?.scheduledMessages ?? 0) > 0,
    birthdaysToday: birthdaysToday(conversation.contact.birthdays as ContactBirthdayEntry[] | null, businessDay(new Date(), env.BUSINESS_TZ_OFFSET_MINUTES)),
    unreadCount: conversation._unreadCount ?? 0,
    isNew: conversation.status === "NEW",
    pendingTransferDeadline: revealPreview && conversation.pendingTransferDeadline ? conversation.pendingTransferDeadline.toISOString() : null,
    transfer:
      revealPreview && latestTransfer && conversation.status === "TRANSFERRED"
        ? {
            fromAgentName: latestTransfer.fromAgent.displayName,
            toAgentName: latestTransfer.toAgent.displayName,
            at: latestTransfer.createdAt.toISOString(),
            note: latestTransfer.note,
          }
        : null,
  };
}
