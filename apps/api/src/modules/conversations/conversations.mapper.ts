import type { Conversation, Contact, ConversationTransfer, User, WhatsAppConnection } from "@prisma/client";
import type { ConversationListItemDTO } from "@whatsunivida/types";

type ConversationWithRelations = Conversation & {
  contact: Contact;
  assignedAgent: User | null;
  whatsappConnection: WhatsAppConnection;
  transfers: (ConversationTransfer & { fromAgent: User; toAgent: User })[];
  _lastMessageBody?: string | null;
  _unreadCount?: number;
};

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
  return {
    id: conversation.id,
    contact: {
      id: conversation.contact.id,
      phone: conversation.contact.phone,
      name: conversation.contact.name,
      photoUrl: conversation.contact.photoUrl,
      firstConversationAt: conversation.contact.firstConversationAt.toISOString(),
      lastInteractionAt: conversation.contact.lastInteractionAt.toISOString(),
    },
    status: conversation.status,
    assignedAgentId: conversation.assignedAgentId,
    assignedAgentName: conversation.assignedAgent?.displayName ?? null,
    whatsappConnectionId: conversation.whatsappConnectionId,
    whatsappConnectionName: conversation.whatsappConnection.name,
    whatsappConnectionColor: conversation.whatsappConnection.color,
    whatsappConnectionStatus: conversation.whatsappConnection.status,
    enteredQueueAt: conversation.enteredQueueAt.toISOString(),
    acceptedAt: conversation.acceptedAt ? conversation.acceptedAt.toISOString() : null,
    lastMessageAt: conversation.lastMessageAt.toISOString(),
    lastMessagePreview: revealPreview ? (conversation._lastMessageBody ?? null) : null,
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
