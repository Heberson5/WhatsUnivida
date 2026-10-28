import { Fragment, type ReactNode } from "react";
import { dayLabel, groupByDay } from "../../lib/chatDays";
import { useToday } from "../../hooks/useToday";

/** One thing in a conversation's thread — a message, an internal note, the transfer note — already in display order. */
export interface TimelineEntry {
  key: string;
  /** When it happened (ms since epoch): decides which day's cut it sits under. */
  at: number;
  node: ReactNode;
}

/**
 * The thread split by day, like WhatsApp Web: a "Hoje" / "Ontem" / weekday /
 * date cut opens each day, and stays pinned to the top of the scroll area
 * while that day's entries scroll under it, until the next day's cut takes
 * its place. Must be rendered inside the scrolling container's content — the
 * cut sticks to the nearest scrolling ancestor.
 */
export function TimelineByDay({ entries }: { entries: TimelineEntry[] }) {
  const today = useToday();
  return (
    <>
      {groupByDay(entries).map((day) => {
        const label = dayLabel(day.at, today);
        return (
          // The group is named after the day for screen readers, so the visual cut itself is hidden from them.
          <div key={day.key} role="group" aria-label={label} className="space-y-3">
            <p
              aria-hidden="true"
              className="pointer-events-none sticky top-0 z-10 mx-auto w-fit select-none rounded-full border border-border bg-surface px-3 py-1 text-xs font-medium text-muted shadow"
            >
              {label}
            </p>
            {day.entries.map((entry) => (
              <Fragment key={entry.key}>{entry.node}</Fragment>
            ))}
          </div>
        );
      })}
    </>
  );
}
