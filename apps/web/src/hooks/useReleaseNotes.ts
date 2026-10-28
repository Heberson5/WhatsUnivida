import { useCallback } from "react";
import { useQuery } from "@tanstack/react-query";
import { compareVersions, type ReleaseDTO } from "@whatsatendende/types";
import { api } from "../lib/api";
import { useAuthStore } from "../store/auth-store";

export const RELEASE_NOTES_QUERY_KEY = ["release-notes"];

/**
 * Notas de versão as this user sees them (the server sends only the notes about screens they can open), plus
 * whether there's a release they haven't opened yet — which drives the sidebar's "Novo" badge and the one-time
 * "O que há de novo" popup. An administrator edits them in Configurações › Notas de versão.
 */
export function useReleaseNotes() {
  const role = useAuthStore((s) => s.user?.role);
  const seenVersion = useAuthStore((s) => s.user?.releaseNotesSeenVersion ?? null);
  const updateReleaseNotesSeen = useAuthStore((s) => s.updateReleaseNotesSeen);

  const { data, isLoading } = useQuery({
    queryKey: [...RELEASE_NOTES_QUERY_KEY, role],
    queryFn: async () => (await api.get<ReleaseDTO[]>("/release-notes")).data,
    enabled: Boolean(role),
    staleTime: 5 * 60 * 1000,
  });

  const releases = data ?? [];
  const latest = releases[0] ?? null;
  const hasUnseen = latest !== null && (seenVersion === null || compareVersions(latest.version, seenVersion) > 0);
  // Every version since the person's last visit (newest first) — someone back after several updates gets all of
  // them, not only the newest. Someone who never opened the notes gets just the current one, not the whole history.
  const unseen = !hasUnseen || !latest ? [] : seenVersion === null ? [latest] : releases.filter((r) => compareVersions(r.version, seenVersion) > 0);

  const markSeen = useCallback(() => {
    if (!latest || !hasUnseen) return;
    updateReleaseNotesSeen(latest.version);
    api.patch("/profile/release-notes-seen", { version: latest.version }).catch(() => updateReleaseNotesSeen(seenVersion));
  }, [latest, hasUnseen, seenVersion, updateReleaseNotesSeen]);

  return { releases, latest, unseen, hasUnseen, markSeen, isLoading };
}
