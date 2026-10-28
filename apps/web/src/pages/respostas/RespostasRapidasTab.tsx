import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { FileText, Image as ImageIcon, Pencil, Plus, Trash2, Video } from "lucide-react";
import { toast } from "sonner";
import { PERMISSION, type QuickReplyDTO } from "@whatsatendende/types";
import { useAuthStore } from "../../store/auth-store";
import { api, getApiErrorMessage } from "../../lib/api";
import { describeConnectionScope } from "./ConnectionScopePicker";
import { QuickReplyFormModal, type QuickReplyFormValues } from "./QuickReplyFormModal";
import { saveReplyMediaOrWarn, type ReplyMediaChange } from "./ReplyMediaField";
import { ColumnViewMenu } from "../../components/common/ColumnViewMenu";
import { useColumnView } from "../../hooks/useColumnView";

export function RespostasRapidasTab() {
  const columnView = useColumnView("respostasRapidas");
  const queryClient = useQueryClient();
  const permissions = useAuthStore((s) => s.permissions);
  const canAdicionar = permissions?.[PERMISSION.RESPOSTAS_RAPIDAS_ADICIONAR];
  const canEditar = permissions?.[PERMISSION.RESPOSTAS_RAPIDAS_EDITAR];
  const canExcluir = permissions?.[PERMISSION.RESPOSTAS_RAPIDAS_EXCLUIR];
  const [modalQuickReply, setModalQuickReply] = useState<QuickReplyDTO | null | "new">(null);
  const [deleteTarget, setDeleteTarget] = useState<QuickReplyDTO | null>(null);

  const { data: quickReplies, isLoading } = useQuery({
    queryKey: ["quick-replies"],
    queryFn: async () => (await api.get<QuickReplyDTO[]>("/quick-replies")).data,
  });

  // The row first, then its attachment (a new reply only has an id once it is saved).
  const createMutation = useMutation({
    mutationFn: async ({ values, media }: { values: QuickReplyFormValues; media: ReplyMediaChange }) => {
      const { data } = await api.post<QuickReplyDTO>("/quick-replies", values);
      await saveReplyMediaOrWarn("/quick-replies", data.id, media);
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: ["quick-replies"] }),
    onSuccess: () => toast.success("Resposta rápida criada."),
  });

  const updateMutation = useMutation({
    mutationFn: async ({ id, values, media }: { id: string; values: QuickReplyFormValues; media: ReplyMediaChange }) => {
      await api.patch(`/quick-replies/${id}`, values);
      await saveReplyMediaOrWarn("/quick-replies", id, media);
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: ["quick-replies"] }),
    onSuccess: () => {
      toast.success("Resposta rápida atualizada.");
    },
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => api.delete(`/quick-replies/${id}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["quick-replies"] });
      toast.success("Resposta rápida excluída.");
      setDeleteTarget(null);
    },
    onError: (err) => toast.error(getApiErrorMessage(err)),
  });

  async function handleSubmit(values: QuickReplyFormValues, media: ReplyMediaChange) {
    try {
      if (modalQuickReply && modalQuickReply !== "new") {
        await updateMutation.mutateAsync({ id: modalQuickReply.id, values, media });
      } else {
        await createMutation.mutateAsync({ values, media });
      }
    } catch (err) {
      throw new Error(getApiErrorMessage(err));
    }
  }

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-muted">
          Textos prontos que o atendente insere na conversa digitando "/" seguido do atalho. Cada resposta aparece só nas conversas das conexões escolhidas (ou em todas).
        </p>
        {canAdicionar && (
          <button
            onClick={() => setModalQuickReply("new")}
            className="focus-ring flex shrink-0 items-center gap-1.5 rounded-card bg-primary px-4 py-2 text-sm font-semibold text-primary-fg hover:opacity-90"
          >
            <Plus className="h-4 w-4" /> Nova resposta rápida
          </button>
        )}
      </div>

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
                  case "shortcut":
                    return (
                      <th key="shortcut" className="px-4 py-3">Atalho</th>
                    );
                  case "connections":
                    return (
                      <th key="connections" className="px-4 py-3">Conexões</th>
                    );
                  case "text":
                    return (
                      <th key="text" className="px-4 py-3">Texto</th>
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
            {!isLoading && quickReplies?.length === 0 && (
              <tr>
                <td colSpan={columnView.visibleKeys.length + 2} className="px-4 py-8 text-center text-muted">
                  Nenhuma resposta rápida cadastrada ainda.
                </td>
              </tr>
            )}
            {quickReplies?.map((qr) => (
              <tr key={qr.id} className="border-t border-border hover:bg-surface-alt">
                <td className="w-0 p-0" />
                {columnView.visibleKeys.map((key) => {
                  switch (key) {
                    case "name":
                      return (
                        <td key="name" className="px-4 py-3 font-medium">{qr.name}</td>
                      );
                    case "shortcut":
                      return (
                        <td key="shortcut" className="px-4 py-3">
                          <code className="rounded bg-surface-alt px-1.5 py-0.5 text-xs">/{qr.shortcut}</code>
                        </td>
                      );
                    case "connections":
                      return (
                        <td key="connections" className="max-w-[14rem] truncate px-4 py-3 text-muted" title={describeConnectionScope(qr.connectionScope)}>
                          {describeConnectionScope(qr.connectionScope)}
                        </td>
                      );
                    case "text":
                      return (
                        <td key="text" className="max-w-xs px-4 py-3 text-muted" title={qr.text}>
                          <span className="flex items-center gap-1.5">
                            {qr.media && <MediaBadge kind={qr.media.kind} />}
                            <span className="truncate">{qr.text}</span>
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
                      <button onClick={() => setModalQuickReply(qr)} className="focus-ring rounded-card p-1.5 text-muted hover:bg-surface-alt" aria-label="Editar" title="Editar">
                        <Pencil className="h-4 w-4" />
                      </button>
                    )}
                    {canExcluir && (
                      <button
                        onClick={() => setDeleteTarget(qr)}
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

      {modalQuickReply && (
        <QuickReplyFormModal
          quickReply={modalQuickReply === "new" ? null : modalQuickReply}
          onClose={() => setModalQuickReply(null)}
          onSubmit={handleSubmit}
        />
      )}

      {deleteTarget && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-4">
          <div className="w-full max-w-sm rounded-card border border-border bg-surface p-5 shadow-elevated">
            <h2 className="text-base font-semibold">Excluir resposta rápida?</h2>
            <p className="mt-2 text-sm text-muted">
              "{deleteTarget.name}" (/{deleteTarget.shortcut}) será removida permanentemente.
            </p>
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

/** Small icon telling the reply carries an attachment — shared with Encerramento. */
export function MediaBadge({ kind }: { kind: "IMAGE" | "VIDEO" | "DOCUMENT" }) {
  const label = kind === "IMAGE" ? "Com imagem" : kind === "VIDEO" ? "Com vídeo" : "Com PDF";
  const Icon = kind === "IMAGE" ? ImageIcon : kind === "VIDEO" ? Video : FileText;
  return (
    <span title={label} aria-label={label} className="shrink-0 text-primary">
      <Icon className="h-4 w-4" />
    </span>
  );
}
