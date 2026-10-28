import { useQuery } from "@tanstack/react-query";
import { api } from "../lib/api";

/**
 * Login screen (logo size/alignment/subtitle), main menu (order/label/icon
 * of each item — shared by Sidebar and BottomNav) and page-title overrides —
 * all editable from the standalone "Landing Page" menu. Public endpoint: the
 * login screen itself needs this before anyone authenticates.
 */
export interface LandingPageSettings {
  loginLogoSizePx: number;
  loginLogoAlign: "center" | "left";
  loginSubtitle: string | null;
  menuOrder: string[];
  menuItems: Record<string, { label?: string; icon?: string }>;
  pageTitles: Record<string, string>;
}

export function useLandingPageSettings() {
  return useQuery({
    queryKey: ["landing-page"],
    queryFn: async () => (await api.get<LandingPageSettings>("/settings/landing-page")).data,
    staleTime: 5 * 60 * 1000,
  });
}
