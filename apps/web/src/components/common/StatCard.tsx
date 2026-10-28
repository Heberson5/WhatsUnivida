import clsx from "clsx";
import { ArrowDownRight, ArrowUpRight, type LucideIcon } from "lucide-react";
import type { StatDelta } from "../../lib/dashboardMetrics";

// Kept in lib/dashboardMetrics (no React) so the PowerPoint presentation shares them; re-exported for the screens.
export { compareWithPrevious, formatMinutes, type StatDelta } from "../../lib/dashboardMetrics";

/**
 * `onClick` + `goToLabel` turn the card into a shortcut (e.g. Dashboard's
 * conversation-status cards → Gestão, or its Usuários cards → the Usuários
 * screen) — hover highlight and a "Ver em X →" hint only show up when a
 * handler is actually passed, so every other StatCard stays exactly as it
 * was. See PROMPT: "ter a opção de clicar e ser direcionado".
 */
export function StatCard({
  label,
  value,
  icon: Icon,
  hint,
  onClick,
  goToLabel,
  delta,
  tone,
}: {
  label: string;
  value: string | number;
  icon: LucideIcon;
  hint?: string;
  onClick?: () => void;
  goToLabel?: string;
  delta?: StatDelta | null;
  /** "alert" highlights something that needs action now (e.g. conversations waiting). */
  tone?: "alert";
}) {
  return (
    <div
      onClick={onClick}
      role={onClick ? "button" : undefined}
      tabIndex={onClick ? 0 : undefined}
      onKeyDown={(e) => onClick && e.key === "Enter" && onClick()}
      className={clsx(
        "shadow-soft group relative rounded-card border p-4",
        tone === "alert" ? "border-warning/40 bg-warning-soft" : "border-border bg-surface",
        onClick && "focus-ring cursor-pointer transition-all hover:border-primary hover:shadow-[0_0_0_3px_color-mix(in_srgb,var(--color-primary)_15%,transparent)]"
      )}
    >
      {onClick && goToLabel && (
        <span className="absolute bottom-3 right-4 text-[11px] font-semibold text-primary opacity-0 transition-opacity group-hover:opacity-100">
          {goToLabel}
        </span>
      )}
      <div className="flex items-center justify-between gap-2">
        <p className="text-xs font-medium text-muted">{label}</p>
        <Icon className={clsx("h-4 w-4 shrink-0", tone === "alert" ? "text-warning" : "text-primary")} />
      </div>
      <p className="mt-1.5 text-2xl font-semibold tabular-nums tracking-tight">{value}</p>
      {delta && (
        <p className={clsx("mt-1 flex items-center gap-0.5 text-[11.5px] font-semibold", delta.good ? "text-success" : "text-danger")}>
          {delta.up ? <ArrowUpRight className="h-3.5 w-3.5" /> : <ArrowDownRight className="h-3.5 w-3.5" />}
          {delta.text}
        </p>
      )}
      {hint && <p className={clsx("mt-1 text-xs", tone === "alert" ? "font-medium text-warning" : "text-muted")}>{hint}</p>}
    </div>
  );
}
