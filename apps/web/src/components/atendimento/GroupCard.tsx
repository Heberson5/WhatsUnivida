import clsx from "clsx";
import { format, isToday, isYesterday } from "date-fns";
import { BellOff, Users } from "lucide-react";
import type { GroupListItemDTO } from "@whatsatendende/types";
import { initials, seenByLabel, upToDateReaders } from "../../lib/groups";
import { useCustomerTyping } from "../../store/typing-store";

function shortTime(iso: string) {
  const d = new Date(iso);
  if (isToday(d)) return format(d, "HH:mm");
  if (isYesterday(d)) return "ontem";
  return format(d, "dd/MM");
}

/** A WhatsApp group in Atendimento's Grupos tab — the unread count is the logged-in person's own. */
export function GroupCard({ group, selected, onSelect }: { group: GroupListItemDTO; selected?: boolean; onSelect: () => void }) {
  const seenBy = seenByLabel(group.readers);
  const upToDate = upToDateReaders(group.readers);
  const unread = group.unreadCount > 0;
  const typing = useCustomerTyping(group.id);
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onSelect}
      onKeyDown={(e) => e.key === "Enter" && onSelect()}
      aria-current={selected ? "true" : undefined}
      aria-label={`Grupo ${group.name}${unread ? `, ${group.unreadCount} não lidas` : ""}`}
      className={clsx(
        "focus-ring relative flex cursor-pointer items-start gap-3 border-b border-border px-3 py-3 transition-colors",
        selected ? "bg-primary/[0.07]" : "hover:bg-surface-alt"
      )}
    >
      {selected && <span className="absolute inset-y-2 left-0 w-[3px] rounded-r bg-primary" aria-hidden />}
      {group.photoUrl ? (
        <img src={group.photoUrl} alt="" className="h-10 w-10 shrink-0 rounded-full object-cover" />
      ) : (
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-secondary/25 text-secondary-fg">
          <Users className="h-5 w-5" />
        </div>
      )}

      <div className="min-w-0 flex-1">
        <div className="flex items-baseline justify-between gap-2">
          <p className={clsx("truncate text-[13.5px]", unread ? "font-bold" : "font-semibold")}>{group.name}</p>
          {group.lastMessagePreview && (
            <span className={clsx("shrink-0 text-[11px]", unread ? "font-semibold text-primary" : "text-muted")}>{shortTime(group.lastMessageAt)}</span>
          )}
        </div>
        <p className={clsx("truncate text-xs", typing ? (typing.kind === "recording" ? "font-semibold italic text-danger" : "font-semibold italic text-success") : unread ? "font-medium text-[var(--color-text)]" : "text-muted")}>
          {typing ? (
            typing.text
          ) : group.lastMessagePreview ? (
            <>
              <span className="font-semibold">{group.lastMessagePreview.senderName}:</span> {group.lastMessagePreview.text}
            </>
          ) : (
            "Nenhuma mensagem desde que os grupos foram ligados"
          )}
        </p>

        <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
          <span className="inline-flex min-w-0 items-center gap-1 text-[11px] text-muted">
            <span className="h-2 w-2 shrink-0 rounded-sm" style={{ backgroundColor: group.whatsappConnectionColor }} />
            <span className="truncate">{group.whatsappConnectionName}</span>
          </span>
          {seenBy ? (
            <span className="inline-flex min-w-0 items-center gap-1 text-[10.5px] text-muted" title={seenBy}>
              <span className="flex -space-x-1.5" aria-hidden>
                {upToDate.slice(0, 3).map((r) => (
                  <span key={r.userId} className="flex h-4 w-4 items-center justify-center rounded-full border border-surface bg-primary/15 text-[7.5px] font-bold text-primary">
                    {initials(r.name)}
                  </span>
                ))}
              </span>
              <span className="truncate">{seenBy}</span>
            </span>
          ) : (
            group.lastMessagePreview && (
              <span className="inline-flex items-center rounded-full bg-warning-soft px-2 py-0.5 text-[10.5px] font-semibold text-warning">ninguém da equipe abriu</span>
            )
          )}
          <span className="ml-auto flex items-center gap-1">
            {group.muted && <BellOff className="h-3 w-3 text-muted" aria-label="Silenciado" />}
            {unread && (
              <span className="flex h-[18px] min-w-[18px] items-center justify-center rounded-full bg-primary px-1.5 text-[10px] font-bold text-primary-fg">
                {group.unreadCount > 99 ? "99+" : group.unreadCount}
              </span>
            )}
          </span>
        </div>
      </div>
    </div>
  );
}
