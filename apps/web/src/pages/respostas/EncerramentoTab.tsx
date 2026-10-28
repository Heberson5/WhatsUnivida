import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Pencil, Plus, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { PERMISSION, type ClosingMessageDTO } from "@whatsatendende/types";
import { useAuthStore } from "../../store/auth-store";
import { api, getApiErrorMessage } from "../../lib/api";
import { describeConnectionScope } from "./ConnectionScopePicker";
import { EncerramentoFormModal, type EncerramentoFormValues } from "./EncerramentoFormModal";
import { saveReplyMediaOrWarn, type ReplyMediaChange } from "./ReplyMediaField";
import { MediaBadge } from "./RespostasRapidasTab";
import { ColumnViewMenu } from "../../components/common/ColumnViewMenu";
import { useColumnView } from "../../hooks/useColumnView";
import { NoReturnSettingsCard } from "./NoReturnSettingsCard";

/** Cadastro de mensagens de encerramento automático — ver PROMPT: "Encerramento, o cadastro deverá ser similar com a resposta rápida, mas com alguns diferenciais." */
export function EncerramentoTab() {
  const columnView = useColumnView("respostasEncerramento");
  const queryClient = useQueryClient();
  const permissions = useAuthStore((s) => s.permissions);
  const canAdicionar = permissions?.[PERMISSION.RESPOSTAS_ENCERRAMENTO_ADICIONAR];
  const canEditar = permissions?.[PERMISSION.RESPOSTAS_ENCERRAMENTO_EDITAR];
  const canExcluir = permissions?.[PERMISSION.RESPOSTAS_ENCERRAMENTO_EXCLUIR];
  const [modalTarget, setModalTarget] = useState<ClosingMessageDTO | null | "new">(null);
  const [deleteTarget, setDeleteTarget] = useState<ClosingMessageDTO | null>(null);

  const { data: closingMessages, isLoading } = useQuery({
    queryKey: ["closing-messages"],
    queryFn: async () => (await api.get<ClosingMessageDTO[]>("/closing-messages")).data,
  });

  // The row first, then its attachment (a new one only has an id once it is saved).
  const createMutation = useMutation({
    mutationFn: async ({ values, media }: { values: EncerramentoFormValues; media: ReplyMediaChange }) => {
      const { data } = await api.post<ClosingMessageDTO>("/closing-messages", values);
      await saveReplyMediaOrWarn("/closing-messages", data.id, media);
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: ["closing-messages"] }),
    onSuccess: () => toast.success("Encerramento criado."),
  });

  const updateMutation = useMutation({
    mutationFn: async ({ id, values, media }: { id: string; values: EncerramentoFormValues; media: ReplyMediaChange }) => {
      await api.patch(`/closing-messages/${id}`, values);
      await saveReplyMediaOrWarn("/closing-messages", id, media);
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: ["closing-messages"] }),
    onSuccess: () => toast.success("Encerramento atualizado."),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => api.delete(`/closing-messages/${id}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["closing-messages"] });
      toast.success("Encerramento excluído.");
      setDeleteTarget(null);
    },
    onError: (err) => toast.error(getApiErrorMessage(err)),
  });

  async function handleSubmit(values: EncerramentoFormValues, media: ReplyMediaChange) {
    try {
      if (modalTarget && modalTarget !== "new") {
        await updateMutation.mutateAsync({ id: modalTarget.id, values, media });
      } else {
        await createMutation.mutateAsync({ values, media });
      }
    } catch (err) {
      throw new Error(getApiErrorMessage(err));
    }
  }

  return (
    <div className="flex h-full flex-col overflow-y-auto">
      <NoReturnSettingsCard canEdit={Boolean(canEditar)} />
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-muted">
          Mensagem enviada automaticamente ao cliente quando um dos usuários selecionados clica em Encerrar. Um usuário só pode estar em um encerramento por vez.
        </p>
        {canAdicionar && (
          <button
            onClick={() => setModalTarget("new")}
            className="focus-ring flex shrink-0 items-center gap-1.5 rounded-card bg-primary px-4 py-2 text-sm font-semibold text-primary-fg hover:opacity-90"
          >
            <Plus className="h-4 w-4" /> Novo encerramento
          </button>
        )}
      </div>

      <div className="shadow-soft min-h-[16rem] flex-1 overflow-auto rounded-card border border-border bg-surface">
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
                  case "text":
                    return (
                      <th key="text" className="px-4 py-3">Texto</th>
                    );
                  case "users":
                    return (
                      <th key="users" className="px-4 py-3">Usuários</th>
                    );
                  case "connections":
                    return (
                      <th key="connections" className="px-4 py-3">Conexões</th>
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
            {!isLoading && closingMessages?.length === 0 && (
              <tr>
                <td colSpan={columnView.visibleKeys.length + 2} className="px-4 py-8 text-center text-muted">
                  Nenhum encerramento cadastrado ainda.
                </td>
              </tr>
            )}
            {closingMessages?.map((cm) => (
              <tr key={cm.id} className="border-t border-border hover:bg-surface-alt">
                <td className="w-0 p-0" />
                {columnView.visibleKeys.map((key) => {
                  switch (key) {
                    case "name":
                      return (
                        <td key="name" className="px-4 py-3 font-medium">
                          {cm.name}
                          <span className="block text-xs font-normal text-muted">{cm.showSenderName ? "Com o nome do atendente" : "Sem o nome do atendente"}</span>
                        </td>
                      );
                    case "text":
                      return (
                        <td key="text" className="max-w-xs px-4 py-3 text-muted" title={cm.text}>
                          <span className="flex items-center gap-1.5">
                            {cm.media && <MediaBadge kind={cm.media.kind} />}
                            <span className="truncate">{cm.text}</span>
                          </span>
                        </td>
                      );
                    case "users":
                      return (
                        <td key="users" className="px-4 py-3 text-muted">
                          {cm.assignedUsers.length === 0 ? "-" : cm.assignedUsers.map((u) => u.displayName).join(", ")}
                        </td>
                      );
                    case "connections":
                      return (
                        <td key="connections" className="max-w-[14rem] truncate px-4 py-3 text-muted" title={describeConnectionScope(cm.connectionScope)}>
                          {describeConnectionScope(cm.connectionScope)}
                        </td>
                      );
                    case "status":
                      return (
                        <td key="status" className="px-4 py-3">
                          <span
                            className={`rounded-full px-2 py-0.5 text-xs font-medium ${cm.active ? "bg-green-100 text-green-700" : "bg-gray-100 text-gray-600"}`}
                          >
                            {cm.active ? "Ativo" : "Inativo"}
                          </span>
                        </td>
                      );
                    default:
                      return null;
                  }
                })}
                <td className="px-4 py-3">
                  <div className="flex justify-end gap-1">
                    {canEditar && (
                      <button onClick={() => setModalTarget(cm)} className="focus-ring rounded-card p-1.5 text-muted hover:bg-surface-alt" aria-label="Editar" title="Editar">
                        <Pencil className="h-4 w-4" />
                      </button>
                    )}
                    {canExcluir && (
                      <button
                        onClick={() => setDeleteTarget(cm)}
                        className="focus-ring rounded-card p-1.5 text-muted hover:bg-danger-soft hover:text-danger"
                        aria-label="Excluir"
                        title="Excluir"
                      >
                        <Trash2 className="h-4 w-4" />
                      </button>
                    )}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {modalTarget && (
        <EncerramentoFormModal
          closingMessage={modalTarget === "new" ? null : modalTarget}
          allClosingMessages={closingMessages ?? []}
          onClose={() => setModalTarget(null)}
          onSubmit={handleSubmit}
        />
      )}

      {deleteTarget && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-4">
          <div className="w-full max-w-sm rounded-card border border-border bg-surface p-5 shadow-elevated">
            <h2 className="text-base font-semibold">Excluir encerramento?</h2>
            <p className="mt-2 text-sm text-muted">"{deleteTarget.name}" será removido permanentemente. Os usuários vinculados ficam sem encerramento automático.</p>
            <div className="mt-5 flex gap-2">
              <button onClick={() => setDeleteTarget(null)} className="focus-ring flex-1 rounded-card border border-border py-2 text-sm">
                Cancelar
              </button>
              <button
                onClick={() => deleteMutation.mutate(deleteTarget.id)}
                disabled={deleteMutation.isPending}
                className="focus-ring flex-1 rounded-card bg-red-600 py-2 text-sm font-semibold text-white disabled:opacity-60"
              >
                {deleteMutation.isPending ? "Excluindo..." : "Excluir"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
