import { useState } from "react";
import clsx from "clsx";
import { BarChart3, Check } from "lucide-react";
import type { ChatPollDTO } from "@whatsatendende/types";

/** A poll inside a bubble: tap an option to vote (again to take it back), the bars and who voted. */
export function ChatPollCard({ poll, mine, readOnly, onVote }: { poll: ChatPollDTO; mine: boolean; readOnly?: boolean; onVote: (optionIds: string[]) => void }) {
  const [showVoters, setShowVoters] = useState(false);
  const total = poll.options.reduce((sum, o) => sum + o.votes, 0);
  const mineIds = poll.options.filter((o) => o.mine).map((o) => o.id);

  function choose(id: string) {
    if (readOnly) return;
    if (poll.multiple) onVote(mineIds.includes(id) ? mineIds.filter((x) => x !== id) : [...mineIds, id]);
    else onVote(mineIds.includes(id) ? [] : [id]);
  }

  return (
    <div className="min-w-[240px] space-y-2 py-0.5">
      <p className="flex items-start gap-1.5 font-bold">
        <BarChart3 className="mt-0.5 h-4 w-4 shrink-0" /> {poll.question}
      </p>
      <p className="text-[11px] opacity-80">
        {poll.multiple ? "Escolha uma ou mais opções" : "Escolha uma opção"} · {poll.voters} {poll.voters === 1 ? "pessoa votou" : "pessoas votaram"}
      </p>
      <div className="space-y-2">
        {poll.options.map((o) => {
          const share = total ? o.votes / total : 0;
          return (
            <button key={o.id} type="button" onClick={() => choose(o.id)} disabled={readOnly} className="block w-full space-y-1 text-left">
              <span className="flex items-center gap-2 text-[13px]">
                <span
                  className={clsx(
                    "flex h-4 w-4 shrink-0 items-center justify-center border-2",
                    poll.multiple ? "rounded" : "rounded-full",
                    o.mine ? (mine ? "border-secondary bg-secondary text-secondary-fg" : "border-primary bg-primary text-primary-fg") : "border-current opacity-70"
                  )}
                >
                  {o.mine && <Check className="h-3 w-3" strokeWidth={3} />}
                </span>
                <span className="flex-1">{o.text}</span>
                <b className="text-xs tabular-nums">{o.votes}</b>
              </span>
              <span className={clsx("block h-1.5 overflow-hidden rounded-full", mine ? "bg-white/25" : "bg-border")}>
                <span className={clsx("block h-full rounded-full", mine ? "bg-secondary" : "bg-primary")} style={{ width: `${share * 100}%` }} />
              </span>
            </button>
          );
        })}
      </div>
      {total > 0 && (
        <button type="button" onClick={() => setShowVoters((v) => !v)} className="w-full border-t border-current/20 pt-1.5 text-center text-xs font-bold opacity-90">
          {showVoters ? "Esconder votos" : "Ver votos"}
        </button>
      )}
      {showVoters && (
        <div className="space-y-1 text-xs">
          {poll.options
            .filter((o) => o.votes)
            .map((o) => (
              <p key={o.id}>
                <b>{o.text}:</b> {o.voterNames.join(", ")}
              </p>
            ))}
        </div>
      )}
    </div>
  );
}
