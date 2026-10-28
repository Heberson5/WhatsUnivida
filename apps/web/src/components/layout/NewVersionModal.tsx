import { useCallback, useEffect, useState } from "react";
import { RefreshCw } from "lucide-react";
import { reloadToNewVersion, useNewVersionAvailable } from "../../hooks/useNewVersion";
import { useAnyComposerBusy, useComposerActivityStore } from "../../store/composer-activity-store";

export const SNOOZE_MS = 10 * 60_000;
const WARNING = "Se não atualizar, pode ocorrer alguma falha inesperada.";

/**
 * "Nova versão do sistema disponível": shown to everyone whose page was open
 * when a new version was deployed. Waits while a message or audio is being
 * written/recorded and appears once it is sent. "Lembrar em 10 minutos" hides
 * it for a while; until the page reloads a bar stays at the top.
 */
export function NewVersionModal() {
  const busy = useAnyComposerBusy();
  // Another tab clicked "Atualizar agora": follow it, unless something is unsent here.
  const followOtherTab = useCallback(() => {
    if (Object.keys(useComposerActivityStore.getState().busy).length === 0) window.location.reload();
  }, []);
  const available = useNewVersionAvailable(followOtherTab);
  const [snoozedUntil, setSnoozedUntil] = useState(0);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!snoozedUntil) return;
    const timer = setTimeout(() => setNow(Date.now()), Math.max(0, snoozedUntil - Date.now()));
    return () => clearTimeout(timer);
  }, [snoozedUntil]);

  if (!available) return null;
  const snoozed = snoozedUntil > now;

  if (busy || snoozed) {
    return (
      <div role="status" className="flex items-center gap-3 border-b border-border bg-warning-soft px-4 py-2 text-sm">
        <RefreshCw className="h-4 w-4 shrink-0 text-text" />
        <p className="flex-1 text-text">
          <strong>Nova versão do sistema disponível.</strong> {WARNING}
        </p>
        <button type="button" onClick={reloadToNewVersion} className="focus-ring shrink-0 rounded-lg bg-primary px-3 py-1 text-xs font-semibold text-primary-fg hover:opacity-90">
          Atualizar
        </button>
      </div>
    );
  }

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/40 px-4">
      <div
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="new-version-title"
        aria-describedby="new-version-text"
        className="w-full max-w-md rounded-card border border-border bg-surface p-6 shadow-elevated"
      >
        <div className="flex items-start gap-3">
          <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary">
            <RefreshCw className="h-5 w-5" />
          </span>
          <div className="min-w-0">
            <h2 id="new-version-title" className="text-lg font-semibold">
              Nova versão do sistema disponível
            </h2>
            <p id="new-version-text" className="mt-1 text-sm text-text">
              O sistema foi atualizado enquanto você estava com ele aberto. Atualize para continuar usando a versão mais recente.
            </p>
            <p className="mt-2 text-sm font-semibold text-danger">{WARNING}</p>
          </div>
        </div>
        <div className="mt-5 flex flex-wrap justify-end gap-2">
          <button
            type="button"
            onClick={() => {
              setSnoozedUntil(Date.now() + SNOOZE_MS);
              setNow(Date.now());
            }}
            className="focus-ring rounded-lg border border-border px-4 py-2 text-sm font-medium hover:bg-surface-alt"
          >
            Lembrar em 10 minutos
          </button>
          <button type="button" autoFocus onClick={reloadToNewVersion} className="focus-ring rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-primary-fg hover:opacity-90">
            Atualizar agora
          </button>
        </div>
        <p className="mt-4 text-xs text-muted">Se não resolver, aperte Ctrl+Shift+R ou feche e abra o aplicativo ou o navegador.</p>
      </div>
    </div>
  );
}
