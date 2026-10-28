import { useQuery } from "@tanstack/react-query";
import { api } from "../lib/api";

/**
 * Logo/cor/nome used only in the PowerPoint export and PDF/Excel reports —
 * its own settings, independent from the app's Identidade visual (useBranding).
 * See PROMPT: "Na guia Exportações... Não é para ter vínculo com a
 * Identidade Visual".
 */
export interface ExportBranding {
  companyName: string;
  primaryColor: string;
  logoUrl: string | null;
}

export function useExportBranding() {
  return useQuery({
    queryKey: ["export-branding"],
    queryFn: async () => (await api.get<ExportBranding>("/settings/export-branding")).data,
    staleTime: 5 * 60 * 1000,
  });
}
