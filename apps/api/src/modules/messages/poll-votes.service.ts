import { decryptPollVoteOptions, type PollVoteEvent } from "@whatsatendende/whatsapp";
import type { PollResultsDTO } from "@whatsatendende/types";
import { prisma } from "../../lib/prisma";
import { logger } from "../../lib/logger";

/**
 * Enquetes nos grupos: a vote arrives encrypted; the poll's own key (kept on its attachment when it arrived) reads
 * it, and it replaces that person's previous vote — WhatsApp sends the whole selection again when someone changes it,
 * and an empty one when they take it back. Polls from before this was kept (no key) can't be read.
 * Returns the conversation to refresh, or null when the vote wasn't for a poll this system can read.
 */
export async function recordPollVote(event: PollVoteEvent, voterName: (conversationId: string) => Promise<string | null>): Promise<{ conversationId: string } | null> {
  const message = await prisma.message.findUnique({
    where: { providerMessageId: event.pollMessageId },
    select: { conversationId: true, attachments: { where: { kind: "POLL" }, select: { id: true, pollOptions: true, pollSecret: true, pollCreatorJid: true } } },
  });
  const poll = message?.attachments[0];
  if (!message || !poll) return null;
  if (!poll.pollSecret || !poll.pollCreatorJid) {
    logger.info({ pollMessageId: event.pollMessageId }, "poll vote for a poll saved without its key");
    return null;
  }
  const options = Array.isArray(poll.pollOptions) ? (poll.pollOptions as string[]) : [];
  // In a LID group the creator and the voter may each be named by their phone number or their LID; the vote opens
  // only with the pair it was encrypted with.
  const creators = [...new Set([poll.pollCreatorJid, ...(event.creatorJidCandidates ?? [])])];
  const voters = [...new Set([event.voterJid, ...(event.voterJidCandidates ?? [])])];
  let chosen: string[] | null = null;
  for (const creatorJid of creators) {
    for (const voterJid of voters) {
      chosen = decryptPollVoteOptions(event, { secret: poll.pollSecret, creatorJid, messageId: event.pollMessageId, options }, voterJid);
      if (chosen !== null) break;
    }
    if (chosen !== null) break;
  }
  if (chosen === null) {
    logger.warn({ pollMessageId: event.pollMessageId, creators, voters }, "poll vote could not be decrypted");
    return null;
  }
  const name = event.fromMe ? "Você (esta conta)" : (event.voterName ?? (await voterName(message.conversationId)));
  await prisma.pollVote.upsert({
    where: { attachmentId_voterJid: { attachmentId: poll.id, voterJid: event.voterJid } },
    create: { attachmentId: poll.id, voterJid: event.voterJid, voterName: name, voterPhone: event.voterPhone, options: chosen, votedAt: event.timestamp },
    update: { voterName: name ?? undefined, voterPhone: event.voterPhone ?? undefined, options: chosen, votedAt: event.timestamp },
  });
  return { conversationId: message.conversationId };
}

/** The poll as WhatsApp Web shows it: votes per option, who voted, and the share of everyone who voted. */
export function pollResultsOf(
  options: string[],
  votes: { voterName: string | null; voterPhone: string | null; options: string[]; votedAt: Date }[],
  readable: boolean
): PollResultsDTO {
  const counted = votes.filter((v) => v.options.length > 0);
  return {
    readable,
    voters: counted.length,
    options: options.map((option) => {
      const voters = counted
        .filter((v) => v.options.includes(option))
        .sort((a, b) => a.votedAt.getTime() - b.votedAt.getTime())
        .map((v) => ({ name: v.voterName ?? (v.voterPhone ? `+${v.voterPhone}` : "Participante"), phone: v.voterPhone }));
      return { option, count: voters.length, voters };
    }),
  };
}
