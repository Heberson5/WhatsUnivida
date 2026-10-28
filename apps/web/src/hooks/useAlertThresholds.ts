import { useQuery } from "@tanstack/react-query";
import { api } from "../lib/api";

export interface AlertThresholds {
  noReplyWarningMinutes: number;
  noReplyDangerMinutes: number;
  queueWarningMinutes: number;
  queueDangerMinutes: number;
}

// Same defaults as the API's DEFAULT_BUSINESS_SETTINGS, used until the settings load.
export const DEFAULT_ALERT_THRESHOLDS: AlertThresholds = { noReplyWarningMinutes: 5, noReplyDangerMinutes: 15, queueWarningMinutes: 5, queueDangerMinutes: 10 };

/** Configurações › Fila: when a card turns yellow, then red. Shares the "business-settings" query with the settings panels. */
export function useAlertThresholds(): AlertThresholds {
  const { data } = useQuery({
    queryKey: ["business-settings"],
    queryFn: async () => (await api.get<Partial<AlertThresholds>>("/settings/business")).data,
    staleTime: 5 * 60_000,
  });
  return {
    noReplyWarningMinutes: data?.noReplyWarningMinutes ?? DEFAULT_ALERT_THRESHOLDS.noReplyWarningMinutes,
    noReplyDangerMinutes: data?.noReplyDangerMinutes ?? DEFAULT_ALERT_THRESHOLDS.noReplyDangerMinutes,
    queueWarningMinutes: data?.queueWarningMinutes ?? DEFAULT_ALERT_THRESHOLDS.queueWarningMinutes,
    queueDangerMinutes: data?.queueDangerMinutes ?? DEFAULT_ALERT_THRESHOLDS.queueDangerMinutes,
  };
}
