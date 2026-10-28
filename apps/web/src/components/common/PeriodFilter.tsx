import { useState } from "react";

export type PeriodKey = "today" | "yesterday" | "last7days" | "month" | "lastMonth" | "custom";

export interface PeriodValue {
  period: PeriodKey;
  from?: string;
  to?: string;
}

const OPTIONS: { value: PeriodKey; label: string }[] = [
  { value: "today", label: "Hoje" },
  { value: "yesterday", label: "Ontem" },
  { value: "last7days", label: "Últimos 7 dias" },
  { value: "month", label: "Este mês" },
  { value: "lastMonth", label: "Mês anterior" },
  { value: "custom", label: "Personalizado" },
];

export function PeriodFilter({ value, onChange }: { value: PeriodValue; onChange: (v: PeriodValue) => void }) {
  const [customFrom, setCustomFrom] = useState(value.from ?? "");
  const [customTo, setCustomTo] = useState(value.to ?? "");

  return (
    <div className="flex flex-wrap items-center gap-2">
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
        {OPTIONS.map((opt) => (
          <option key={opt.value} value={opt.value}>
            {opt.label}
          </option>
        ))}
      </select>

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
