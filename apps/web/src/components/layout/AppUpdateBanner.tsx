import { useState } from "react";
import { Download, X } from "lucide-react";
import { useBranding } from "../../hooks/useBranding";
import { isStandalone } from "../../hooks/useInstallPrompt";

const SEEN_IDENTITY_KEY = "appIdentitySeen";

/**
 * Tells already-installed users the app's icon/name changed and they need
 * to reinstall to see it — the OS-level icon/label is frozen at install
 * time and never updates on its own (Android or Windows). Only shown to
 * people actually running the installed app (isStandalone). The first
 * identity this device sees counts as the installed one; the notice shows
 * when it changes, until dismissed.
 */
export function AppUpdateBanner() {
  const { data: branding } = useBranding();
  const identity = branding ? [branding.appName, branding.appIconUrl].join("|") : null;
  const [seenIdentity, setSeenIdentity] = useState(() => {
    try {
      return localStorage.getItem(SEEN_IDENTITY_KEY);
    } catch {
      return null;
    }
  });

  if (!identity || !isStandalone()) return null;
  if (seenIdentity === null) {
    try {
      localStorage.setItem(SEEN_IDENTITY_KEY, identity);
    } catch {
      // storage blocked: no notice on this device
    }
    return null;
  }
  if (seenIdentity === identity) return null;

  function dismiss() {
    try {
      localStorage.setItem(SEEN_IDENTITY_KEY, identity!);
    } catch {
      // storage blocked: hidden until the page reloads
    }
    setSeenIdentity(identity);
  }

  return (
    <div className="flex items-center gap-3 border-b border-border bg-secondary/20 px-4 py-2 text-sm">
      <Download className="h-4 w-4 shrink-0 text-text" />
      <p className="flex-1 text-text">
        O ícone e o nome do aplicativo foram atualizados. Para ver a versão nova, desinstale e instale o aplicativo novamente. Se você já
        atualizou, pode ignorar este aviso.
      </p>
      <button type="button" onClick={dismiss} className="focus-ring shrink-0 rounded-full p-1 text-text hover:bg-surface-alt" aria-label="Dispensar aviso">
        <X className="h-4 w-4" />
      </button>
    </div>
  );
}
