import { useQuery } from "@tanstack/react-query";
import type { PhoneSettingsDTO } from "@whatsatendende/types";
import { api } from "../lib/api";

export const PHONE_SETTINGS_QUERY_KEY = ["phone-settings"] as const;

/** Configurações › Números de telefone (DDI padrão e 9 a mais). Any logged-in user can read it — Nova conversa previews the number it will use. */
export function usePhoneSettings() {
  return useQuery({
    queryKey: PHONE_SETTINGS_QUERY_KEY,
    queryFn: async () => (await api.get<PhoneSettingsDTO>("/settings/phone")).data,
    staleTime: 60_000,
  });
}
