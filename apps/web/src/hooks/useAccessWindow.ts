import { useEffect, useRef } from "react";
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { toast } from "sonner";
import { api } from "../lib/api";
import { useAuthStore } from "../store/auth-store";

const CHECK_INTERVAL_MS = 60_000;
// See PROMPT: "aparece um pop up informando que a 20 minutos o sistema será
// encerrado, e depois um segundo de 10 minutos e o último de 1 minuto" —
// each fires at most once per day (tracked in warnedRef, reset whenever
// minutesRemainingToday goes back to null, i.e. a fresh unrestricted
// stretch or a new day).
const WARNING_THRESHOLDS_MIN = [20, 10, 1];

interface AccessStatus {
  allowed: boolean;
  reason?: "OUTSIDE_SCHEDULE" | "HOLIDAY";
  message?: string;
  minutesRemainingToday: number | null;
}

/**
 * Live-polls whether this session is still within its allowed access
 * window/free of an active holiday block (see auth.routes.ts's
 * GET /auth/access-status), warns at 20/10/1 minutes before today's window
 * closes, and force-logs-out once it does — see PROMPT: "bloqueia... fora
 * do horário" and the 20/10/1-minute warning popups. A user with no
 * accessSchedule/workCity on file always gets `allowed: true,
 * minutesRemainingToday: null` back, so this hook is a permanent no-op for
 * them beyond the one polling request every minute.
 */
export function useAccessWindow(): void {
  const accessToken = useAuthStore((s) => s.accessToken);
  const clearSession = useAuthStore((s) => s.clearSession);
  const navigate = useNavigate();
  const warnedRef = useRef(new Set<number>());

  const { data } = useQuery<AccessStatus>({
    queryKey: ["access-status"],
    queryFn: async () => (await api.get<AccessStatus>("/auth/access-status", { params: { tzOffsetMinutes: new Date().getTimezoneOffset() } })).data,
    enabled: Boolean(accessToken),
    refetchInterval: accessToken ? CHECK_INTERVAL_MS : false,
    // A stale cached "allowed" from right before the window closed must
    // never be trusted past its own poll tick.
    staleTime: 0,
  });

  useEffect(() => {
    if (!data) return;

    if (!data.allowed) {
      toast.error(data.message ?? "Acesso bloqueado no momento.");
      api
        .post("/auth/logout")
        .catch(() => undefined)
        .finally(() => {
          clearSession();
          navigate("/login");
        });
      return;
    }

    const remaining = data.minutesRemainingToday;
    if (remaining === null) {
      warnedRef.current.clear();
      return;
    }
    for (const threshold of WARNING_THRESHOLDS_MIN) {
      if (remaining <= threshold && !warnedRef.current.has(threshold)) {
        warnedRef.current.add(threshold);
        toast.warning(
          threshold === 1
            ? "Seu acesso será encerrado em 1 minuto — o horário permitido está terminando."
            : `Seu acesso será encerrado em ${threshold} minutos — o horário permitido está terminando.`
        );
      }
    }
  }, [data, clearSession, navigate]);
}
