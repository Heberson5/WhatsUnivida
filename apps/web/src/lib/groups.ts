import type { GroupReaderDTO } from "@whatsatendende/types";

export function initials(name: string) {
  return name
    .split(" ")
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0])
    .join("")
    .toUpperCase();
}

/** Who of the team is up to date with the group. */
export function upToDateReaders(readers: GroupReaderDTO[]) {
  return readers.filter((r) => r.unreadCount === 0 && !r.neverOpened);
}

/** "Visto por Lucas", "Visto por você e Bianca", "Visto por Lucas, Bianca e +2" — null when nobody is up to date. */
export function seenByLabel(readers: GroupReaderDTO[]): string | null {
  const names = upToDateReaders(readers)
    .sort((a, b) => Number(b.isMe) - Number(a.isMe))
    .map((r) => (r.isMe ? "você" : r.name));
  if (names.length === 0) return null;
  if (names.length === 1) return `Visto por ${names[0]}`;
  if (names.length === 2) return `Visto por ${names[0]} e ${names[1]}`;
  return `Visto por ${names[0]}, ${names[1]} e +${names.length - 2}`;
}

export function unreadLabel(count: number) {
  return `${count > 99 ? "99+" : count} ${count === 1 ? "não lida" : "não lidas"}`;
}
