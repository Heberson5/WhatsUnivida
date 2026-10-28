import type { ContactListItemDTO, TagDTO } from "@whatsatendende/types";
import { formatPhoneAsKnown } from "../../lib/format-phone";

const CHANNEL_LABEL: Record<string, string> = { INSTAGRAM: "Instagram", MESSENGER: "Messenger" };

/** "+55 11 98765-4321" for a WhatsApp number (a mobile always with its 9); the channel name for Instagram/Messenger (no phone there). */
export function formatContactPhone(contact: Pick<ContactListItemDTO, "phone" | "channel">): string {
  if (!contact.phone) return CHANNEL_LABEL[contact.channel] ?? "-";
  return formatPhoneAsKnown(contact.phone);
}

export function TagChip({ tag }: { tag: TagDTO }) {
  return (
    <span className="inline-flex items-center gap-1 rounded-full border border-border px-2 py-0.5 text-[11px] font-medium">
      <span className="h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: tag.color }} />
      {tag.name}
    </span>
  );
}
