import { useEffect, useRef } from "react";
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { toast } from "sonner";
import { api } from "../lib/api";
import { useAuthStore } from "../store/auth-store";

const CHECK_INTERVAL_MS = 15_000;
// How often, at most, the server hears that the person is using the system — it ends the session by itself
// (a couple of minutes after the limit) when the browser couldn't, e.g. a tab frozen while the computer slept.
const REPORT_INTERVAL_MS = 30_000;
const ACTIVITY_EVENTS = ["mousemove", "mousedown", "keydown", "scroll", "touchstart", "wheel"] as const;
// Shared by every tab of the system: someone working in one tab isn't logged out by another one left behind.
export const LAST_ACTIVITY_KEY = "whatsatendende:last-activity-at";

function readSharedActivity(): number {
  try {
    return Number(window.localStorage.getItem(LAST_ACTIVITY_KEY)) || 0;
  } catch {
    return 0;
  }
}

function writeSharedActivity(at: number) {
  try {
    window.localStorage.setItem(LAST_ACTIVITY_KEY, String(at));
  } catch {
    // Private mode / blocked storage: this tab's own clock still works.
  }
}

/**
 * Logs out a session nobody has used (mouse, keyboard, touch, scroll) for the number of minutes set in
 * Configurações › Sessão (`inactivityTimeoutMinutes`; a 0/missing value never logs anyone out).
 *
 * The clock only moves with real use — never with the access token's silent renewal every 15 minutes, which
 * used to restart it and kept an idle tab logged in forever (see PROMPT: "deixei conectado de um dia para o
 * outro e não fez logoff automaticamente"). It is checked every 15 seconds and again as soon as the tab comes
 * back into view, so a computer that slept through the limit is logged out the moment it wakes up.
 */
export function useIdleLogout(): void {
  const hasSession = useAuthStore((s) => Boolean(s.accessToken));
  const clearSession = useAuthStore((s) => s.clearSession);
  const navigate = useNavigate();
  const lastActivityRef = useRef(Date.now());
  const lastReportRef = useRef(0);

  const { data } = useQuery({
    queryKey: ["business-settings", "inactivity-timeout"],
    queryFn: async () => (await api.get<{ inactivityTimeoutMinutes?: number }>("/settings/business")).data,
    enabled: hasSession,
    staleTime: 5 * 60 * 1000,
  });
  const timeoutMinutes = data?.inactivityTimeoutMinutes;

  // A session that has just started (a login, or the browser reopening it) starts its clock now. Keyed on
  // whether there IS a session, not on the token itself: the token is renewed in the background.
  useEffect(() => {
    if (!hasSession) return;
    lastActivityRef.current = Date.now();
    lastReportRef.current = Date.now();
    writeSharedActivity(lastActivityRef.current);
  }, [hasSession]);

  useEffect(() => {
    if (!hasSession) return;
    const markActive = () => {
      const now = Date.now();
      // At most one storage write per second, however fast the mouse moves.
      if (now - lastActivityRef.current >= 1000) writeSharedActivity(now);
      lastActivityRef.current = now;
      if (now - lastReportRef.current >= REPORT_INTERVAL_MS) {
        lastReportRef.current = now;
        api.post("/auth/activity").catch(() => undefined);
      }
    };
    ACTIVITY_EVENTS.forEach((event) => window.addEventListener(event, markActive, { passive: true, capture: true }));
    return () => {
      ACTIVITY_EVENTS.forEach((event) => window.removeEventListener(event, markActive, { capture: true }));
    };
  }, [hasSession]);

  useEffect(() => {
    if (!hasSession || !timeoutMinutes || timeoutMinutes <= 0) return;
    const timeoutMs = timeoutMinutes * 60 * 1000;
    let loggingOut = false;

    const check = () => {
      if (loggingOut) return;
      const lastActivity = Math.max(lastActivityRef.current, readSharedActivity());
      if (Date.now() - lastActivity < timeoutMs) return;
      loggingOut = true;
      api
        .post("/auth/logout")
        .catch(() => undefined)
        .finally(() => {
          clearSession();
          toast.error("Sessão encerrada por inatividade.");
          navigate("/login");
        });
    };
    const checkWhenVisible = () => {
      if (document.visibilityState === "visible") check();
    };

    check();
    const interval = setInterval(check, CHECK_INTERVAL_MS);
    document.addEventListener("visibilitychange", checkWhenVisible);
    window.addEventListener("focus", check);
    return () => {
      clearInterval(interval);
      document.removeEventListener("visibilitychange", checkWhenVisible);
      window.removeEventListener("focus", check);
    };
  }, [hasSession, timeoutMinutes, clearSession, navigate]);
}
