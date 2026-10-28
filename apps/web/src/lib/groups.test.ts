import { describe, it, expect } from "vitest";
import type { GroupReaderDTO } from "@whatsatendende/types";
import { initials, seenByLabel } from "./groups";

const reader = (name: string, over: Partial<GroupReaderDTO> = {}): GroupReaderDTO => ({
  userId: name,
  name,
  photoUrl: null,
  neverOpened: false,
  lastReadAt: "2026-10-09T10:00:00Z",
  unreadCount: 0,
  isMe: false,
  ...over,
});

describe("seenByLabel", () => {
  it("names who is up to date, with 'você' first", () => {
    expect(seenByLabel([reader("Lucas")])).toBe("Visto por Lucas");
    expect(seenByLabel([reader("Lucas"), reader("Bianca", { isMe: true })])).toBe("Visto por você e Lucas");
    expect(seenByLabel([reader("A"), reader("B"), reader("C"), reader("D")])).toBe("Visto por A, B e +2");
  });

  it("leaves out who never opened it or still has unread messages", () => {
    expect(seenByLabel([reader("Lucas", { neverOpened: true, unreadCount: 3 }), reader("Bianca", { unreadCount: 1 })])).toBeNull();
  });
});

describe("initials", () => {
  it("takes the first two names", () => {
    expect(initials("Lucas Andrade Souza")).toBe("LA");
    expect(initials("Bianca")).toBe("B");
  });
});
