import clsx from "clsx";
import { Keyboard } from "lucide-react";
import type { MyDayGoalDTO } from "@whatsatendende/types";
import { useMyDay } from "../../hooks/useAgentExtras";
import { formatMinutes } from "../../lib/dashboardMetrics";

/** "Meu dia" above the conversation list: closed today (against the daily goal), average first response, this month's NPS. */
export function MyDayStrip({ onShowShortcuts }: { onShowShortcuts: () => void }) {
  const { data } = useMyDay();
  const closedGoal = data?.goals.find((g) => g.type === "CLOSED_PER_DAY");
  return (
    <div className="space-y-1.5 rounded-[10px] border border-border bg-surface-alt px-2.5 py-2">
      <div className="flex items-center justify-between">
        <span className="text-[11px] font-semibold uppercase tracking-wide text-muted">Meu dia</span>
        <button
          onClick={onShowShortcuts}
          className="focus-ring flex items-center gap-1 rounded px-1 text-[11px] text-muted hover:text-[var(--color-text)]"
          title="Atalhos do teclado (?)"
          aria-label="Atalhos do teclado"
        >
          <Keyboard className="h-3.5 w-3.5" /> ?
        </button>
      </div>
      <div className="grid grid-cols-3 gap-1.5 text-center">
        <Stat label="Atendidas hoje" value={data ? (closedGoal ? `${data.closedToday}/${closedGoal.target}` : String(data.closedToday)) : "—"} />
        <Stat label="1ª resposta" value={data ? formatMinutes(data.avgFirstResponseMs) : "—"} />
        <Stat label="NPS do mês" value={data?.npsThisMonth ?? null} nps />
      </div>
      {data?.goals.map((goal) => (
        <GoalBar key={goal.type} goal={goal} />
      ))}
    </div>
  );
}

const GOAL_SHORT_LABEL: Record<MyDayGoalDTO["type"], string> = { CLOSED_PER_DAY: "Encerradas", AVG_FIRST_RESPONSE: "1ª resposta", NPS: "NPS" };

/** Progress toward one goal. 1ª resposta is "lower is better": the bar fills while the average stays within the target. */
function GoalBar({ goal }: { goal: MyDayGoalDTO }) {
  let progress = 0;
  let detail: string;
  if (goal.type === "CLOSED_PER_DAY") {
    progress = Math.min(100, Math.round(((goal.current ?? 0) / goal.target) * 100));
    detail = `${goal.current ?? 0}/${goal.target}`;
  } else if (goal.type === "AVG_FIRST_RESPONSE") {
    progress = goal.current === null ? 0 : goal.achieved ? 100 : Math.max(5, Math.round((goal.target / goal.current) * 100));
    detail = goal.current === null ? `meta ${goal.target} min` : `${goal.current}/${goal.target} min`;
  } else {
    progress = goal.current === null ? 0 : goal.achieved ? 100 : Math.max(5, Math.round(((goal.current + 100) / (goal.target + 100)) * 100));
    detail = goal.current === null ? `meta ${goal.target}` : `${goal.current}/${goal.target}`;
  }
  return (
    <div className="flex items-center gap-2" title={`Meta: ${GOAL_SHORT_LABEL[goal.type]} ${detail}`}>
      <span className="w-[4.5rem] shrink-0 truncate text-[10.5px] text-muted">{GOAL_SHORT_LABEL[goal.type]}</span>
      <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-border/70">
        <div className={clsx("h-full rounded-full", goal.achieved ? "bg-success" : "bg-primary")} style={{ width: `${progress}%` }} />
      </div>
      <span className="shrink-0 text-[10.5px] font-semibold tabular-nums text-muted">{goal.achieved ? "Meta batida!" : detail}</span>
    </div>
  );
}

function Stat({ label, value, nps }: { label: string; value: string | number | null; nps?: boolean }) {
  const shown = value === null ? "—" : String(value);
  return (
    <div className="min-w-0">
      <p
        className={clsx(
          "truncate text-[15px] font-bold tabular-nums leading-5",
          nps && typeof value === "number" && (value >= 50 ? "text-success" : value < 0 ? "text-danger" : "text-warning")
        )}
      >
        {shown}
      </p>
      <p className="truncate text-[10.5px] text-muted">{label}</p>
    </div>
  );
}
