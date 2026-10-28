import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Pencil, Plus, Trash2, X } from "lucide-react";
import { toast } from "sonner";
import { PERMISSION, type PauseReasonDTO } from "@whatsatendende/types";
import { useAuthStore } from "../../store/auth-store";
import { api, getApiErrorMessage } from "../../lib/api";
import { ColumnViewMenu } from "../../components/common/ColumnViewMenu";
import { useColumnView } from "../../hooks/useColumnView";

/** Cadastro dos motivos que um atendente pode escolher ao pausar o atendimento (ver Topbar). */
export function MotivoPausaTab() {
  const columnView = useColumnView("respostasMotivoPausa");
  const queryClient = useQueryClient();
  const permissions = useAuthStore((s) => s.permissions);
  const canAdicionar = permissions?.[PERMISSION.RESPOSTAS_MOTIVO_PAUSA_ADICIONAR];
  const canEditar = permissions?.[PERMISSION.RESPOSTAS_MOTIVO_PAUSA_EDITAR];
  const canExcluir = permissions?.[PERMISSION.RESPOSTAS_MOTIVO_PAUSA_EXCLUIR];
  const [name, setName] = useState("");
  const [editingTarget, setEditingTarget] = useState<PauseReasonDTO | null>(null);
  const [editingName, setEditingName] = useState("");
  const [deleteTarget, setDeleteTarget] = useState<PauseReasonDTO | null>(null);

  const { data: reasons, isLoading } = useQuery({
    queryKey: ["pause-reasons"],
    queryFn: async () => (await api.get<PauseReasonDTO[]>("/pause-reasons")).data,
  });

  const createMutation = useMutation({
    mutationFn: (value: string) => api.post("/pause-reasons", { name: value }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["pause-reasons"] });
      setName("");
      toast.success("Motivo de pausa criado.");
    },
    onError: (err) => toast.error(getApiErrorMessage(err)),
  });

  const updateMutation = useMutation({
    mutationFn: ({ id, value }: { id: string; value: string }) => api.patch(`/pause-reasons/${id}`, { name: value }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["pause-reasons"] });
      setEditingTarget(null);
      toast.success("Motivo de pausa atualizado.");
    },
    onError: (err) => toast.error(getApiErrorMessage(err)),
  });

  const deactivateMutation = useMutation({
    mutationFn: (id: string) => api.delete(`/pause-reasons/${id}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["pause-reasons"] });
      queryClient.invalidateQueries({ queryKey: ["pause-reasons-active"] });
      toast.success("Motivo de pausa desativado.");
      setDeleteTarget(null);
    },
    onError: (err) => toast.error(getApiErrorMessage(err)),
  });

  function handleCreate() {
    if (!name.trim()) return;
    createMutation.mutate(name.trim());
  }

  function startEditing(reason: PauseReasonDTO) {
    setEditingTarget(reason);
    setEditingName(reason.name);
  }

  function handleSaveEdit() {
    if (!editingTarget || !editingName.trim()) return;
    updateMutation.mutate({ id: editingTarget.id, value: editingName.trim() });
  }

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-muted">
          Motivos disponíveis para o atendente escolher ao pausar o atendimento. Desativar um motivo não apaga o histórico de
          pausas já registradas com ele.
        </p>
      </div>

      {canAdicionar && (
        <div className="mb-4 flex gap-2">
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && handleCreate()}
            placeholder="Ex: Almoço, Banheiro, Reunião..."
            maxLength={60}
            className="focus-ring min-w-0 flex-1 rounded-card border border-border bg-transparent px-3 py-2 text-sm"
          />
          <button
            onClick={handleCreate}
            disabled={!name.trim() || createMutation.isPending}
            className="focus-ring flex shrink-0 items-center gap-1.5 rounded-card bg-primary px-4 py-2 text-sm font-semibold text-primary-fg hover:opacity-90 disabled:opacity-60"
          >
            <Plus className="h-4 w-4" /> Adicionar
          </button>
        </div>
      )}

      <div className="shadow-soft flex-1 overflow-auto rounded-card border border-border bg-surface">
        <table className="w-full text-sm">
          <thead className="sticky top-0 bg-surface-alt text-left text-xs uppercase tracking-wide text-muted">
            <tr>
              <th className="w-0 py-3 pl-2 pr-0">
                <ColumnViewMenu view={columnView} />
              </th>
              {columnView.visibleKeys.map((key) => {
                switch (key) {
                  case "name":
                    return (
                      <th key="name" className="px-4 py-3">Nome</th>
                    );
                  case "status":
                    return (
                      <th key="status" className="px-4 py-3">Status</th>
                    );
                  default:
                    return null;
                }
              })}
              <th className="px-4 py-3 text-right">Ações</th>
            </tr>
          </thead>
          <tbody>
            {isLoading && (
              <tr>
                <td colSpan={columnView.visibleKeys.length + 2} className="px-4 py-8 text-center text-muted">
                  Carregando...
                </td>
              </tr>
            )}
            {!isLoading && reasons?.length === 0 && (
              <tr>
                <td colSpan={columnView.visibleKeys.length + 2} className="px-4 py-8 text-center text-muted">
                  Nenhum motivo de pausa cadastrado ainda.
                </td>
              </tr>
            )}
            {reasons?.map((r) => (
              <tr key={r.id} className="border-t border-border hover:bg-surface-alt">
                <td className="w-0 p-0" />
                {columnView.visibleKeys.map((key) => {
                  switch (key) {
                    case "name":
                      return (
                        <td key="name" className="px-4 py-3 font-medium">
                          {editingTarget?.id === r.id ? (
                            <input
                              autoFocus
                              value={editingName}
                              onChange={(e) => setEditingName(e.target.value)}
                              onKeyDown={(e) => e.key === "Enter" && handleSaveEdit()}
                              maxLength={60}
                              className="focus-ring w-full rounded-card border border-border bg-transparent px-2 py-1 text-sm"
                            />
                          ) : (
                            r.name
                          )}
                        </td>
                      );
                    case "status":
                      return (
                        <td key="status" className="px-4 py-3">
                          <span
                            className={`rounded-full px-2 py-0.5 text-xs font-medium ${r.active ? "bg-green-100 text-green-700" : "bg-gray-100 text-gray-600"}`}
                          >
                            {r.active ? "Ativo" : "Inativo"}
                          </span>
                        </td>
                      );
                    default:
                      return null;
                  }
                })}
                <td className="px-4 py-3">
                  <div className="flex justify-end gap-1">
                    {editingTarget?.id === r.id ? (
                      <>
                        <button
                          onClick={handleSaveEdit}
                          disabled={updateMutation.isPending}
                          className="focus-ring rounded-card px-2 py-1 text-xs font-semibold text-primary hover:bg-surface-alt disabled:opacity-60"
                        >
                          Salvar
                        </button>
                        <button
                          onClick={() => setEditingTarget(null)}
                          className="focus-ring rounded-card p-1.5 text-muted hover:bg-surface-alt"
                          aria-label="Cancelar"
                          title="Cancelar"
                        >
                          <X className="h-4 w-4" />
                        </button>
                      </>
                    ) : (
                      <>
                        {canEditar && (
                          <button
                            onClick={() => startEditing(r)}
                            className="focus-ring rounded-card p-1.5 text-muted hover:bg-surface-alt"
                            aria-label="Editar"
                            title="Editar"
                          >
                            <Pencil className="h-4 w-4" />
                          </button>
                        )}
                        {canExcluir && r.active && (
                          <button
                            onClick={() => setDeleteTarget(r)}
                            className="focus-ring rounded-card p-1.5 text-muted hover:bg-danger-soft hover:text-danger"
                            aria-label="Desativar"
                            title="Desativar"
                          >
                            <Trash2 className="h-4 w-4" />
                          </button>
                        )}
                      </>
                    )}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {deleteTarget && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-4">
          <div className="w-full max-w-sm rounded-card border border-border bg-surface p-5 shadow-elevated">
            <h2 className="text-base font-semibold">Desativar motivo de pausa?</h2>
            <p className="mt-2 text-sm text-muted">
              "{deleteTarget.name}" deixa de aparecer na lista de pausa do atendente. O histórico de pausas já feitas com esse
              motivo é mantido.
            </p>
            <div className="mt-5 flex gap-2">
              <button onClick={() => setDeleteTarget(null)} className="focus-ring flex-1 rounded-card border border-border py-2 text-sm">
                Cancelar
              </button>
              <button
                onClick={() => deactivateMutation.mutate(deleteTarget.id)}
                disabled={deactivateMutation.isPending}
                className="focus-ring flex-1 rounded-card bg-red-600 py-2 text-sm font-semibold text-white disabled:opacity-60"
              >
                {deactivateMutation.isPending ? "Desativando..." : "Desativar"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
