import { useMemo } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { COLUMN_SCREENS, mergeColumnView, type ColumnScreen, type ColumnViewColumn, type EffectiveColumnViewDTO } from "@whatsatendende/types";
import { api, getApiErrorMessage } from "../lib/api";
import { useTemporaryColumnView, writeTemporaryColumnView } from "../lib/temporaryColumnViews";
import { useAuthStore } from "../store/auth-store";

export const EFFECTIVE_COLUMN_VIEWS_KEY = ["column-views", "effective"];

export type ColumnViewState = ReturnType<typeof useColumnView>;

/**
 * Which columns a table shows, and in what order: "Usar só agora" (until
 * sign-out) → the user's own saved view → one shared with them → the
 * system's default. Drives the ⋮ menu (ColumnViewMenu) and the table.
 */
export function useColumnView(screen: ColumnScreen) {
  const userId = useAuthStore((s) => s.user?.id ?? "");
  const queryClient = useQueryClient();
  const temporary = useTemporaryColumnView(userId, screen);
  const { data: effective } = useQuery({
    queryKey: EFFECTIVE_COLUMN_VIEWS_KEY,
    queryFn: async () => (await api.get<Partial<Record<ColumnScreen, EffectiveColumnViewDTO>>>("/column-views/effective")).data,
    staleTime: Infinity,
  });
  const saved = effective?.[screen] ?? null;

  const columns = useMemo(() => mergeColumnView(screen, temporary ?? saved?.columns), [screen, temporary, saved]);
  const visibleKeys = useMemo(() => columns.filter((c) => c.visible).map((c) => c.key), [columns]);

  function applyNow(next: ColumnViewColumn[]) {
    writeTemporaryColumnView(userId, screen, next);
  }

  function discardTemporary() {
    writeTemporaryColumnView(userId, screen, null);
  }

  const saveDefault = useMutation({
    mutationFn: async ({ next, name }: { next: ColumnViewColumn[]; name?: string }) =>
      (await api.put(`/column-views/mine/${screen}`, { columns: next, name })).data,
    onSuccess: () => {
      writeTemporaryColumnView(userId, screen, null);
      queryClient.invalidateQueries({ queryKey: ["column-views"] });
      toast.success("Visão salva como padrão.");
    },
    onError: (err) => toast.error(getApiErrorMessage(err)),
  });

  const resetDefault = useMutation({
    mutationFn: async () => {
      await api.delete(`/column-views/mine/${screen}`);
    },
    onSuccess: () => {
      writeTemporaryColumnView(userId, screen, null);
      queryClient.invalidateQueries({ queryKey: ["column-views"] });
    },
    onError: (err) => toast.error(getApiErrorMessage(err)),
  });

  return {
    screen,
    definition: COLUMN_SCREENS[screen],
    columns,
    visibleKeys,
    source: temporary ? ("temporary" as const) : (saved?.source ?? ("system" as const)),
    saved,
    applyNow,
    discardTemporary,
    saveDefault,
    resetDefault,
  };
}
