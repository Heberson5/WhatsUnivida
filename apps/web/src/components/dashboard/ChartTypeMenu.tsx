import { useEffect, useRef, useState } from "react";
import { SlidersHorizontal } from "lucide-react";
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
}: {
  value: K;
  onChange: (kind: K) => void;
  options: ChartTypeOption<K>[];
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
        <div className="shadow-soft absolute right-0 top-full z-20 mt-1 w-44 rounded-card border border-border bg-surface p-1">
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
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
