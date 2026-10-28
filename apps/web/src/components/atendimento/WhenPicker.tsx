import { useEffect, useRef, useState } from "react";
import clsx from "clsx";
import { format } from "date-fns";

// "Hoje às 15:00" is offered only while there's still time before it.
const AFTERNOON_HOUR = 15;
const NEXT_MORNING_HOUR = 9;
const NOTE_MAX = 200;

function presets(now: Date) {
  const inMinutes = (m: number) => new Date(now.getTime() + m * 60_000);
  const afternoon = new Date(now);
  afternoon.setHours(AFTERNOON_HOUR, 0, 0, 0);
  const tomorrow = new Date(now);
  tomorrow.setDate(tomorrow.getDate() + 1);
  tomorrow.setHours(NEXT_MORNING_HOUR, 0, 0, 0);
  return [
    { label: "Em 30 minutos", at: inMinutes(30) },
    { label: "Em 1 hora", at: inMinutes(60) },
    ...(afternoon.getTime() - now.getTime() > 10 * 60_000 ? [{ label: `Hoje às ${AFTERNOON_HOUR}:00`, at: afternoon }] : []),
    { label: `Amanhã às ${NEXT_MORNING_HOUR}:00`, at: tomorrow },
  ];
}

/** Picks a moment in the future — "Lembrar de retornar" (with an optional note) and "Agendar envio". */
export function WhenPicker({
  title,
  confirmLabel,
  withNote,
  busy,
  className,
  onConfirm,
  onClose,
}: {
  title: string;
  confirmLabel: string;
  withNote?: boolean;
  busy?: boolean;
  className?: string;
  onConfirm: (at: Date, note: string) => void;
  onClose: () => void;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const [options] = useState(() => presets(new Date()));
  const [chosen, setChosen] = useState<number | "custom">(0);
  const [custom, setCustom] = useState(() => format(new Date(Date.now() + 60 * 60_000), "yyyy-MM-dd'T'HH:mm"));
  const [note, setNote] = useState("");
  const at = chosen === "custom" ? new Date(custom) : options[chosen].at;
  const valid = !Number.isNaN(at.getTime()) && at.getTime() > Date.now();

  useEffect(() => {
    function onDown(e: MouseEvent) {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) onClose();
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  return (
    <div ref={rootRef} role="dialog" aria-label={title} className={clsx("shadow-elevated absolute z-30 w-64 rounded-card border border-border bg-surface p-3", className)}>
      <p className="mb-2 text-sm font-semibold">{title}</p>
      <div className="space-y-1">
        {options.map((o, i) => (
          <button
            key={o.label}
            type="button"
            onClick={() => setChosen(i)}
            aria-pressed={chosen === i}
            className={clsx(
              "focus-ring flex w-full items-center justify-between rounded-lg px-2.5 py-1.5 text-left text-xs",
              chosen === i ? "bg-primary/10 font-semibold text-primary" : "hover:bg-surface-alt"
            )}
          >
            {o.label}
            <span className="tabular-nums text-muted">{format(o.at, "HH:mm")}</span>
          </button>
        ))}
        <button
          type="button"
          onClick={() => setChosen("custom")}
          aria-pressed={chosen === "custom"}
          className={clsx(
            "focus-ring w-full rounded-lg px-2.5 py-1.5 text-left text-xs",
            chosen === "custom" ? "bg-primary/10 font-semibold text-primary" : "hover:bg-surface-alt"
          )}
        >
          Escolher data e hora
        </button>
        {chosen === "custom" && (
          <input
            type="datetime-local"
            value={custom}
            onChange={(e) => setCustom(e.target.value)}
            aria-label="Data e hora"
            className="focus-ring w-full rounded-lg border border-border bg-transparent px-2 py-1 text-xs"
          />
        )}
      </div>
      {withNote && (
        <input
          value={note}
          onChange={(e) => setNote(e.target.value)}
          maxLength={NOTE_MAX}
          placeholder="Anotação (opcional) — ex.: confirmar pagamento"
          aria-label="Anotação do lembrete"
          className="focus-ring mt-2 w-full rounded-lg border border-border bg-transparent px-2 py-1.5 text-xs"
        />
      )}
      {!valid && <p className="mt-1.5 text-[11px] text-danger">Escolha um horário no futuro.</p>}
      <div className="mt-3 flex justify-end gap-2">
        <button type="button" onClick={onClose} className="focus-ring rounded-lg border border-border px-3 py-1.5 text-xs hover:bg-surface-alt">
          Cancelar
        </button>
        <button
          type="button"
          disabled={!valid || busy}
          onClick={() => onConfirm(at, note.trim())}
          className="focus-ring rounded-lg bg-primary px-3 py-1.5 text-xs font-semibold text-primary-fg disabled:opacity-60"
        >
          {confirmLabel}
        </button>
      </div>
    </div>
  );
}
