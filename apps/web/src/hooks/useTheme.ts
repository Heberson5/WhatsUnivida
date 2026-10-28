import { useCallback, useEffect } from "react";
import { create } from "zustand";
import { api } from "../lib/api";
import { useAuthStore } from "../store/auth-store";

export type ThemePreference = "LIGHT" | "DARK" | "AUTO";

function applyTheme(preference: ThemePreference) {
  const prefersDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
  const isDark = preference === "DARK" || (preference === "AUTO" && prefersDark);
  document.documentElement.classList.toggle("dark", isDark);
}

// Shared store (not per-component state) so the Topbar toggle and the Ctrl+K
// palette always agree on the current preference.
const useThemeStore = create<{ preference: ThemePreference; setPreference: (p: ThemePreference) => void }>((set) => ({
  preference: (localStorage.getItem("theme") as ThemePreference | null) ?? "AUTO",
  setPreference: (preference) => set({ preference }),
}));

export function useTheme() {
  const preference = useThemeStore((s) => s.preference);
  const setPreference = useThemeStore((s) => s.setPreference);
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
    [user, setPreference]
  );

  return { preference, setTheme };
}
