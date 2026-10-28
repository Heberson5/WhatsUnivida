import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import clsx from "clsx";
import { EllipsisVertical } from "lucide-react";
import type { ColumnViewColumn } from "@whatsatendende/types";
import type { ColumnViewState } from "../../hooks/useColumnView";
import { ColumnListEditor } from "./ColumnListEditor";

const MENU_WIDTH_REM = 18;
const VIEWPORT_MARGIN_PX = 8;

const SOURCE_LABEL = {
  temporary: "Usando só agora — vale até você sair do sistema",
  own: "Sua visão salva",
  shared: "Visão compartilhada",
  system: "Padrão do sistema",
} as const;

/** The ⋮ button at the left of a table header: show/hide and reorder columns, for now or as the user's default. */
export function ColumnViewMenu({ view }: { view: ColumnViewState }) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<ColumnViewColumn[]>(view.columns);
  const [name, setName] = useState("");
  const [position, setPosition] = useState({ top: 0, left: 0 });
  const buttonRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  function openMenu() {
    setDraft(view.columns);
    setName(view.saved?.source === "own" ? view.saved.name : "");
    setOpen(true);
  }

  useLayoutEffect(() => {
    if (!open || !buttonRef.current || !menuRef.current) return;
    const rect = buttonRef.current.getBoundingClientRect();
    const menu = menuRef.current.getBoundingClientRect();
    setPosition({
      top: Math.min(rect.bottom + 4, window.innerHeight - menu.height - VIEWPORT_MARGIN_PX),
      left: Math.max(VIEWPORT_MARGIN_PX, Math.min(rect.left, window.innerWidth - menu.width - VIEWPORT_MARGIN_PX)),
    });
  }, [open]);

  useEffect(() => {
    if (!open) return;
    function onPointer(e: MouseEvent) {
      const target = e.target as Node;
      if (!menuRef.current?.contains(target) && !buttonRef.current?.contains(target)) setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    function onResize() {
      setOpen(false);
    }
    document.addEventListener("mousedown", onPointer);
    document.addEventListener("keydown", onKey);
    window.addEventListener("resize", onResize);
    return () => {
      document.removeEventListener("mousedown", onPointer);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("resize", onResize);
    };
  }, [open]);

  const visibleCount = draft.filter((c) => c.visible).length;
  const sharedBy = view.source === "shared" && view.saved ? ` por ${view.saved.ownerName}` : "";

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        onClick={() => (open ? setOpen(false) : openMenu())}
        className={clsx(
          "focus-ring -my-1 inline-flex rounded-md p-1 normal-case tracking-normal text-muted hover:bg-surface hover:text-[var(--color-text)]",
          view.source !== "system" && "text-primary"
        )}
        aria-label="Escolher colunas"
        aria-expanded={open}
        title="Escolher colunas"
      >
        <EllipsisVertical className="h-4 w-4" />
      </button>
      {open &&
        createPortal(
          <div
            ref={menuRef}
            role="dialog"
            aria-label="Colunas da tabela"
            className="shadow-soft fixed z-50 rounded-card border border-border bg-surface p-2 text-left text-sm normal-case tracking-normal text-[var(--color-text)]"
            style={{
              top: position.top,
              left: position.left,
              width: `${MENU_WIDTH_REM}rem`,
            }}
          >
            <div className="px-1.5 pb-2">
              <p className="font-semibold">Colunas</p>
              <p className="text-xs text-muted">
                {SOURCE_LABEL[view.source]}
                {sharedBy}
              </p>
            </div>
            <ColumnListEditor screen={view.screen} columns={draft} onChange={setDraft} />
            <div className="mt-2 space-y-2 border-t border-border px-1.5 pt-2">
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                maxLength={60}
                placeholder="Nome da visão (opcional)"
                aria-label="Nome da visão"
                className="focus-ring w-full rounded-md border border-border bg-surface px-2 py-1.5 text-xs"
              />
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={() => {
                    view.applyNow(draft);
                    setOpen(false);
                  }}
                  disabled={visibleCount === 0}
                  className="focus-ring flex-1 rounded-md border border-border px-2 py-1.5 text-xs font-semibold hover:bg-surface-alt disabled:opacity-50"
                  title="Vale até você sair do sistema"
                >
                  Usar só agora
                </button>
                <button
                  type="button"
                  onClick={() => view.saveDefault.mutate({ next: draft, name: name.trim() || undefined }, { onSuccess: () => setOpen(false) })}
                  disabled={visibleCount === 0 || view.saveDefault.isPending}
                  className="focus-ring flex-1 rounded-md bg-primary px-2 py-1.5 text-xs font-semibold text-primary-fg hover:opacity-90 disabled:opacity-60"
                >
                  {view.saveDefault.isPending ? "Salvando..." : "Salvar como padrão"}
                </button>
              </div>
              {view.source === "temporary" && (
                <button
                  type="button"
                  onClick={() => {
                    view.discardTemporary();
                    setOpen(false);
                  }}
                  className="focus-ring w-full rounded-md px-2 py-1 text-xs text-muted hover:bg-surface-alt hover:text-[var(--color-text)]"
                >
                  Descartar e voltar à visão padrão
                </button>
              )}
              {view.source === "own" && (
                <button
                  type="button"
                  onClick={() =>
                    view.resetDefault.mutate(undefined, {
                      onSuccess: () => setOpen(false),
                    })
                  }
                  disabled={view.resetDefault.isPending}
                  className="focus-ring w-full rounded-md px-2 py-1 text-xs text-muted hover:bg-surface-alt hover:text-[var(--color-text)]"
                >
                  Apagar minha visão e voltar ao padrão
                </button>
              )}
            </div>
          </div>,
          document.body
        )}
    </>
  );
}
