import { useQuery } from "@tanstack/react-query";
import { useEffect } from "react";
import { api } from "../lib/api";

export interface Branding {
  companyName: string;
  primaryColor: string;
  secondaryColor: string;
  logoUrl: string | null;
  faviconUrl: string | null;
  // PWA install identity (Android/iOS/desktop home-screen/taskbar icon +
  // label) — separate from companyName/logoUrl, see settings.service.ts.
  appName: string | null;
  appIconUrl: string | null;
}

export function useBranding() {
  const query = useQuery({
    queryKey: ["branding"],
    queryFn: async () => (await api.get<Branding>("/settings/branding")).data,
    staleTime: 5 * 60 * 1000,
  });

  useEffect(() => {
    if (!query.data) return;
    document.documentElement.style.setProperty("--color-primary", query.data.primaryColor);
    document.documentElement.style.setProperty("--color-secondary", query.data.secondaryColor);
    document.title = query.data.companyName;
    if (query.data.faviconUrl) {
      const link = document.getElementById("app-favicon") as HTMLLinkElement | null;
      if (link) link.href = query.data.faviconUrl;
    }
    // Android/desktop Chrome/Edge read the install name/icon fresh from
    // /api/settings/manifest.webmanifest each time (see index.html), so
    // those need no client-side update here. iOS Safari is the exception —
    // it ignores the web manifest entirely and reads apple-touch-icon/
    // apple-mobile-web-app-title straight from the current DOM at the
    // moment "Adicionar à Tela de Início" is tapped, which is after this
    // effect has already run.
    const appName = query.data.appName ?? query.data.companyName;
    const titleMeta = document.getElementById("app-apple-title") as HTMLMetaElement | null;
    if (titleMeta) titleMeta.content = appName;
    if (query.data.appIconUrl) {
      const iconLink = document.getElementById("app-apple-touch-icon") as HTMLLinkElement | null;
      if (iconLink) iconLink.href = query.data.appIconUrl;
    }
  }, [query.data]);

  return query;
}
