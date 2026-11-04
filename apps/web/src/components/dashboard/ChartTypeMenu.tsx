import { useEffect, useRef, useState } from "react";
import { SlidersHorizontal, Star } from "lucide-react";
import type { LucideIcon } from "lucide-react";

export interface ChartTypeOption<K extends string> {
  key: K;
  label: string;
  icon: LucideIcon;
}

/**
 * The small gear/sliders icon in the corner of each chart card — lets the
 * viewer pick how that one chart is drawn (bar/line/pie/...) without
 * affecting the underlying data. See PROMPT: "tendo opção de alterar o
 * tipo de gráfico". Same trigger-button + outside-click-to-close popover
 * pattern as the Relatórios "Colunas" menu.
 */
export function ChartTypeMenu<K extends string>({
  value,
  onChange,
  options,
  defaultKey,
  onSaveDefault,
}: {
  value: K;
  onChange: (kind: K) => void;
  options: ChartTypeOption<K>[];
  /** The type everyone sees first (★) — what an administrator set. */
  defaultKey?: K;
  /** Administrators only: makes the type on screen everyone's. Anyone else changes it on their own screen only. */
  onSaveDefault?: (kind: K) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen((o) => !o)}
        className="focus-ring rounded-md p-1 text-muted hover:bg-surface-alt hover:text-[var(--color-text)]"
        title="Alterar tipo de gráfico"
        aria-label="Alterar tipo de gráfico"
      >
        <SlidersHorizontal className="h-4 w-4" />
      </button>
      {open && (
        <div className="shadow-soft absolute right-0 top-full z-20 mt-1 w-56 rounded-card border border-border bg-surface p-1">
          {options.map((opt) => (
            <button
              key={opt.key}
              onClick={() => {
                onChange(opt.key);
                setOpen(false);
              }}
              className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm ${
                opt.key === value ? "bg-primary/10 font-medium text-primary" : "hover:bg-surface-alt"
              }`}
            >
              <opt.icon className="h-3.5 w-3.5" /> {opt.label}
              {opt.key === defaultKey && <Star className="ml-auto h-3 w-3 fill-current text-warning" aria-label="padrão" />}
            </button>
          ))}
          {onSaveDefault && (
            <>
              <div className="my-1 border-t border-border" />
              <button
                onClick={() => {
                  onSaveDefault(value);
                  setOpen(false);
                }}
                disabled={value === defaultKey}
                className="w-full rounded-md px-2 py-1.5 text-left text-xs font-medium text-primary hover:bg-surface-alt disabled:text-muted disabled:hover:bg-transparent"
              >
                {value === defaultKey ? "★ Este é o padrão de todos" : "Usar este tipo como padrão para todos"}
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
}
