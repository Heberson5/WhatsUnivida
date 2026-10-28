import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Copy, Eye, Pencil, Plus, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { PERMISSION, type SatisfactionSurveyDTO } from "@whatsatendende/types";
import { api, getApiErrorMessage } from "../../lib/api";
import { useAuthStore } from "../../store/auth-store";
import { describeConnectionScope } from "./ConnectionScopePicker";
import { PesquisaFormModal, toPesquisaFormValues, type PesquisaFormValues } from "./PesquisaFormModal";
import { SatisfactionSettingsCard } from "./SatisfactionSettingsCard";
import { ColumnViewMenu } from "../../components/common/ColumnViewMenu";
import { useColumnView } from "../../hooks/useColumnView";

const QUERY_KEY = ["satisfaction-surveys"];

type FormTarget = { mode: "new" } | { mode: "copy"; survey: SatisfactionSurveyDTO } | { mode: "edit"; survey: SatisfactionSurveyDTO };

function describeScope(survey: SatisfactionSurveyDTO): string {
  const { allConnections, connections } = survey.connectionScope;
  return allConnections || connections.length > 0 ? describeConnectionScope(survey.connectionScope) : "Nenhuma conexão";
}

/**
 * Pesquisas de satisfação (NPS, nota de 0 a 10) sent when a conversation is closed — a list: the ones that ship are
 * templates, all off. See PROMPT: "Cadastre ao menos 4 pesquisas desligadas, para servir de modelo".
 */
export function PesquisaTab() {
  const columnView = useColumnView("respostasPesquisa");
  const queryClient = useQueryClient();
  const permissions = useAuthStore((s) => s.permissions);
  const canAdicionar = permissions?.[PERMISSION.RESPOSTAS_PESQUISA_ADICIONAR];
  const canEditar = permissions?.[PERMISSION.RESPOSTAS_PESQUISA_EDITAR];
  const canExcluir = permissions?.[PERMISSION.RESPOSTAS_PESQUISA_EXCLUIR];
  const [formTarget, setFormTarget] = useState<FormTarget | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<SatisfactionSurveyDTO | null>(null);

  const { data: surveys, isLoading } = useQuery({
    queryKey: QUERY_KEY,
    queryFn: async () => (await api.get<SatisfactionSurveyDTO[]>("/satisfaction-survey/surveys")).data,
  });

  const save = useMutation({
    mutationFn: async ({ id, values }: { id: string | null; values: PesquisaFormValues }) =>
      (id ? await api.patch<SatisfactionSurveyDTO>(`/satisfaction-survey/surveys/${id}`, values) : await api.post<SatisfactionSurveyDTO>("/satisfaction-survey/surveys", values)).data,
    onSuccess: (saved, { id }) => {
      queryClient.invalidateQueries({ queryKey: QUERY_KEY });
      toast.success(`${id ? "Pesquisa salva" : "Pesquisa criada"}${saved.active ? " e ligada." : " (desligada)."}`);
    },
  });

  const remove = useMutation({
    mutationFn: (id: string) => api.delete(`/satisfaction-survey/surveys/${id}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: QUERY_KEY });
      toast.success("Pesquisa excluída.");
      setDeleteTarget(null);
    },
    onError: (err) => toast.error(getApiErrorMessage(err)),
  });

  async function handleSubmit(values: PesquisaFormValues) {
    try {
      await save.mutateAsync({ id: formTarget?.mode === "edit" ? formTarget.survey.id : null, values });
    } catch (err) {
      throw new Error(getApiErrorMessage(err));
    }
  }

  const activeCount = surveys?.filter((s) => s.active).length ?? 0;

  return (
    // On a phone the explanation and the settings card alone fill the screen: the whole tab scrolls there (the table
    // used to get no height, and nothing could be reached). From md up the table keeps scrolling on its own.
    <div className="flex h-full flex-col overflow-y-auto md:overflow-hidden">
      <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <div className="max-w-3xl space-y-2 text-sm text-muted">
          <p>
            Ao encerrar uma conversa atendida, o cliente recebe a pergunta da pesquisa e responde com uma nota de 0 a 10. A nota alimenta o NPS, de 0
            a 100, no Dashboard, em Relatórios › Pesquisa de satisfação e na apresentação. Na API Oficial, só é enviada se o cliente escreveu nas
            últimas 24 horas.
          </p>
          <p>
            Só as pesquisas <strong className="text-text">ligadas</strong> são enviadas — uma por conversa: a escolhida para a conexão; se não houver, a
            de todas as conexões. Os modelos vêm desligados: use <strong className="text-text">Duplicar</strong> ou{" "}
            <strong className="text-text">Editar</strong>, escolha as conexões e ligue. A mensagem de encerramento do atendente espera a nota (ou o
            tempo definido na pesquisa) e, se o atendente desfizer o encerramento, nada é enviado.
          </p>
        </div>
        {canAdicionar && (
          <button
            onClick={() => setFormTarget({ mode: "new" })}
            className="focus-ring flex shrink-0 items-center gap-1.5 rounded-card bg-primary px-4 py-2 text-sm font-semibold text-primary-fg hover:opacity-90"
          >
            <Plus className="h-4 w-4" /> Nova pesquisa
          </button>
        )}
      </div>

      <SatisfactionSettingsCard canEdit={Boolean(canEditar)} />

      {surveys && (
        <p className="mb-2 text-xs font-medium text-muted" role="status">
          {activeCount === 0 ? "Nenhuma pesquisa ligada — nada é enviado aos clientes." : `${activeCount} ${activeCount === 1 ? "pesquisa ligada" : "pesquisas ligadas"}.`}
        </p>
      )}

      <div className="shadow-soft shrink-0 overflow-x-auto rounded-card border border-border bg-surface md:min-h-0 md:flex-1 md:overflow-auto">
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
                  case "question":
                    return (
                      <th key="question" className="px-4 py-3">Pergunta</th>
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
            {!isLoading && surveys?.length === 0 && (
              <tr>
                <td colSpan={columnView.visibleKeys.length + 2} className="px-4 py-8 text-center text-muted">
                  Nenhuma pesquisa cadastrada.
                </td>
              </tr>
            )}
            {surveys?.map((s) => (
              <tr key={s.id} className="border-t border-border hover:bg-surface-alt">
                <td className="w-0 p-0" />
                {columnView.visibleKeys.map((key) => {
                  switch (key) {
                    case "name":
                      return (
                        <td key="name" className="px-4 py-3 font-medium">{s.name}</td>
                      );
                    case "question":
                      return (
                        <td key="question" className="max-w-sm truncate px-4 py-3 text-muted" title={s.question}>
                          {s.question}
                        </td>
                      );
                    case "connections":
                      return (
                        <td key="connections" className="max-w-[14rem] truncate px-4 py-3 text-muted" title={describeScope(s)}>
                          {describeScope(s)}
                        </td>
                      );
                    case "status":
                      return (
                        <td key="status" className="px-4 py-3">
                          <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${s.active ? "bg-green-100 text-green-700" : "bg-gray-100 text-gray-600"}`}>
                            {s.active ? "Ligada" : "Desligada"}
                          </span>
                        </td>
                      );
                    default:
                      return null;
                  }
                })}
                <td className="px-4 py-3">
                  <div className="flex justify-end gap-1">
                    {canAdicionar && (
                      <button
                        onClick={() => setFormTarget({ mode: "copy", survey: s })}
                        className="focus-ring rounded-card p-1.5 text-muted hover:bg-surface-alt"
                        aria-label={`Duplicar ${s.name}`}
                        title="Duplicar — nova pesquisa a partir desta"
                      >
                        <Copy className="h-4 w-4" />
                      </button>
                    )}
                    <button
                      onClick={() => setFormTarget({ mode: "edit", survey: s })}
                      className="focus-ring rounded-card p-1.5 text-muted hover:bg-surface-alt"
                      aria-label={`${canEditar ? "Editar" : "Ver"} ${s.name}`}
                      title={canEditar ? "Editar" : "Ver"}
                    >
                      {canEditar ? <Pencil className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                    </button>
                    {canExcluir && (
                      <button
                        onClick={() => setDeleteTarget(s)}
                        className="focus-ring rounded-card p-1.5 text-muted hover:bg-danger-soft hover:text-danger"
                        aria-label={`Excluir ${s.name}`}
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

      {formTarget && (
        <PesquisaFormModal
          title={formTarget.mode === "new" ? "Nova pesquisa" : formTarget.mode === "copy" ? "Nova pesquisa (cópia)" : canEditar ? "Editar pesquisa" : "Pesquisa"}
          initial={toPesquisaFormValues(formTarget.mode === "new" ? null : formTarget.survey, formTarget.mode === "copy")}
          savedQuestion={formTarget.mode === "edit" ? formTarget.survey.question : null}
          readOnly={formTarget.mode === "edit" && !canEditar}
          onClose={() => setFormTarget(null)}
          onSubmit={handleSubmit}
        />
      )}

      {deleteTarget && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-4">
          <div className="w-full max-w-sm rounded-card border border-border bg-surface p-5 shadow-elevated" role="dialog" aria-label="Excluir pesquisa">
            <h2 className="text-base font-semibold">Excluir pesquisa?</h2>
            <p className="mt-2 text-sm text-muted">
              "{deleteTarget.name}" será removida. As notas já recebidas continuam no Dashboard.
              {deleteTarget.active && " Ela está ligada: os clientes deixam de recebê-la."}
            </p>
            <div className="mt-5 flex gap-2">
              <button onClick={() => setDeleteTarget(null)} className="focus-ring flex-1 rounded-card border border-border py-2 text-sm">
                Cancelar
              </button>
              <button
                onClick={() => remove.mutate(deleteTarget.id)}
                disabled={remove.isPending}
                className="focus-ring flex-1 rounded-card bg-red-600 py-2 text-sm font-semibold text-white disabled:opacity-60"
              >
                {remove.isPending ? "Excluindo..." : "Excluir"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
