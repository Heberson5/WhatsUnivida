import { useEffect } from "react";
import { CircleAlert } from "lucide-react";

/**
 * Sticky "você tem alterações não salvas" bar for settings forms that only
 * apply on Salvar. Also asks the browser to confirm before closing the tab
 * while something is still unsaved.
 */
export function UnsavedChangesBar({
  dirty,
  saving,
  onSave,
  onDiscard,
  canSave = true,
}: {
  dirty: boolean;
  saving?: boolean;
  onSave: () => void;
  onDiscard: () => void;
  canSave?: boolean;
}) {
  useEffect(() => {
    if (!dirty) return;
    const handler = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [dirty]);

  if (!dirty) return null;
  return (
    <div
      role="status"
      className="sticky bottom-3 z-10 mt-6 flex flex-wrap items-center gap-2 rounded-card bg-[var(--color-text)] px-3 py-2.5 text-sm text-surface shadow-elevated"
    >
      <CircleAlert className="h-4 w-4 shrink-0" />
      <span className="flex-1">Você tem alterações não salvas</span>
      <button type="button" onClick={onDiscard} disabled={saving} className="focus-ring rounded-lg border border-white/20 px-3 py-1 text-xs font-medium hover:bg-white/10">
        Descartar
      </button>
      <button
        type="button"
        onClick={onSave}
        disabled={saving || !canSave}
        className="focus-ring rounded-lg bg-primary px-3 py-1 text-xs font-semibold text-primary-fg disabled:opacity-60"
      >
        {saving ? "Salvando..." : "Salvar alterações"}
      </button>
    </div>
  );
}
