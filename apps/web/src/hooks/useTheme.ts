import { useCallback, useEffect, useState } from "react";
import { api } from "../lib/api";
import { useAuthStore } from "../store/auth-store";

type ThemePreference = "LIGHT" | "DARK" | "AUTO";

function applyTheme(preference: ThemePreference) {
  const prefersDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
  const isDark = preference === "DARK" || (preference === "AUTO" && prefersDark);
  document.documentElement.classList.toggle("dark", isDark);
}

export function useTheme() {
  const [preference, setPreference] = useState<ThemePreference>(
    () => (localStorage.getItem("theme") as ThemePreference | null) ?? "AUTO"
  );
  const user = useAuthStore((s) => s.user);

  useEffect(() => {
    applyTheme(preference);
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const listener = () => preference === "AUTO" && applyTheme("AUTO");
    media.addEventListener("change", listener);
    return () => media.removeEventListener("change", listener);
  }, [preference]);

  const setTheme = useCallback(
    (next: ThemePreference) => {
      setPreference(next);
      localStorage.setItem("theme", next);
      if (user) api.patch("/settings/theme", { theme: next }).catch(() => undefined);
    },
    [user]
  );

  return { preference, setTheme };
}
