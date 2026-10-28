import { describe, it, expect } from "vitest";
import { groupReactions } from "./reactions";

const r = (emoji: string, userDisplayName: string) => ({ emoji, userDisplayName });

describe("groupReactions", () => {
  it("shows an emoji once, with how many people used it and who", () => {
    expect(groupReactions([r("👍", "Ana"), r("👍", "Cliente")])).toEqual([{ emoji: "👍", count: 2, names: ["Ana", "Cliente"] }]);
  });

  it("keeps different emojis apart, in the order they first appeared", () => {
    const groups = groupReactions([r("❤️", "Cliente"), r("🙏", "Ana"), r("❤️", "Bruno")]);
    expect(groups.map((g) => g.emoji)).toEqual(["❤️", "🙏"]);
    expect(groups.map((g) => g.count)).toEqual([2, 1]);
  });

  it("is empty when nobody reacted", () => {
    expect(groupReactions([])).toEqual([]);
  });
});
