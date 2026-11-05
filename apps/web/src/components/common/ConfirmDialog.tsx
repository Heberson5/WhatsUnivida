import { useEffect, useRef } from "react";
import { create } from "zustand";
import clsx from "clsx";
import { AlertTriangle, Trash2 } from "lucide-react";
import { useEscapeKey } from "../../hooks/useEscapeKey";

/**
 * The system's own "are you sure?" — replaces the browser's window.confirm, which shows the server's address
 * ("localhost diz…") and a blue "OK" even for something destructive. Call it from anywhere:
 *
 *   if (await confirmAction({ title: "Excluir layout?", message: "…", confirmLabel: "Excluir layout" })) remove();
 *
 * Esc, clicking outside, or "Cancelar" resolve to false. <ConfirmHost /> (mounted once in AppLayout) draws it.
 */
export interface ConfirmOptions {
  title: string;
  message?: React.ReactNode;
  /** Names the action, e.g. "Excluir agendamento" — never just "OK". */
  confirmLabel: string;
  cancelLabel?: string;
  /** Destructive (red button, trash icon) unless set to "neutral". */
  tone?: "danger" | "neutral";
}

interface ConfirmState {
  current: (ConfirmOptions & { resolve: (ok: boolean) => void }) | null;
  open: (options: ConfirmOptions) => Promise<boolean>;
  settle: (ok: boolean) => void;
}

const useConfirmStore = create<ConfirmState>((set, get) => ({
  current: null,
  open: (options) =>
    new Promise<boolean>((resolve) => {
      // A second confirmation while one is open answers the first one "no" rather than leaving it hanging.
      get().current?.resolve(false);
      set({ current: { ...options, resolve } });
    }),
  settle: (ok) => {
    const current = get().current;
    set({ current: null });
    current?.resolve(ok);
  },
}));

export function confirmAction(options: ConfirmOptions): Promise<boolean> {
  return useConfirmStore.getState().open(options);
}

export function ConfirmHost() {
  const current = useConfirmStore((s) => s.current);
  const settle = useConfirmStore((s) => s.settle);
  const cancelRef = useRef<HTMLButtonElement>(null);
  useEscapeKey(() => settle(false), Boolean(current));
  // Focus starts on "Cancelar": an Enter pressed by reflex never deletes anything.
  useEffect(() => {
    if (current) cancelRef.current?.focus();
  }, [current]);

  if (!current) return null;
  const danger = current.tone !== "neutral";
  const Icon = danger ? Trash2 : AlertTriangle;

  return (
    <div className="fixed inset-0 z-[80] flex items-center justify-center bg-black/45 px-4" onClick={() => settle(false)}>
      <div
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="confirm-title"
        aria-describedby={current.message ? "confirm-message" : undefined}
        className="w-full max-w-md rounded-card border border-border bg-surface p-5 shadow-elevated"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex gap-3.5">
          <span className={clsx("flex h-10 w-10 shrink-0 items-center justify-center rounded-xl", danger ? "bg-danger-soft text-danger" : "bg-warning-soft text-warning")}>
            <Icon className="h-5 w-5" />
          </span>
          <div className="min-w-0">
            <h2 id="confirm-title" className="text-base font-semibold">
              {current.title}
            </h2>
            {current.message && (
              <div id="confirm-message" className="mt-1.5 text-sm leading-relaxed text-muted">
                {current.message}
              </div>
            )}
          </div>
        </div>
        <div className="mt-5 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <button ref={cancelRef} type="button" onClick={() => settle(false)} className="focus-ring rounded-lg border border-border px-4 py-2 text-sm font-semibold hover:bg-surface-alt">
            {current.cancelLabel ?? "Cancelar"}
          </button>
          <button
            type="button"
            onClick={() => settle(true)}
            className={clsx("focus-ring rounded-lg px-4 py-2 text-sm font-semibold hover:opacity-90", danger ? "bg-danger text-white" : "bg-primary text-primary-fg")}
          >
            {current.confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
