import type { MessageReactionDTO } from "@whatsatendende/types";

export interface ReactionGroup {
  emoji: string;
  count: number;
  /** Who reacted with it, in the order they did — shown on hover. */
  names: string[];
}

/** One entry per emoji with how many people used it ("👍 2"), in the order each emoji first appeared — the way WhatsApp shows them. */
export function groupReactions(reactions: Pick<MessageReactionDTO, "emoji" | "userDisplayName">[]): ReactionGroup[] {
  const groups = new Map<string, ReactionGroup>();
  for (const reaction of reactions) {
    const group = groups.get(reaction.emoji) ?? { emoji: reaction.emoji, count: 0, names: [] };
    group.count += 1;
    group.names.push(reaction.userDisplayName);
    groups.set(reaction.emoji, group);
  }
  return [...groups.values()];
}
