import { useEffect } from "react";

/**
 * Asks the browser once per session for permission to show native OS
 * notifications (the kind that pop up from Windows' own notification
 * center, even with the browser minimized or another app in focus) — see
 * PROMPT: alertas devem aparecer no Windows através do navegador quando
 * chega uma nova mensagem. Only actually prompts when the user has never
 * answered yet ("default"); does nothing once they've granted or denied it.
 */
export function useDesktopNotificationPermission() {
  useEffect(() => {
    if (typeof Notification === "undefined") return;
    if (Notification.permission === "default") {
      Notification.requestPermission().catch(() => undefined);
    }
  }, []);
}

/**
 * Fires a native OS notification for a new message. Deliberately skipped
 * when the user is already looking at this tab — the in-app toast (see
 * useSocketEvents) already covers that case, and a native popup on top of
 * it would just be a redundant second alert for the exact same event.
 * `tag` collapses repeated notifications for the same conversation into one
 * (each new one replaces the last) instead of stacking a pile of them.
 */
export function notifyDesktop(title: string, body: string, tag?: string): void {
  if (typeof Notification === "undefined" || Notification.permission !== "granted") return;
  if (document.visibilityState === "visible" && document.hasFocus()) return;

  const notification = new Notification(title, { body, icon: "/favicon.svg", tag });
  notification.onclick = () => {
    window.focus();
    notification.close();
  };
}
