import { useEffect, useRef, useState } from "react";
import { Settings2 } from "lucide-react";

export interface HourRange {
  start: number;
  end: number;
}

export function formatHour(hour: number): string {
  return `${String(hour).padStart(2, "0")}h`;
}

/**
 * The gear of the Dashboard's charts by hour: which hours to show (e.g. 8h–20h to cut an empty night), optionally saved
 * as this person's default. `onChange` gets the new range (null = every hour) and whether to save it as the default.
 */
export function HourRangeMenu({ range, onChange }: { range: HourRange | null; onChange: (range: HourRange | null, asDefault: boolean) => void }) {
  const [open, setOpen] = useState(false);
  const [draftStart, setDraftStart] = useState(range?.start ?? 8);
  const [draftEnd, setDraftEnd] = useState(range?.end ?? 20);
  const [draftAsDefault, setDraftAsDefault] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  function apply(next: HourRange | null) {
    onChange(next, draftAsDefault);
    setOpen(false);
  }

  return (
    <div ref={rootRef} className="relative">
      <button
        onClick={() => setOpen((o) => !o)}
        className="focus-ring rounded-md p-1 text-muted hover:bg-surface-alt hover:text-[var(--color-text)]"
        title="Configurar faixa de horário"
        aria-label="Configurar faixa de horário"
      >
        <Settings2 className="h-4 w-4" />
      </button>
      {open && (
        <div className="shadow-soft absolute right-0 top-full z-20 mt-1 w-64 rounded-card border border-border bg-surface p-3">
          <p className="mb-2 text-xs font-semibold">Faixa de horário exibida</p>
          <div className="flex items-center gap-2 text-sm">
            <span className="text-muted">De</span>
            <select
              value={draftStart}
              onChange={(e) => setDraftStart(Number(e.target.value))}
              aria-label="Horário inicial"
              className="focus-ring flex-1 rounded-card border border-border bg-transparent px-2 py-1.5 text-sm"
            >
              {Array.from({ length: 24 }, (_, h) => (
                <option key={h} value={h}>
                  {formatHour(h)}
                </option>
              ))}
            </select>
            <span className="text-muted">até</span>
            <select
              value={draftEnd}
              onChange={(e) => setDraftEnd(Number(e.target.value))}
              aria-label="Horário final"
              className="focus-ring flex-1 rounded-card border border-border bg-transparent px-2 py-1.5 text-sm"
            >
              {Array.from({ length: 24 }, (_, h) => (
                <option key={h} value={h}>
                  {formatHour(h)}
                </option>
              ))}
            </select>
          </div>
          {draftStart >= draftEnd && <p className="mt-1 text-xs text-red-600">O horário inicial deve ser antes do final.</p>}
          <label className="mt-2 flex items-center gap-2 text-xs text-muted">
            <input type="checkbox" checked={draftAsDefault} onChange={(e) => setDraftAsDefault(e.target.checked)} className="h-3.5 w-3.5 accent-primary" />
            Definir como padrão pro meu Dashboard
          </label>
          <div className="mt-3 flex items-center justify-between gap-2">
            <button onClick={() => apply(null)} className="text-xs text-muted hover:underline">
              Mostrar todas as horas
            </button>
            <button
              onClick={() => apply({ start: draftStart, end: draftEnd })}
              disabled={draftStart >= draftEnd}
              className="focus-ring rounded-card bg-primary px-3 py-1.5 text-xs font-semibold text-primary-fg disabled:opacity-60"
            >
              Aplicar
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
