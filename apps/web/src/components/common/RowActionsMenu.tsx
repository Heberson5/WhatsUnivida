import { useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import clsx from "clsx";
import { MoreHorizontal, type LucideIcon } from "lucide-react";
import { useEscapeKey } from "../../hooks/useEscapeKey";

export interface RowAction {
  label: string;
  icon: LucideIcon;
  onSelect: () => void;
  danger?: boolean;
  disabled?: boolean;
}

/**
 * "⋯" at the end of a table row: the row's less frequent actions, each with its name. Drawn in a portal with fixed
 * positioning so the table's own scroll container never clips it. Closes on Esc, on a click outside, or after a pick.
 */
export function RowActionsMenu({ actions, label = "Mais ações" }: { actions: RowAction[]; label?: string }) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  useEscapeKey(() => setOpen(false), open);

  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      const r = buttonRef.current!.getBoundingClientRect();
      const width = 208;
      const height = menuRef.current?.offsetHeight ?? 0;
      const below = r.bottom + 6 + height <= window.innerHeight;
      setPos({ top: below ? r.bottom + 6 : r.top - 6 - height, left: Math.max(8, Math.min(r.right - width, window.innerWidth - width - 8)) });
    };
    place();
    const close = (e: MouseEvent) => {
      if (!menuRef.current?.contains(e.target as Node) && !buttonRef.current?.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    document.addEventListener("mousedown", close);
    return () => {
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
      document.removeEventListener("mousedown", close);
    };
  }, [open]);

  if (actions.length === 0) return null;

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={label}
        title={label}
        className={clsx("focus-ring flex h-8 w-8 items-center justify-center rounded-lg border border-border text-muted hover:bg-surface-alt hover:text-[var(--color-text)]", open && "bg-surface-alt")}
      >
        <MoreHorizontal className="h-4 w-4" />
      </button>
      {open &&
        createPortal(
          <div
            ref={menuRef}
            role="menu"
            style={{ top: pos?.top ?? -9999, left: pos?.left ?? -9999 }}
            className="fixed z-[70] w-52 rounded-card border border-border bg-surface p-1.5 text-left shadow-elevated"
          >
            {actions.map((action) => (
              <button
                key={action.label}
                role="menuitem"
                type="button"
                disabled={action.disabled}
                onClick={() => {
                  setOpen(false);
                  action.onSelect();
                }}
                className={clsx(
                  "flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-sm normal-case tracking-normal disabled:opacity-50",
                  action.danger ? "text-danger hover:bg-danger-soft" : "text-[var(--color-text)] hover:bg-surface-alt"
                )}
              >
                <action.icon className="h-4 w-4 shrink-0" /> {action.label}
              </button>
            ))}
          </div>,
          document.body
        )}
    </>
  );
}
