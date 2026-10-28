import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Pencil, Plus, Trash2 } from "lucide-react";
import { toast } from "sonner";
import type { QuickReplyDTO } from "@whatsunivida/types";
import { api, getApiErrorMessage } from "../../lib/api";
import { QuickReplyFormModal, type QuickReplyFormValues } from "./QuickReplyFormModal";

export default function RespostasRapidasPage() {
  const queryClient = useQueryClient();
  const [modalQuickReply, setModalQuickReply] = useState<QuickReplyDTO | null | "new">(null);
  const [deleteTarget, setDeleteTarget] = useState<QuickReplyDTO | null>(null);

  const { data: quickReplies, isLoading } = useQuery({
    queryKey: ["quick-replies"],
    queryFn: async () => (await api.get<QuickReplyDTO[]>("/quick-replies")).data,
  });

  const createMutation = useMutation({
    mutationFn: (values: QuickReplyFormValues) => api.post("/quick-replies", values),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["quick-replies"] });
      toast.success("Resposta rápida criada.");
    },
  });

  const updateMutation = useMutation({
    mutationFn: ({ id, values }: { id: string; values: QuickReplyFormValues }) => api.patch(`/quick-replies/${id}`, values),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["quick-replies"] });
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

  async function handleSubmit(values: QuickReplyFormValues) {
    try {
      if (modalQuickReply && modalQuickReply !== "new") {
        await updateMutation.mutateAsync({ id: modalQuickReply.id, values });
      } else {
        await createMutation.mutateAsync(values);
      }
    } catch (err) {
      throw new Error(getApiErrorMessage(err));
    }
  }

  return (
    <div className="flex h-full flex-col overflow-hidden p-3 sm:p-6">
      <div className="mb-4 flex items-center justify-between">
        <p className="text-sm text-muted">
          Textos prontos que o atendente insere na conversa digitando "/" seguido do atalho. Cada resposta só aparece para quem atende pela conexão selecionada.
        </p>
        <button
          onClick={() => setModalQuickReply("new")}
          className="focus-ring flex shrink-0 items-center gap-1.5 rounded-card bg-primary px-4 py-2 text-sm font-semibold text-primary-fg hover:opacity-90"
        >
          <Plus className="h-4 w-4" /> Nova resposta rápida
        </button>
      </div>

      <div className="shadow-soft flex-1 overflow-auto rounded-card border border-border bg-surface">
        <table className="w-full text-sm">
          <thead className="sticky top-0 bg-surface-alt text-left text-xs uppercase tracking-wide text-muted">
            <tr>
              <th className="px-4 py-3">Nome</th>
              <th className="px-4 py-3">Atalho</th>
              <th className="px-4 py-3">Conexão</th>
              <th className="px-4 py-3">Texto</th>
              <th className="px-4 py-3 text-right">Ações</th>
            </tr>
          </thead>
          <tbody>
            {isLoading && (
              <tr>
                <td colSpan={5} className="px-4 py-8 text-center text-muted">
                  Carregando...
                </td>
              </tr>
            )}
            {!isLoading && quickReplies?.length === 0 && (
              <tr>
                <td colSpan={5} className="px-4 py-8 text-center text-muted">
                  Nenhuma resposta rápida cadastrada ainda.
                </td>
              </tr>
            )}
            {quickReplies?.map((qr) => (
              <tr key={qr.id} className="border-t border-border hover:bg-surface-alt">
                <td className="px-4 py-3 font-medium">{qr.name}</td>
                <td className="px-4 py-3">
                  <code className="rounded bg-surface-alt px-1.5 py-0.5 text-xs">/{qr.shortcut}</code>
                </td>
                <td className="px-4 py-3 text-muted">{qr.whatsappConnectionName}</td>
                <td className="max-w-xs truncate px-4 py-3 text-muted" title={qr.text}>
                  {qr.text}
                </td>
                <td className="px-4 py-3">
                  <div className="flex justify-end gap-1">
                    <button onClick={() => setModalQuickReply(qr)} className="focus-ring rounded-card p-1.5 text-muted hover:bg-surface-alt" aria-label="Editar" title="Editar">
                      <Pencil className="h-4 w-4" />
                    </button>
                    <button
                      onClick={() => setDeleteTarget(qr)}
                      className="focus-ring rounded-card p-1.5 text-muted hover:bg-red-50 hover:text-red-600"
                      aria-label="Excluir"
                      title="Excluir"
                    >
                      <Trash2 className="h-4 w-4" />
                    </button>
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
