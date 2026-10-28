import { useState } from "react";
import { Download, X } from "lucide-react";
import { useInstallPrompt } from "../../hooks/useInstallPrompt";
import { useBranding } from "../../hooks/useBranding";

const DISMISSED_AT_KEY = "installPromptDismissedAt";
// Re-offered after a few days rather than never again — someone who
// dismissed it once on a rushed login may still want the app later, and a
// permanent dismissal would mean an install invite that only ever shows
// exactly once per browser, forever.
const RESHOW_AFTER_MS = 3 * 24 * 60 * 60 * 1000;

function wasRecentlyDismissed(): boolean {
  const raw = localStorage.getItem(DISMISSED_AT_KEY);
  if (!raw) return false;
  const dismissedAt = Number(raw);
  return !Number.isNaN(dismissedAt) && Date.now() - dismissedAt < RESHOW_AFTER_MS;
}

function isAndroid(): boolean {
  return /android/i.test(navigator.userAgent);
}

/**
 * Shown on the login screen (before any credentials are entered) inviting
 * the visitor to install the app first — see PROMPT: "ao acessar pelo
 * navegador do celular, não está aparecendo um pop up para instalar o app
 * antes de fazer o login, isso tem que aparecer no computador também".
 *
 * Deliberately does NOT gate visibility on canPromptInstall/isIosManual the
 * way the Topbar's InstallAppButton does — Chrome only fires
 * beforeinstallprompt once its own engagement heuristic is satisfied
 * (roughly: a few visits over a few minutes), which is exactly why "isso
 * tem que aparecer" was reported as broken: on an early visit the earlier
 * version simply rendered nothing at all, on desktop AND Android alike.
 * This always shows something instead (unless already installed/dismissed)
 * — a one-click native install once the browser offers it, and clear
 * manual instructions for that platform otherwise, upgrading in place to
 * the native button the moment beforeinstallprompt does fire.
 */
export function InstallPromptModal() {
  const { data: branding } = useBranding();
  const { installed, canPromptInstall, isIosManual, promptInstall } = useInstallPrompt();
  const [dismissed, setDismissed] = useState(() => wasRecentlyDismissed());

  function dismiss() {
    localStorage.setItem(DISMISSED_AT_KEY, String(Date.now()));
    setDismissed(true);
  }

  function handlePrimaryAction() {
    if (canPromptInstall) {
      promptInstall();
      dismiss();
      return;
    }
    // No native dialog available (yet) — the instructions are already
    // visible in the modal body, so the button just acknowledges/dismisses.
    dismiss();
  }

  if (installed || dismissed) return null;

  const appName = branding?.appName ?? branding?.companyName ?? "o aplicativo";
  const manualInstructions = isIosManual
    ? 'Toque no ícone de Compartilhar (⬆️) na barra do navegador e depois em "Adicionar à Tela de Início".'
    : isAndroid()
      ? 'Toque no menu (⋮) do navegador e escolha "Instalar aplicativo" ou "Adicionar à tela inicial".'
      : "Clique no ícone de instalar (⊕) na barra de endereço, ou no menu do navegador escolha \"Instalar app\".";

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-4">
      <div className="shadow-elevated w-full max-w-sm rounded-card border border-border bg-surface p-6">
        <div className="flex items-start justify-between gap-3">
          <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl bg-primary/10 text-primary">
            <Download className="h-6 w-6" />
          </div>
          <button type="button" onClick={dismiss} className="focus-ring rounded-full p-1 text-muted hover:bg-surface-alt" aria-label="Fechar">
            <X className="h-5 w-5" />
          </button>
        </div>
        <h2 className="mt-4 text-base font-semibold">Instalar {appName}</h2>
        <p className="mt-1.5 text-sm text-muted">
          Instale para abrir direto da tela inicial ou da área de trabalho, sem precisar do navegador — é mais rápido e funciona como um
          aplicativo de verdade.
        </p>
        {!canPromptInstall && <p className="mt-2 rounded-card bg-surface-alt px-3 py-2 text-xs text-muted">{manualInstructions}</p>}
        <div className="mt-5 flex gap-2">
          <button type="button" onClick={dismiss} className="focus-ring flex-1 rounded-card border border-border py-2 text-sm">
            Agora não
          </button>
          <button
            type="button"
            onClick={handlePrimaryAction}
            className="focus-ring flex-1 rounded-card bg-primary py-2 text-sm font-semibold text-primary-fg"
          >
            {canPromptInstall ? "Instalar" : "Entendi"}
          </button>
        </div>
      </div>
    </div>
  );
}
