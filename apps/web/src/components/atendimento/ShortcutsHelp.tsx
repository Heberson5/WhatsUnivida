import { useEffect } from "react";
import { X } from "lucide-react";

const SHORTCUTS = [
  { keys: ["Alt", "↓"], label: "Próxima conversa" },
  { keys: ["Alt", "↑"], label: "Conversa anterior" },
  { keys: ["Alt", "A"], label: "Aceitar a próxima da fila" },
  { keys: ["/"], label: "Respostas rápidas" },
  { keys: ["Alt", "N"], label: "Alternar nota interna / responder" },
  { keys: ["Alt", "T"], label: "Transferir" },
  { keys: ["Alt", "E"], label: "Encerrar" },
  { keys: ["Alt", "L"], label: "Lembrar de retornar" },
  { keys: ["Esc"], label: "Fechar a conversa ou a janela aberta" },
  { keys: ["?"], label: "Mostrar estes atalhos" },
];

export function ShortcutsHelp({ onClose }: { onClose: () => void }) {
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape" || e.key === "?") {
        e.preventDefault();
        onClose();
      }
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-4" onClick={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Atalhos do teclado"
        className="w-full max-w-sm rounded-card border border-border bg-surface p-5 shadow-elevated"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-base font-semibold">Atalhos do teclado</h2>
          <button onClick={onClose} className="focus-ring rounded-full p-1 text-muted hover:bg-surface-alt" aria-label="Fechar">
            <X className="h-4 w-4" />
          </button>
        </div>
        <ul className="space-y-1.5 text-sm">
          {SHORTCUTS.map((s) => (
            <li key={s.label} className="flex items-center justify-between gap-3">
              <span>{s.label}</span>
              <span className="flex shrink-0 gap-1">
                {s.keys.map((k) => (
                  <kbd key={k} className="rounded border border-border bg-surface-alt px-1.5 py-0.5 font-mono text-[11px]">
                    {k}
                  </kbd>
                ))}
              </span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
