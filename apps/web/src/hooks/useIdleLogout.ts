import { useEffect, useRef } from "react";
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { toast } from "sonner";
import { api } from "../lib/api";
import { useAuthStore } from "../store/auth-store";

// An hours-scale timeout doesn't need finer-grained polling than this.
const CHECK_INTERVAL_MS = 60_000;
const ACTIVITY_EVENTS = ["mousemove", "mousedown", "keydown", "scroll", "touchstart"] as const;

/**
 * Auto-logs-out a session that's had no real user interaction on this tab
 * for the configured number of minutes — see PROMPT: logoff automático após
 * xx horas de inatividade, configurável em Configurações. Reads the same
 * `inactivityTimeoutMinutes` business setting the admin edits in
 * Configurações > Segurança; a 0/missing value means "not configured" and
 * never logs anyone out. Activity is tracked in a ref (not React state) so
 * a mousemove doesn't trigger a re-render on every pixel.
 */
export function useIdleLogout(): void {
  const accessToken = useAuthStore((s) => s.accessToken);
  const clearSession = useAuthStore((s) => s.clearSession);
  const navigate = useNavigate();
  const lastActivityRef = useRef(Date.now());

  const { data } = useQuery({
    queryKey: ["business-settings", "inactivity-timeout"],
    queryFn: async () => (await api.get<{ inactivityTimeoutMinutes?: number }>("/settings/business")).data,
    enabled: Boolean(accessToken),
    staleTime: 5 * 60 * 1000,
  });

  useEffect(() => {
    if (!accessToken) return;
    const markActive = () => {
      lastActivityRef.current = Date.now();
    };
    ACTIVITY_EVENTS.forEach((event) => window.addEventListener(event, markActive, { passive: true, capture: true }));
    return () => {
      ACTIVITY_EVENTS.forEach((event) => window.removeEventListener(event, markActive, { capture: true }));
    };
  }, [accessToken]);

  useEffect(() => {
    if (!accessToken) return;
    const timeoutMinutes = data?.inactivityTimeoutMinutes;
    if (!timeoutMinutes || timeoutMinutes <= 0) return;
    const timeoutMs = timeoutMinutes * 60 * 1000;
    // Start the clock fresh once the real threshold is known, instead of
    // from whenever this hook happened to mount.
    lastActivityRef.current = Date.now();

    const interval = setInterval(() => {
      if (Date.now() - lastActivityRef.current < timeoutMs) return;
      api
        .post("/auth/logout")
        .catch(() => undefined)
        .finally(() => {
          clearSession();
          toast.error("Sessão encerrada por inatividade.");
          navigate("/login");
        });
    }, CHECK_INTERVAL_MS);

    return () => clearInterval(interval);
  }, [accessToken, data?.inactivityTimeoutMinutes, clearSession, navigate]);
}
