import type { Channel } from "@prisma/client";
import { sendOutboundText } from "../whatsapp/whatsapp.service";
import { sendMetaMessage } from "../meta/meta.service";

// A conversation's connection is exactly one of whatsappConnectionId/metaConnectionId depending on `channel` (see
// Channel's doc comment in schema.prisma); Instagram/Messenger support plain text via the same Send API
// metaService.sendMetaMessage already uses for agent-typed replies (see messages.routes.ts's /text route).
export async function sendOutboundTextViaChannel(
  conversation: { channel: Channel; whatsappConnectionId: string | null; contact: { phone: string | null; externalUserId: string | null } },
  messageId: string,
  text: string,
  senderDisplayName: string | null
) {
  if (conversation.channel === "WHATSAPP") {
    return sendOutboundText(conversation.whatsappConnectionId!, messageId, conversation.contact.phone!, text, senderDisplayName);
  }
  return sendMetaMessage(conversation.channel, messageId, conversation.contact.externalUserId!, text);
}
