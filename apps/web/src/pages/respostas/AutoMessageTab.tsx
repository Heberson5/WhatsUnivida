import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Pencil, Plus, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { PERMISSION, type AutoMessageTemplateDTO, type AutoMessageTrigger, type Permission } from "@whatsatendende/types";
import { useAuthStore } from "../../store/auth-store";
import { api, getApiErrorMessage } from "../../lib/api";
import { describeConnectionScope } from "./ConnectionScopePicker";
import { describeUserScope } from "./UserScopePicker";
import { AutoMessageFormModal, type AutoMessageFormValues } from "./AutoMessageFormModal";
import { ColumnViewMenu } from "../../components/common/ColumnViewMenu";
import { useColumnView } from "../../hooks/useColumnView";

const TRIGGER_PERMISSION: Record<AutoMessageTrigger, { adicionar: Permission; editar: Permission; excluir: Permission }> = {
  TRANSFER: {
    adicionar: PERMISSION.RESPOSTAS_TRANSFERENCIA_ADICIONAR,
    editar: PERMISSION.RESPOSTAS_TRANSFERENCIA_EDITAR,
    excluir: PERMISSION.RESPOSTAS_TRANSFERENCIA_EXCLUIR,
  },
  ACCEPT: {
    adicionar: PERMISSION.RESPOSTAS_ACEITE_ADICIONAR,
    editar: PERMISSION.RESPOSTAS_ACEITE_EDITAR,
    excluir: PERMISSION.RESPOSTAS_ACEITE_EXCLUIR,
  },
};

/** Transferência and Aceite are the same list/CRUD shape, just a different trigger — see AutoMessageFormModal. */
export function AutoMessageTab({ trigger, description, emptyMessage }: { trigger: AutoMessageTrigger; description: string; emptyMessage: string }) {
  // Only Aceite chooses who uses each message (see AutoMessageFormModal), so only its screen has the "Quem pode usar" column.
  const columnView = useColumnView(trigger === "ACCEPT" ? "respostasAceite" : "respostasTransferencia");
  const queryClient = useQueryClient();
  const permissions = useAuthStore((s) => s.permissions);
  const canAdicionar = permissions?.[TRIGGER_PERMISSION[trigger].adicionar];
  const canEditar = permissions?.[TRIGGER_PERMISSION[trigger].editar];
  const canExcluir = permissions?.[TRIGGER_PERMISSION[trigger].excluir];
  const [modalTarget, setModalTarget] = useState<AutoMessageTemplateDTO | null | "new">(null);
  const [deleteTarget, setDeleteTarget] = useState<AutoMessageTemplateDTO | null>(null);

  const queryKey = ["auto-message-templates", trigger];
  const { data: templates, isLoading } = useQuery({
    queryKey,
    queryFn: async () => (await api.get<AutoMessageTemplateDTO[]>("/auto-message-templates", { params: { trigger } })).data,
  });

  const createMutation = useMutation({
    mutationFn: (values: AutoMessageFormValues) => api.post("/auto-message-templates", values),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey });
      toast.success("Mensagem automática criada.");
    },
  });

  const updateMutation = useMutation({
    mutationFn: ({ id, values }: { id: string; values: AutoMessageFormValues }) => api.patch(`/auto-message-templates/${id}`, values),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey });
      toast.success("Mensagem automática atualizada.");
    },
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => api.delete(`/auto-message-templates/${id}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey });
      toast.success("Mensagem automática excluída.");
      setDeleteTarget(null);
    },
    onError: (err) => toast.error(getApiErrorMessage(err)),
  });

  async function handleSubmit(values: AutoMessageFormValues) {
    try {
      if (modalTarget && modalTarget !== "new") {
        await updateMutation.mutateAsync({ id: modalTarget.id, values });
      } else {
        await createMutation.mutateAsync(values);
      }
    } catch (err) {
      throw new Error(getApiErrorMessage(err));
    }
  }

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-muted">{description}</p>
        {canAdicionar && (
          <button
            onClick={() => setModalTarget("new")}
            className="focus-ring flex shrink-0 items-center gap-1.5 rounded-card bg-primary px-4 py-2 text-sm font-semibold text-primary-fg hover:opacity-90"
          >
            <Plus className="h-4 w-4" /> Nova mensagem
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
                  case "text":
                    return (
                      <th key="text" className="px-4 py-3">Texto</th>
                    );
                  case "connections":
                    return (
                      <th key="connections" className="px-4 py-3">Conexões</th>
                    );
                  case "users":
                    return (
                      <th key="users" className="px-4 py-3">Quem pode usar</th>
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
                  {emptyMessage}
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
                        <td key="name" className="px-4 py-3 font-medium">
                          {t.name}
                          <span className="block text-xs font-normal text-muted">{t.showSenderName ? "Com o nome do atendente" : "Sem o nome do atendente"}</span>
                        </td>
                      );
                    case "text":
                      return (
                        <td key="text" className="max-w-sm truncate px-4 py-3 text-muted" title={t.text}>
                          {t.text}
                        </td>
                      );
                    case "connections":
                      return (
                        <td key="connections" className="max-w-[14rem] truncate px-4 py-3 text-muted" title={describeConnectionScope(t.connectionScope)}>
                          {describeConnectionScope(t.connectionScope)}
                        </td>
                      );
                    case "users":
                      return (
                        <td key="users" className="max-w-[14rem] truncate px-4 py-3 text-muted" title={describeUserScope(t.userScope)}>
                          {describeUserScope(t.userScope)}
                        </td>
                      );
                    case "status":
                      return (
                        <td key="status" className="px-4 py-3">
                          <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${t.active ? "bg-green-100 text-green-700" : "bg-gray-100 text-gray-600"}`}>
                            {t.active ? "Ativo" : "Inativo"}
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
                      <button onClick={() => setModalTarget(t)} className="focus-ring rounded-card p-1.5 text-muted hover:bg-surface-alt" aria-label="Editar" title="Editar">
                        <Pencil className="h-4 w-4" />
                      </button>
                    )}
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

      {modalTarget && (
        <AutoMessageFormModal
          trigger={trigger}
          template={modalTarget === "new" ? null : modalTarget}
          onClose={() => setModalTarget(null)}
          onSubmit={handleSubmit}
        />
      )}

      {deleteTarget && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-4">
          <div className="w-full max-w-sm rounded-card border border-border bg-surface p-5 shadow-elevated">
            <h2 className="text-base font-semibold">Excluir mensagem automática?</h2>
            <p className="mt-2 text-sm text-muted">"{deleteTarget.name}" será removida permanentemente.</p>
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
