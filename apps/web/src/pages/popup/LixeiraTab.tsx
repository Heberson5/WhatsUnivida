import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { RotateCcw, Trash2 } from "lucide-react";
import type { AnnouncementAdminDTO, AnnouncementBoardSettingsDTO } from "@whatsatendende/types";
import { api, getApiErrorMessage } from "../../lib/api";
import { KindBadge } from "../../components/announcements/announcement-ui";

type TrashItem = AnnouncementAdminDTO & { purgeOn: string };

/** Pop Up › Lixeira: deleted notices, kept for the configured days — restore them or remove them for good. */
export function LixeiraTab() {
  const queryClient = useQueryClient();
  const { data } = useQuery({
    queryKey: ["announcements", "trash"],
    queryFn: async () => (await api.get<{ items: TrashItem[]; settings: AnnouncementBoardSettingsDTO }>("/announcements/trash")).data,
  });
  const [days, setDays] = useState("");
  useEffect(() => {
    if (data) setDays(String(data.settings.trashDays));
  }, [data]);
  const refresh = () => queryClient.invalidateQueries({ queryKey: ["announcements"] });

  const saveDays = useMutation({
    mutationFn: () => api.patch("/announcements/trash/settings", { trashDays: Number(days) }),
    onSuccess: () => {
      refresh();
      toast.success("Prazo da Lixeira salvo.");
    },
    onError: (err) => toast.error(getApiErrorMessage(err)),
  });
  const restore = useMutation({
    mutationFn: (id: string) => api.post(`/announcements/trash/${id}/restore`),
    onSuccess: () => {
      refresh();
      toast.success("Aviso restaurado para Avisos.");
    },
    onError: (err) => toast.error(getApiErrorMessage(err)),
  });
  const purge = useMutation({
    mutationFn: (id: string) => api.delete(`/announcements/trash/${id}`),
    onSuccess: () => {
      refresh();
      toast.success("Aviso excluído de vez.");
    },
    onError: (err) => toast.error(getApiErrorMessage(err)),
  });

  return (
    <div className="h-full overflow-y-auto pb-6">
      <div className="shadow-soft mb-4 flex flex-wrap items-end justify-between gap-4 rounded-card border border-border bg-surface p-5">
        <div className="max-w-xl">
          <h2 className="text-base font-semibold">Lixeira</h2>
          <p className="mt-1 text-sm text-muted">Os avisos excluídos ficam aqui antes de sumirem de vez, para recuperar um apagado por engano. Depois do prazo, são removidos com as imagens e os PDFs.</p>
        </div>
        <label className="flex items-end gap-2">
          <span className="text-sm">
            <span className="mb-1 block font-medium">Manter itens por</span>
            <span className="flex items-center gap-2">
              <input type="number" min={1} max={365} value={days} onChange={(e) => setDays(e.target.value)} className="focus-ring w-20 rounded-card border border-border bg-transparent px-3 py-2 text-sm" /> dias
            </span>
          </span>
          <button
            onClick={() => saveDays.mutate()}
            disabled={!days || Number(days) === data?.settings.trashDays || saveDays.isPending}
            className="focus-ring rounded-card bg-primary px-4 py-2 text-sm font-semibold text-primary-fg disabled:opacity-50"
          >
            Salvar
          </button>
        </label>
      </div>

      {data?.items.length === 0 && <div className="rounded-card border border-dashed border-border p-8 text-center text-sm text-muted">A Lixeira está vazia.</div>}
      <ul className="space-y-2">
        {data?.items.map((a) => (
          <li key={a.id} className="flex flex-wrap items-center gap-3 rounded-card border border-border bg-surface p-3">
            <KindBadge kind={a.kind} />
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-semibold">{a.title}</p>
              <p className="text-xs text-muted">
                Excluído em {new Date(a.deletedAt!).toLocaleDateString("pt-BR")} · some de vez em {new Date(a.purgeOn).toLocaleDateString("pt-BR")}
              </p>
            </div>
            <button onClick={() => restore.mutate(a.id)} className="focus-ring flex items-center gap-1 rounded-lg border border-border px-2.5 py-1 text-xs font-medium hover:bg-surface-alt">
              <RotateCcw className="h-3.5 w-3.5" /> Restaurar
            </button>
            <button
              onClick={() => window.confirm(`Excluir de vez "${a.title}"? Não tem como desfazer.`) && purge.mutate(a.id)}
              className="focus-ring flex items-center gap-1 rounded-lg px-2.5 py-1 text-xs font-medium text-red-600 hover:bg-red-500/10"
            >
              <Trash2 className="h-3.5 w-3.5" /> Excluir de vez
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
