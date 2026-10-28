import type { Message, MessageAttachment, MessageReaction, User } from "@prisma/client";
import type { MessageDTO } from "@whatsunivida/types";

type MessageWithRelations = Message & {
  senderAgent: User | null;
  attachments: MessageAttachment[];
  reactions: (MessageReaction & { user: User | null })[];
};

function base64ToDataUrl(base64: string | null): string | null {
  return base64 ? `data:image/jpeg;base64,${base64}` : null;
}

export function toMessageDTO(message: MessageWithRelations): MessageDTO {
  return {
    id: message.id,
    conversationId: message.conversationId,
    direction: message.direction,
    type: message.type,
    status: message.status,
    body: message.body,
    senderAgentDisplayName: message.senderAgent?.displayName ?? null,
    createdAt: message.createdAt.toISOString(),
    deliveredAt: message.deliveredAt ? message.deliveredAt.toISOString() : null,
    readAt: message.readAt ? message.readAt.toISOString() : null,
    replyToMessageId: message.replyToMessageId,
    replyToStory: message.isStoryReply
      ? { text: message.storyReplyText, thumbnailUrl: base64ToDataUrl(message.storyReplyThumbnail) }
      : null,
    linkPreview: message.linkPreviewTitle
      ? {
          title: message.linkPreviewTitle,
          description: message.linkPreviewDescription,
          url: message.linkPreviewUrl ?? "",
          thumbnailUrl: base64ToDataUrl(message.linkPreviewThumbnail),
        }
      : null,
    attachments: message.attachments.map((a) => ({
      id: a.id,
      fileName: a.fileName,
      mimeType: a.mimeType,
      sizeBytes: a.sizeBytes,
      url: `/api/messages/attachments/${a.id}/download`,
      kind: a.kind,
      latitude: a.latitude ?? undefined,
      longitude: a.longitude ?? undefined,
      vcard: a.vcard ?? undefined,
      pollQuestion: a.pollQuestion ?? undefined,
      pollOptions: Array.isArray(a.pollOptions) ? (a.pollOptions as string[]) : undefined,
      eventName: a.eventName ?? undefined,
      eventDescription: a.eventDescription ?? undefined,
      eventStartAt: a.eventStartAt ? a.eventStartAt.toISOString() : undefined,
      eventJoinLink: a.eventJoinLink ?? undefined,
    })),
    reactions: message.reactions.map((r) => ({
      id: r.id,
      emoji: r.emoji,
      userId: r.userId ?? "customer",
      userDisplayName: r.user?.displayName ?? "Cliente",
    })),
  };
}
