import { useQuery } from "@tanstack/react-query";
import type { MaintenanceSettingsDTO } from "@whatsatendende/types";
import { api } from "../lib/api";

/**
 * Public — reachable before authentication, same precedent as useBranding —
 * so the login screen can swap in the maintenance experience for a
 * non-admin before they ever type credentials. Polled every 30s so a login
 * page left open catches an admin toggling maintenance on/off without a
 * manual refresh.
 */
export function useMaintenanceStatus() {
  return useQuery({
    queryKey: ["maintenance-status"],
    queryFn: async () => (await api.get<MaintenanceSettingsDTO>("/settings/maintenance")).data,
    staleTime: 15_000,
    refetchInterval: 30_000,
  });
}
