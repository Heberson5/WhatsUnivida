import { useCallback, useEffect, useState } from "react";

interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

function isStandalone(): boolean {
  return (
    window.matchMedia?.("(display-mode: standalone)").matches === true ||
    // iOS Safari has no display-mode support — this is its own non-standard flag for the same thing.
    (navigator as unknown as { standalone?: boolean }).standalone === true
  );
}

function isIos(): boolean {
  return /iphone|ipad|ipod/i.test(navigator.userAgent);
}

/**
 * Captures Chrome/Edge's `beforeinstallprompt` (fires on desktop AND
 * Android — the browser's own native install affordance) so an explicit
 * in-app button can trigger it on demand, instead of relying only on the
 * browser's address-bar icon or its own auto-banner heuristic, which many
 * users never notice — see PROMPT: "verifique se tem a função de instalar
 * o aplicativo no computador e se for aberto em celular, ter a opção de
 * instalar o app". iOS Safari never fires this event at all (an Apple
 * platform limitation, not a bug here), so there `canPromptInstall` stays
 * false and `isIosManual` flags that the button should still show, just
 * with manual "Compartilhar > Adicionar à Tela de Início" instructions
 * instead of a native prompt.
 */
export function useInstallPrompt() {
  const [deferredEvent, setDeferredEvent] = useState<BeforeInstallPromptEvent | null>(null);
  const [installed, setInstalled] = useState(() => isStandalone());

  useEffect(() => {
    function onBeforeInstallPrompt(event: Event) {
      event.preventDefault();
      setDeferredEvent(event as BeforeInstallPromptEvent);
    }
    function onAppInstalled() {
      setInstalled(true);
      setDeferredEvent(null);
    }
    window.addEventListener("beforeinstallprompt", onBeforeInstallPrompt);
    window.addEventListener("appinstalled", onAppInstalled);
    return () => {
      window.removeEventListener("beforeinstallprompt", onBeforeInstallPrompt);
      window.removeEventListener("appinstalled", onAppInstalled);
    };
  }, []);

  const promptInstall = useCallback(async () => {
    if (!deferredEvent) return;
    await deferredEvent.prompt();
    const choice = await deferredEvent.userChoice;
    if (choice.outcome === "accepted") setInstalled(true);
    setDeferredEvent(null);
  }, [deferredEvent]);

  return {
    installed,
    canPromptInstall: Boolean(deferredEvent),
    isIosManual: isIos() && !installed,
    promptInstall,
  };
}
