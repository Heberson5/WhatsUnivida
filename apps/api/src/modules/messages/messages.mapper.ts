import type { Message, MessageAttachment, MessageReaction, PollVote, User } from "@prisma/client";
import { pollResultsOf } from "./poll-votes.service";
import type { MessageDTO } from "@whatsatendende/types";

// Messages the system sent on its own show who "wrote" them instead of an agent name.
const AUTOMATED_SENDER_LABEL: Record<string, string> = { FLOW: "Fluxo automático", SURVEY: "Pesquisa de satisfação", WORK_SCHEDULE: "Fora do expediente", QUEUE_WAIT: "Mensagem de espera" };

type MessageWithRelations = Message & {
  senderAgent: User | null;
  attachments: (MessageAttachment & { pollVotes?: PollVote[] })[];
  reactions: (MessageReaction & { user: User | null })[];
};

// A group participant keeps one color, from their WhatsApp id — like WhatsApp itself does.
const PARTICIPANT_COLORS = ["#0E7490", "#7C3AED", "#C2410C", "#047857", "#B91C1C", "#1D4ED8", "#BE185D", "#4D7C0F"];

function participantColor(jid: string): string {
  let hash = 0;
  for (const ch of jid) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  return PARTICIPANT_COLORS[hash % PARTICIPANT_COLORS.length];
}

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
    senderAgentDisplayName: message.senderAgent?.displayName ?? AUTOMATED_SENDER_LABEL[message.automatedBy ?? ""] ?? null,
    createdAt: message.createdAt.toISOString(),
    deliveredAt: message.deliveredAt ? message.deliveredAt.toISOString() : null,
    readAt: message.readAt ? message.readAt.toISOString() : null,
    replyToMessageId: message.replyToMessageId,
    forwarded: message.forwardedFromMessageId !== null,
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
      ...(a.kind === "POLL" && {
        pollMultiple: a.pollSelectableCount !== null && a.pollSelectableCount !== 1,
        pollResults: pollResultsOf(Array.isArray(a.pollOptions) ? (a.pollOptions as string[]) : [], a.pollVotes ?? [], Boolean(a.pollSecret)),
      }),
      eventName: a.eventName ?? undefined,
      eventDescription: a.eventDescription ?? undefined,
      eventStartAt: a.eventStartAt ? a.eventStartAt.toISOString() : undefined,
      eventJoinLink: a.eventJoinLink ?? undefined,
      ...(a.isGif ? { isGif: true } : {}),
    })),
    reactions: message.reactions.map((r) => ({
      id: r.id,
      emoji: r.emoji,
      userId: r.userId ?? (r.participantJid ? `participant:${r.participantJid}` : "customer"),
      // In a group, who reacted: the participant's name, or their number.
      userDisplayName: r.user?.displayName ?? r.participantName ?? (r.participantPhone ? `+${r.participantPhone}` : r.participantJid ? "Participante" : "Cliente"),
    })),
    senderParticipant:
      message.direction === "INBOUND" && (message.senderParticipantJid || message.senderParticipantName)
        ? {
            name: message.senderParticipantName ?? (message.senderParticipantPhone ? `+${message.senderParticipantPhone}` : "Participante"),
            phone: message.senderParticipantPhone,
            color: participantColor(message.senderParticipantJid ?? message.senderParticipantName ?? ""),
          }
        : null,
  };
}
