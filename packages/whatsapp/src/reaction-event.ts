import type { ReactionEvent } from "./types";
import { isGroupChat } from "./group-message";

/** The part of a Baileys `messages.reaction` entry that matters here (structurally compatible with its own type). */
export interface BaileysReactionEntry {
  /** Key of the message being reacted to. */
  key: { id?: string | null; remoteJid?: string | null };
  /** The reaction itself — its own key says who made it. */
  reaction: {
    text?: string | null;
    /** In a group, `participant` is who reacted — an @lid id or a phone JID; participantPn/participantAlt carry the phone when hidden. */
    key?: { remoteJid?: string | null; fromMe?: boolean | null; participant?: string | null; participantPn?: string | null; participantAlt?: string | null } | null;
  };
}

/**
 * A Baileys `messages.reaction` entry as a provider event.
 *
 * `fromMe` is what tells the customer's reaction apart from ours: Baileys
 * (emitOwnEvents, on by default) feeds every message this app sends back
 * through its own processing, so each reaction an agent clicks here comes back
 * as a `messages.reaction` with `reaction.key.fromMe === true` — and a
 * reaction made on the linked phone arrives the same way. `fromPhone` can't
 * tell them apart: for both it is the chat's number.
 */
export function reactionEventFromBaileys(entry: BaileysReactionEntry, now: Date = new Date()): ReactionEvent {
  const chatId = entry.key.remoteJid ?? "";
  const reactor = entry.reaction.key;
  const participantJid = isGroupChat(chatId) ? (reactor?.participant ?? "") : "";
  const phoneJid = [participantJid, reactor?.participantPn, reactor?.participantAlt].find((jid) => jid && jid.endsWith("@s.whatsapp.net"));
  return {
    providerMessageId: entry.key.id ?? "",
    chatId: entry.key.remoteJid ?? "",
    emoji: entry.reaction.text || null,
    fromPhone: (entry.reaction.key?.remoteJid ?? "").split("@")[0],
    fromMe: Boolean(entry.reaction.key?.fromMe),
    participant: participantJid ? { jid: participantJid, phone: phoneJid ? phoneJid.split("@")[0].split(":")[0] : null } : null,
    timestamp: now,
  };
}
