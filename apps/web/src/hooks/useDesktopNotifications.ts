import { useCallback, useEffect, useState } from "react";

/**
 * Tracks the browser's native-notification permission for this origin and
 * exposes a way to request it. See PROMPT: "as notificações do Windows não
 * estão aparecendo... para novas conversas e novas mensagens".
 *
 * Deliberately does NOT auto-request permission on mount anymore (the
 * previous behavior) — Chrome's "quiet permission UI" heuristic
 * increasingly auto-suppresses notification prompts triggered without a
 * genuine user gesture (a click) into a barely-visible address-bar icon
 * instead of the real popup, and calling requestPermission() on every
 * login/page load (every mount, whenever permission was still "default")
 * is exactly the repeated-non-gesture-request pattern that heuristic
 * escalates against — the prompt silently stops showing at all, which is
 * almost certainly why notifications looked like they'd never worked.
 * requestPermission (returned below) must only ever be called from inside
 * a real onClick handler — see the bell button in Topbar.
 */
export function useNotificationPermission() {
  const [permission, setPermission] = useState<NotificationPermission | "unsupported">(
    typeof Notification === "undefined" ? "unsupported" : Notification.permission
  );

  useEffect(() => {
    if (typeof Notification === "undefined" || !navigator.permissions?.query) return;
    let status: PermissionStatus | undefined;
    let cancelled = false;
    navigator.permissions
      .query({ name: "notifications" as PermissionName })
      .then((result) => {
        if (cancelled) return;
        status = result;
        // Picks up a change made outside this app too — e.g. the user
        // revoking it later via the browser's own site-settings UI, not
        // just a grant/deny made through requestPermission() below.
        status.onchange = () => setPermission(Notification.permission);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
      if (status) status.onchange = null;
    };
  }, []);

  const requestPermission = useCallback(async (): Promise<NotificationPermission | "unsupported"> => {
    if (typeof Notification === "undefined") return "unsupported";
    const result = await Notification.requestPermission();
    setPermission(result);
    return result;
  }, []);

  return { permission, requestPermission };
}

// Same icon as the installed app (Identidade visual > ícone do aplicativo,
// or the default PNG the manifest falls back to). Windows can't render the
// SVG favicon in a notification, which is why a generic icon used to show up.
const DEFAULT_NOTIFICATION_ICON = "/icons/icon-192.png";
let notificationIcon = DEFAULT_NOTIFICATION_ICON;

/** Called by useBranding whenever the configured app icon is known/changes. */
export function setNotificationIcon(url: string | null): void {
  notificationIcon = url ? new URL(url, window.location.origin).href : DEFAULT_NOTIFICATION_ICON;
}

/**
 * Fires a native OS notification for a new message. Always fires alongside
 * the in-app toast (see useSocketEvents), even while the browser window is
 * open and focused — see PROMPT: "faça com que as notificações do Windows
 * apareça mesmo com a janela do navegador aberta". `tag` collapses repeated
 * notifications for the same conversation into one (each new one replaces
 * the last) instead of stacking a pile of them.
 */
export function notifyDesktop(title: string, body: string, tag?: string): void {
  if (typeof Notification === "undefined" || Notification.permission !== "granted") return;

  const notification = new Notification(title, { body, icon: notificationIcon, badge: notificationIcon, tag });
  notification.onclick = () => {
    window.focus();
    notification.close();
  };
}
