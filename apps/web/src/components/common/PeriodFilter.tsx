import { useState } from "react";

// "all" (no period filter at all) only exists where a screen opts in with `allowAll` — Gestão, which also lists what is waiting right now.
export type PeriodKey = "today" | "yesterday" | "last7days" | "month" | "lastMonth" | "custom" | "all";

export interface PeriodValue {
  period: PeriodKey;
  from?: string;
  to?: string;
}

const OPTIONS: { value: PeriodKey; label: string; short: string }[] = [
  { value: "today", label: "Hoje", short: "Hoje" },
  { value: "yesterday", label: "Ontem", short: "Ontem" },
  { value: "last7days", label: "Últimos 7 dias", short: "7 dias" },
  { value: "month", label: "Este mês", short: "Este mês" },
  { value: "lastMonth", label: "Mês anterior", short: "Mês anterior" },
  { value: "custom", label: "Personalizado", short: "Personalizado" },
];

const ALL_OPTION = { value: "all" as PeriodKey, label: "Todo o período", short: "Tudo" };

/** `segmented` shows every period as a button (Dashboard); the default is a compact select. `allowAll` adds "Todo o período" (select only). */
export function PeriodFilter({
  value,
  onChange,
  segmented,
  allowAll,
}: {
  value: PeriodValue;
  onChange: (v: PeriodValue) => void;
  segmented?: boolean;
  allowAll?: boolean;
}) {
  const [customFrom, setCustomFrom] = useState(value.from ?? "");
  const [customTo, setCustomTo] = useState(value.to ?? "");
  const selectOptions = allowAll ? [...OPTIONS, ALL_OPTION] : OPTIONS;

  return (
    <div className="flex flex-wrap items-center gap-2">
      {segmented ? (
        <div className="inline-flex flex-wrap rounded-lg border border-border bg-surface p-[3px]" role="group" aria-label="Período">
          {OPTIONS.map((opt) => (
            <button
              key={opt.value}
              type="button"
              aria-pressed={value.period === opt.value}
              onClick={() => onChange(opt.value === "custom" ? { period: opt.value, from: customFrom, to: customTo } : { period: opt.value })}
              className={`focus-ring rounded-md px-2.5 py-1 text-[13px] ${
                value.period === opt.value ? "bg-[var(--color-text)] font-semibold text-surface" : "text-muted hover:text-[var(--color-text)]"
              }`}
            >
              {opt.short}
            </button>
          ))}
        </div>
      ) : (
      <select
        value={value.period}
        onChange={(e) => {
          const period = e.target.value as PeriodKey;
          // Only "custom" carries from/to — every other period is resolved
          // server-side from `period` alone. Sending the (possibly still
          // empty) customFrom/customTo strings here for a non-custom period
          // used to make the API reject the request (empty string isn't a
          // valid date), leaving the page blank with no error shown.
          onChange(period === "custom" ? { period, from: customFrom, to: customTo } : { period });
        }}
        className="focus-ring rounded-card border border-border bg-surface px-3 py-2 text-sm"
      >
        {selectOptions.map((opt) => (
          <option key={opt.value} value={opt.value}>
            {opt.label}
          </option>
        ))}
      </select>
      )}

      {value.period === "custom" && (
        <>
          <input
            type="date"
            value={customFrom}
            onChange={(e) => {
              setCustomFrom(e.target.value);
              onChange({ period: "custom", from: e.target.value, to: customTo });
            }}
            className="focus-ring rounded-card border border-border bg-surface px-3 py-2 text-sm"
          />
          <span className="text-muted">até</span>
          <input
            type="date"
            value={customTo}
            onChange={(e) => {
              setCustomTo(e.target.value);
              onChange({ period: "custom", from: customFrom, to: e.target.value });
            }}
            className="focus-ring rounded-card border border-border bg-surface px-3 py-2 text-sm"
          />
        </>
      )}
    </div>
  );
}
