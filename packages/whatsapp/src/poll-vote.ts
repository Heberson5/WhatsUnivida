import { createHash } from "node:crypto";
import { decryptPollVote, proto } from "@whiskeysockets/baileys";

/**
 * WhatsApp poll votes come end-to-end encrypted with a key that travels inside the poll itself
 * (messageContextInfo.messageSecret). The poll is kept with that key (PollInfo); each vote is decrypted with it and
 * names its options by their SHA-256 — matched back to the option labels here. Same rule as WhatsApp Web; Baileys
 * 6.7 ships the decryption but no longer runs it on its own.
 */

/** What the poll creation carries for its votes to be read later. */
export interface PollInfo {
  question: string;
  options: string[];
  /** 1 = single choice; 0 or more than 1 = several answers allowed. */
  selectableCount: number;
  /** Base64 of messageContextInfo.messageSecret — null when WhatsApp did not send it (old polls). */
  secret: string | null;
  /** Who created it, as the vote encryption names them (the sender in a group, this account when fromMe). */
  creatorJid: string | null;
}

/** The poll creation of a message (WhatsApp has used three versions of it), or null. */
export function pollCreationOf(content: proto.IMessage | null | undefined): proto.Message.IPollCreationMessage | null {
  return content?.pollCreationMessage ?? content?.pollCreationMessageV2 ?? content?.pollCreationMessageV3 ?? null;
}

export function pollInfoOf(content: proto.IMessage, creatorJid: string | null): PollInfo | null {
  const poll = pollCreationOf(content);
  if (!poll) return null;
  const secret = content.messageContextInfo?.messageSecret;
  return {
    question: poll.name ?? "",
    options: (poll.options ?? []).map((o) => o.optionName ?? "").filter(Boolean),
    selectableCount: Number(poll.selectableOptionsCount ?? 0),
    secret: secret && secret.length ? Buffer.from(secret).toString("base64") : null,
    creatorJid,
  };
}

/** SHA-256 of an option label, as a vote names it. */
export function pollOptionHash(option: string): string {
  return createHash("sha256").update(Buffer.from(option)).digest("hex");
}

export interface EncryptedPollVote {
  /** Base64. */
  encPayload: string;
  /** Base64. */
  encIv: string;
}

/**
 * The options a vote picked (their labels), or null when it can't be read (wrong key, old poll). An empty list is a
 * vote taken back.
 */
export function decryptPollVoteOptions(
  vote: EncryptedPollVote,
  poll: { secret: string; creatorJid: string; messageId: string; options: string[] },
  voterJid: string
): string[] | null {
  try {
    const decrypted = decryptPollVote(
      { encPayload: Buffer.from(vote.encPayload, "base64"), encIv: Buffer.from(vote.encIv, "base64") },
      { pollEncKey: Buffer.from(poll.secret, "base64"), pollCreatorJid: poll.creatorJid, pollMsgId: poll.messageId, voterJid }
    );
    const byHash = new Map(poll.options.map((o) => [pollOptionHash(o), o]));
    return (decrypted.selectedOptions ?? []).map((h) => byHash.get(Buffer.from(h).toString("hex"))).filter((o): o is string => Boolean(o));
  } catch {
    return null;
  }
}
