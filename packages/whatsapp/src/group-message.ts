import type { GroupMessageSender } from "./types";

/** The part of a Baileys message key that says who wrote a group message (structurally compatible with its own type). */
export interface BaileysGroupMessageKey {
  remoteJid?: string | null;
  participant?: string | null;
  /** The participant's phone-number JID, when WhatsApp reveals it next to an opaque @lid participant. */
  participantPn?: string | null;
  participantAlt?: string | null;
}

export function isGroupChat(chatId: string): boolean {
  return chatId.endsWith("@g.us");
}

/**
 * Who wrote a group message, from its Baileys key and pushName. WhatsApp
 * identifies the participant by a phone-number JID or, more and more, by an
 * opaque @lid id — the real number then only comes in participantPn (or
 * participantAlt), and sometimes not at all. Null for a 1:1 chat.
 */
export function groupSenderFromBaileys(key: BaileysGroupMessageKey, pushName?: string | null): GroupMessageSender | null {
  const chatId = key.remoteJid ?? "";
  if (!isGroupChat(chatId)) return null;
  const participantJid = key.participant ?? "";
  const phoneJid = [participantJid, key.participantPn, key.participantAlt].find((jid) => jid && jid.endsWith("@s.whatsapp.net"));
  return {
    participantJid,
    participantPhone: phoneJid ? phoneJid.split("@")[0].split(":")[0] : null,
    participantName: pushName?.trim() || null,
  };
}
