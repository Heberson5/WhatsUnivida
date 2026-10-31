import { useQuery } from "@tanstack/react-query";
import { PERMISSION, type AnnouncementBoardSettingsDTO, type AnnouncementDTO } from "@whatsatendende/types";
import { api } from "../lib/api";
import { useAuthStore } from "../store/auth-store";

const tz = () => new Date().getTimezoneOffset();

export interface BoardResponse {
  settings: AnnouncementBoardSettingsDTO;
  items: AnnouncementDTO[];
  unread: number;
}

/** What the Comunicados board is called (configurable in Pop Up › Avisos) — "Comunicados" until it loads. */
export function useBoardName(): string {
  const { data } = useQuery({
    queryKey: ["announcements", "settings"],
    queryFn: async () => (await api.get<AnnouncementBoardSettingsDTO>("/announcements/settings")).data,
    staleTime: 5 * 60_000,
  });
  return data?.name ?? "Comunicados";
}

/** The Comunicados board for this person — shared by the page and the top bar's badge (same cache key). */
export function useAnnouncementBoard() {
  const canReceive = useAuthStore((s) => Boolean(s.permissions?.[PERMISSION.COMUNICADOS_VER]));
  return useQuery({
    queryKey: ["announcements", "board"],
    queryFn: async () => (await api.get<BoardResponse>("/announcements/board", { params: { tz: tz() } })).data,
    enabled: canReceive,
    refetchInterval: 60_000,
  });
}

export function usePendingAnnouncements() {
  const canReceive = useAuthStore((s) => Boolean(s.permissions?.[PERMISSION.COMUNICADOS_VER]));
  return useQuery({
    queryKey: ["announcements", "pending"],
    queryFn: async () => (await api.get<AnnouncementDTO[]>("/announcements/pending", { params: { tz: tz() } })).data,
    enabled: canReceive,
    staleTime: 0,
    // A notice starts at its own time, on each person's clock.
    refetchInterval: 60_000,
  });
}

export { tz as announcementTz };
