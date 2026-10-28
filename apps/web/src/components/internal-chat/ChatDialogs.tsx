import { useState, type ReactNode } from "react";
import clsx from "clsx";
import { X } from "lucide-react";

/** A small dialog over the chat panel (not the browser's own confirm box). */
export function ChatDialog({ title, icon, onClose, children, wide }: { title: string; icon?: ReactNode; onClose: () => void; children: ReactNode; wide?: boolean }) {
  return (
    <div className="absolute inset-0 z-30 flex items-center justify-center bg-black/40 p-4" onClick={onClose} role="presentation">
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onClick={(e) => e.stopPropagation()}
        className={clsx("chat-pop flex max-h-full w-full flex-col overflow-hidden rounded-2xl border border-border bg-surface shadow-elevated", wide ? "max-w-md" : "max-w-sm")}
      >
        <div className="flex items-center gap-2 border-b border-border px-4 py-3">
          {icon}
          <h3 className="flex-1 text-sm font-bold">{title}</h3>
          <button onClick={onClose} className="focus-ring rounded-full p-1 text-muted hover:bg-surface-alt" aria-label="Fechar">
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="overflow-y-auto p-4 text-sm">{children}</div>
      </div>
    </div>
  );
}

/** "Excluir grupo", "Remover do grupo"...: what will happen, and — for the irreversible ones — typing the name to confirm. */
export function ChatConfirm({
  title,
  icon,
  message,
  confirmLabel,
  danger,
  typeToConfirm,
  busy,
  onConfirm,
  onClose,
}: {
  title: string;
  icon?: ReactNode;
  message: ReactNode;
  confirmLabel: string;
  danger?: boolean;
  typeToConfirm?: string;
  busy?: boolean;
  onConfirm: () => void;
  onClose: () => void;
}) {
  const [typed, setTyped] = useState("");
  const ready = !typeToConfirm || typed.trim().toLowerCase() === typeToConfirm.trim().toLowerCase();
  return (
    <ChatDialog title={title} icon={icon} onClose={onClose}>
      <div className="space-y-3">
        <div className="text-muted">{message}</div>
        {typeToConfirm && (
          <label className="block space-y-1 text-xs">
            <span>
              Digite <b>{typeToConfirm}</b> para confirmar
            </span>
            <input autoFocus value={typed} onChange={(e) => setTyped(e.target.value)} className="focus-ring w-full rounded-card border border-border bg-surface-alt px-3 py-2 text-sm" />
          </label>
        )}
        <div className="flex justify-end gap-2">
          <button onClick={onClose} className="focus-ring rounded-card border border-border px-3 py-1.5 text-sm font-semibold hover:bg-surface-alt">
            Cancelar
          </button>
          <button
            onClick={onConfirm}
            disabled={!ready || busy}
            className={clsx("focus-ring rounded-card px-3 py-1.5 text-sm font-semibold disabled:opacity-50", danger ? "bg-danger text-white" : "bg-primary text-primary-fg")}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </ChatDialog>
  );
}
