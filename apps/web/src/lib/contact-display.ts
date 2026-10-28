import type { Channel } from "@whatsatendende/types";

const CHANNEL_FALLBACK_LABEL: Record<Channel, string> = {
  WHATSAPP: "Contato do WhatsApp",
  INSTAGRAM: "Contato do Instagram",
  MESSENGER: "Contato do Messenger",
};

/**
 * `contact.phone` is null when WhatsApp hasn't revealed this contact's real
 * phone number yet (see conversations.mapper.ts's isUnresolvedLidPhone) — or
 * when this is an Instagram/Messenger contact, which never has one at all.
 * Falls back to a generic, channel-aware label instead of ever showing
 * nothing at all.
 */
export function contactDisplayName(contact: { name: string | null; phone: string | null }, channel: Channel = "WHATSAPP"): string {
  return contact.name || contact.phone || CHANNEL_FALLBACK_LABEL[channel];
}
