import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Paperclip, Plus, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { PERMISSION, type MessageTemplateDTO } from "@whatsatendende/types";
import { useAuthStore } from "../../store/auth-store";
import { api, getApiErrorMessage } from "../../lib/api";
import { TemplateFormModal } from "./TemplateFormModal";
import { ColumnViewMenu } from "../../components/common/ColumnViewMenu";
import { useColumnView } from "../../hooks/useColumnView";

const CATEGORY_LABEL: Record<string, string> = { MARKETING: "Marketing", UTILITY: "Utilidade", AUTHENTICATION: "Autenticação" };
const CATEGORY_COLOR: Record<string, string> = {
  MARKETING: "bg-violet-100 text-violet-700",
  UTILITY: "bg-blue-100 text-blue-700",
  AUTHENTICATION: "bg-amber-100 text-amber-800",
};
const STATUS_LABEL: Record<string, string> = {
  DRAFT: "Rascunho",
  PENDING: "Em análise",
  APPROVED: "Aprovado",
  REJECTED: "Rejeitado",
  PAUSED: "Pausado",
  DISABLED: "Desativado",
};
const STATUS_COLOR: Record<string, string> = {
  DRAFT: "bg-gray-100 text-gray-600",
  PENDING: "bg-yellow-100 text-yellow-800",
  APPROVED: "bg-green-100 text-green-700",
  REJECTED: "bg-red-100 text-red-700",
  PAUSED: "bg-gray-100 text-gray-600",
  DISABLED: "bg-gray-100 text-gray-600",
};

/** Cadastro de templates de mensagem para aprovação da Meta — ver PROMPT: "nova aba chamada Templates, onde será cadastrado as mensagens em que a Meta terá que aprovar ou não, nas categorias de Marketing, Utilidades e Validação [Autenticação]". */
export function TemplatesTab() {
  const columnView = useColumnView("respostasTemplates");
  const queryClient = useQueryClient();
  const permissions = useAuthStore((s) => s.permissions);
  const canAdicionar = permissions?.[PERMISSION.RESPOSTAS_TEMPLATES_ADICIONAR];
  const canExcluir = permissions?.[PERMISSION.RESPOSTAS_TEMPLATES_EXCLUIR];
  const [modalOpen, setModalOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<MessageTemplateDTO | null>(null);

  const { data: templates, isLoading } = useQuery({
    queryKey: ["message-templates"],
    queryFn: async () => (await api.get<MessageTemplateDTO[]>("/message-templates")).data,
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => api.delete(`/message-templates/${id}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["message-templates"] });
      toast.success("Template excluído.");
      setDeleteTarget(null);
    },
    onError: (err) => toast.error(getApiErrorMessage(err)),
  });

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-muted">
          Mensagens pré-aprovadas pela Meta para iniciar conversa fora da janela de 24h (Marketing e Utilidade) ou
          enviar código de verificação (Autenticação). Cada template pertence a uma conexão WhatsApp Oficial.
        </p>
        {canAdicionar && (
          <button
            onClick={() => setModalOpen(true)}
            className="focus-ring flex shrink-0 items-center gap-1.5 rounded-card bg-primary px-4 py-2 text-sm font-semibold text-primary-fg hover:opacity-90"
          >
            <Plus className="h-4 w-4" /> Novo template
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
                  case "category":
                    return (
                      <th key="category" className="px-4 py-3">Categoria</th>
                    );
                  case "connection":
                    return (
                      <th key="connection" className="px-4 py-3">Conexão</th>
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
            {!isLoading && templates?.length === 0 && (
              <tr>
                <td colSpan={columnView.visibleKeys.length + 2} className="px-4 py-8 text-center text-muted">
                  Nenhum template cadastrado ainda.
                </td>
              </tr>
            )}
            {templates?.map((t) => (
              <tr key={t.id} className="border-t border-border hover:bg-surface-alt">
                <td className="w-0 p-0" />
                {columnView.visibleKeys.map((key) => {
                  switch (key) {
                    case "name":
                      return (
                        <td key="name" className="px-4 py-3 font-mono font-medium">
                          <span className="inline-flex items-center gap-1.5">
                            {t.name}
                            {t.headerType !== "NONE" && t.headerType !== "TEXT" && (
                              <Paperclip className="h-3 w-3 text-muted" aria-label="Cabeçalho com anexo" />
                            )}
                          </span>
                        </td>
                      );
                    case "category":
                      return (
                        <td key="category" className="px-4 py-3">
                          <span className={`rounded-full px-2 py-0.5 text-xs font-semibold ${CATEGORY_COLOR[t.category]}`}>{CATEGORY_LABEL[t.category]}</span>
                        </td>
                      );
                    case "connection":
                      return (
                        <td key="connection" className="px-4 py-3 text-muted">{t.whatsappConnectionName}</td>
                      );
                    case "status":
                      return (
                        <td key="status" className="px-4 py-3">
                          <span
                            className={`rounded-full px-2 py-0.5 text-xs font-medium ${STATUS_COLOR[t.status]}`}
                            title={t.status === "REJECTED" && t.rejectionReason ? t.rejectionReason : undefined}
                          >
                            {STATUS_LABEL[t.status]}
                          </span>
                        </td>
                      );
                    default:
                      return null;
                  }
                })}
                <td className="px-4 py-3">
                  <div className="flex justify-end gap-1">
                    {canExcluir && (
                      <button
                        onClick={() => setDeleteTarget(t)}
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

      {modalOpen && <TemplateFormModal onClose={() => setModalOpen(false)} />}

      {deleteTarget && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-4">
          <div className="w-full max-w-sm rounded-card border border-border bg-surface p-5 shadow-elevated">
            <h2 className="text-base font-semibold">Excluir template?</h2>
            <p className="mt-2 text-sm text-muted">
              "{deleteTarget.name}" será removido. {deleteTarget.status === "APPROVED" && "Ele já está aprovado — a exclusão também será solicitada na Meta."}
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
