import { useState } from "react";
import clsx from "clsx";
import { ChevronDown, ChevronUp, GripVertical, Lock } from "lucide-react";
import { COLUMN_SCREENS, type ColumnDefinition, type ColumnScreen, type ColumnViewColumn } from "@whatsatendende/types";

function move(columns: ColumnViewColumn[], from: number, to: number) {
  if (to < 0 || to >= columns.length || from === to) return columns;
  const next = [...columns];
  const [item] = next.splice(from, 1);
  next.splice(to, 0, item);
  return next;
}

/** Show/hide and reorder (drag, or the arrows on touch screens) a screen's columns — the ⋮ menu and Configurações › Visões de colunas. */
export function ColumnListEditor({
  screen,
  columns,
  onChange,
}: {
  screen: ColumnScreen;
  columns: ColumnViewColumn[];
  onChange: (next: ColumnViewColumn[]) => void;
}) {
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const labels = new Map<string, ColumnDefinition>(COLUMN_SCREENS[screen].columns.map((c) => [c.key, c]));
  return (
    <ul className="max-h-72 space-y-0.5 overflow-y-auto">
      {columns.map((column, index) => {
        const def = labels.get(column.key);
        const fixed = Boolean(def && "fixed" in def && def.fixed);
        return (
          <li
            key={column.key}
            draggable
            onDragStart={() => setDragIndex(index)}
            onDragOver={(e) => {
              e.preventDefault();
              if (dragIndex === null || dragIndex === index) return;
              onChange(move(columns, dragIndex, index));
              setDragIndex(index);
            }}
            onDragEnd={() => setDragIndex(null)}
            className={clsx("flex items-center gap-1.5 rounded-md px-1.5 py-1", dragIndex === index ? "bg-primary/10" : "hover:bg-surface-alt")}
          >
            <GripVertical className="h-3.5 w-3.5 shrink-0 cursor-grab text-muted" aria-hidden />
            <label className="flex min-w-0 flex-1 items-center gap-2">
              <input
                type="checkbox"
                checked={column.visible}
                disabled={fixed}
                onChange={() => onChange(columns.map((c) => (c.key === column.key ? { ...c, visible: !c.visible } : c)))}
                className="h-4 w-4 accent-[var(--color-primary)]"
              />
              <span className={clsx("truncate", !column.visible && "text-muted")}>{def?.label ?? column.key}</span>
              {fixed && <Lock className="h-3 w-3 shrink-0 text-muted" aria-label="Coluna essencial, sempre visível" />}
            </label>
            <button
              type="button"
              onClick={() => onChange(move(columns, index, index - 1))}
              disabled={index === 0}
              className="focus-ring rounded p-0.5 text-muted hover:text-[var(--color-text)] disabled:opacity-30"
              aria-label={`Subir ${def?.label}`}
            >
              <ChevronUp className="h-3.5 w-3.5" />
            </button>
            <button
              type="button"
              onClick={() => onChange(move(columns, index, index + 1))}
              disabled={index === columns.length - 1}
              className="focus-ring rounded p-0.5 text-muted hover:text-[var(--color-text)] disabled:opacity-30"
              aria-label={`Descer ${def?.label}`}
            >
              <ChevronDown className="h-3.5 w-3.5" />
            </button>
          </li>
        );
      })}
    </ul>
  );
}
