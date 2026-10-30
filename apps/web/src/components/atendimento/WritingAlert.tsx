import { useEffect } from "react";
import { AlertTriangle } from "lucide-react";
import type { WritingIssueDTO } from "@whatsatendende/types";

/** Shown when sending to a customer finds errors: nothing goes out until the attendant corrects it or sends it anyway. */
export function WritingAlert({
  text,
  issues,
  onApply,
  onBack,
  onSendAnyway,
}: {
  text: string;
  issues: WritingIssueDTO[];
  onApply: (index: number) => void;
  onBack: () => void;
  onSendAnyway: () => void;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onBack();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onBack]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-4" role="presentation">
      <div role="alertdialog" aria-modal="true" aria-label="A mensagem contém possíveis erros" className="shadow-elevated flex max-h-[80vh] w-full max-w-md flex-col rounded-card border border-border bg-surface">
        <div className="flex items-center gap-2 border-b border-border px-5 py-3">
          <AlertTriangle className="h-5 w-5 shrink-0 text-warning" />
          <h2 className="text-base font-semibold">A mensagem contém possíveis erros</h2>
        </div>
        <ul className="min-h-0 flex-1 space-y-2 overflow-y-auto px-5 py-3 text-sm">
          {issues.map((issue, i) => (
            <li key={`${issue.offset}-${i}`} className="flex items-start justify-between gap-3">
              <span className="min-w-0">
                <span className="font-medium text-danger line-through">{text.slice(issue.offset, issue.offset + issue.length)}</span>
                {issue.replacement !== null && (
                  <>
                    <span className="mx-1 text-muted">→</span>
                    <span className="font-medium text-success">{issue.replacement}</span>
                  </>
                )}
                <span className="block text-xs text-muted">{issue.message}</span>
              </span>
              {issue.replacement !== null && (
                <button type="button" onClick={() => onApply(i)} className="focus-ring shrink-0 rounded-full border border-border px-2.5 py-0.5 text-xs font-semibold hover:bg-surface-alt">
                  Aplicar
                </button>
              )}
            </li>
          ))}
        </ul>
        <div className="flex flex-wrap justify-end gap-2 border-t border-border px-5 py-3">
          <button type="button" onClick={onSendAnyway} className="focus-ring rounded-card border border-border px-3 py-1.5 text-sm font-semibold hover:bg-surface-alt">
            Enviar mesmo assim
          </button>
          <button type="button" autoFocus onClick={onBack} className="focus-ring rounded-card bg-primary px-3 py-1.5 text-sm font-semibold text-primary-fg">
            Voltar e corrigir
          </button>
        </div>
      </div>
    </div>
  );
}
