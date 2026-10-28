import { useEffect } from "react";
import { api } from "../lib/api";
import { useAuthStore } from "../store/auth-store";

/** Attempts a silent refresh on first load so a page reload doesn't force a re-login while the refresh cookie is valid. */
export function useBootstrapSession() {
  const setSession = useAuthStore((s) => s.setSession);
  const setHydrated = useAuthStore((s) => s.setHydrated);
  const hydrated = useAuthStore((s) => s.hydrated);

  useEffect(() => {
    if (hydrated) return;
    api
      .post("/auth/refresh", null, { params: { tzOffsetMinutes: new Date().getTimezoneOffset() } })
      .then((res) => setSession(res.data.accessToken, res.data.user, res.data.permissions))
      .catch(() => undefined)
      .finally(() => setHydrated());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}
