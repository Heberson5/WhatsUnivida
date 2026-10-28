import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Pencil, Trash2, X } from "lucide-react";
import { COLUMN_SCREENS, PERMISSION, type ColumnViewColumn, type ColumnViewDTO } from "@whatsatendende/types";
import { api, getApiErrorMessage } from "../../lib/api";
import { useAuthStore } from "../../store/auth-store";
import { ColumnListEditor } from "../../components/common/ColumnListEditor";
import { UserScopePicker, type UserScopeValue } from "../respostas/UserScopePicker";
import { ColumnViewMenu } from "../../components/common/ColumnViewMenu";
import { useColumnView } from "../../hooks/useColumnView";

const ROLE_LABEL = { ADMIN: "Administrador", MANAGER: "Gestor", AGENT: "Atendente" } as const;

function columnLabels(view: ColumnViewDTO) {
  const labels = new Map(COLUMN_SCREENS[view.screen].columns.map((c) => [c.key, c.label]));
  return view.columns.filter((c) => c.visible).map((c) => labels.get(c.key) ?? c.key);
}

function describeAudience(view: ColumnViewDTO) {
  if (view.shareAll) return "Todos";
  if (view.sharedWith.length === 0) return `Só ${view.ownerName}`;
  return [view.ownerName, ...view.sharedWith.map((u) => u.name)].join(", ");
}

/** Configurações › Visões de colunas: every view saved from a table's ⋮ menu — columns, order and who can use it. */
export function VisoesColunasPanel() {
  const columnView = useColumnView("visoesColunas");
  const queryClient = useQueryClient();
  const canEdit = useAuthStore((s) => s.permissions?.[PERMISSION.CONFIGURACOES_VISOES_EDITAR]);
  const [editing, setEditing] = useState<ColumnViewDTO | null>(null);

  const { data: views, isLoading } = useQuery({
    queryKey: ["column-views", "all"],
    queryFn: async () => (await api.get<ColumnViewDTO[]>("/column-views")).data,
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => api.delete(`/column-views/${id}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["column-views"] });
      toast.success("Visão excluída.");
    },
    onError: (err) => toast.error(getApiErrorMessage(err)),
  });

  return (
    <div className="shadow-soft max-w-5xl space-y-4 rounded-card border border-border bg-surface p-6">
      <div>
        <h2 className="text-base font-semibold">Visões de colunas</h2>
        <p className="mt-1 text-sm text-muted">
          Visões salvas pelo botão ⋮ das tabelas. Quem abre uma tela usa a própria visão; sem ela, a visão compartilhada com a pessoa; sem nenhuma, o padrão do
          sistema. A visão de um atendente é só dele.
        </p>
      </div>

      <div className="overflow-x-auto rounded-card border border-border">
        <table className="w-full text-sm">
          <thead className="bg-surface-alt text-left text-xs uppercase tracking-wide text-muted">
            <tr>
              <th className="w-0 py-2 pl-2 pr-0">
                <ColumnViewMenu view={columnView} />
              </th>
              {columnView.visibleKeys.map((key) => {
                switch (key) {
                  case "screen":
                    return (
                      <th key="screen" className="px-3 py-2">Tela</th>
                    );
                  case "name":
                    return (
                      <th key="name" className="px-3 py-2">Nome</th>
                    );
                  case "owner":
                    return (
                      <th key="owner" className="px-3 py-2">Quem salvou</th>
                    );
                  case "date":
                    return (
                      <th key="date" className="px-3 py-2">Dia</th>
                    );
                  case "columns":
                    return (
                      <th key="columns" className="px-3 py-2">Colunas</th>
                    );
                  case "audience":
                    return (
                      <th key="audience" className="px-3 py-2">Quem pode usar</th>
                    );
                  default:
                    return null;
                }
              })}
              <th className="px-3 py-2" />
            </tr>
          </thead>
          <tbody>
            {isLoading && (
              <tr>
                <td colSpan={columnView.visibleKeys.length + 2} className="px-3 py-6 text-center text-muted">
                  Carregando...
                </td>
              </tr>
            )}
            {!isLoading && views?.length === 0 && (
              <tr>
                <td colSpan={columnView.visibleKeys.length + 2} className="px-3 py-6 text-center text-muted">
                  Nenhuma visão salva ainda.
                </td>
              </tr>
            )}
            {views?.map((view) => (
              <tr key={view.id} className="border-t border-border align-top">
                <td className="w-0 p-0" />
                {columnView.visibleKeys.map((key) => {
                  switch (key) {
                    case "screen":
                      return (
                        <td key="screen" className="whitespace-nowrap px-3 py-2 font-medium">{COLUMN_SCREENS[view.screen].label}</td>
                      );
                    case "name":
                      return (
                        <td key="name" className="px-3 py-2">{view.name}</td>
                      );
                    case "owner":
                      return (
                        <td key="owner" className="px-3 py-2">
                          {view.ownerName}
                          <span className="block text-xs text-muted">{ROLE_LABEL[view.ownerRole]}</span>
                        </td>
                      );
                    case "date":
                      return (
                        <td key="date" className="whitespace-nowrap px-3 py-2 text-muted">{new Date(view.updatedAt).toLocaleDateString("pt-BR")}</td>
                      );
                    case "columns":
                      return (
                        <td key="columns" className="max-w-xs px-3 py-2 text-xs text-muted">{columnLabels(view).join(" · ")}</td>
                      );
                    case "audience":
                      return (
                        <td key="audience" className="max-w-[12rem] px-3 py-2 text-xs">{describeAudience(view)}</td>
                      );
                    default:
                      return null;
                  }
                })}
                <td className="whitespace-nowrap px-3 py-2 text-right">
                  {canEdit && (
                    <>
                      <button
                        onClick={() => setEditing(view)}
                        className="focus-ring rounded-full p-1.5 text-muted hover:bg-surface-alt"
                        aria-label={`Editar ${view.name}`}
                        title="Editar"
                      >
                        <Pencil className="h-3.5 w-3.5" />
                      </button>
                      <button
                        onClick={() => deleteMutation.mutate(view.id)}
                        className="focus-ring rounded-full p-1.5 text-muted hover:bg-surface-alt hover:text-red-600"
                        aria-label={`Excluir ${view.name}`}
                        title="Excluir"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    </>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {editing && <ColumnViewFormDrawer view={editing} onClose={() => setEditing(null)} />}
    </div>
  );
}

function ColumnViewFormDrawer({ view, onClose }: { view: ColumnViewDTO; onClose: () => void }) {
  const queryClient = useQueryClient();
  const [name, setName] = useState(view.name);
  const [columns, setColumns] = useState<ColumnViewColumn[]>(view.columns);
  const [audience, setAudience] = useState<UserScopeValue>({ allUsers: view.shareAll, userIds: view.sharedWith.map((u) => u.id) });
  const ownerIsAgent = view.ownerRole === "AGENT";

  const saveMutation = useMutation({
    mutationFn: () =>
      api.patch(`/column-views/${view.id}`, {
        name: name.trim(),
        columns,
        shareAll: ownerIsAgent ? false : audience.allUsers,
        sharedWithIds: ownerIsAgent || audience.allUsers ? [] : audience.userIds,
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["column-views"] });
      toast.success("Visão salva.");
      onClose();
    },
    onError: (err) => toast.error(getApiErrorMessage(err)),
  });

  return (
    <div className="drawer-backdrop">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          saveMutation.mutate();
        }}
        className="drawer-panel max-w-md space-y-4 overflow-y-auto p-5"
      >
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-base font-semibold">Editar visão</h2>
            <p className="text-xs text-muted">
              {COLUMN_SCREENS[view.screen].label} · salva por {view.ownerName}
            </p>
          </div>
          <button type="button" onClick={onClose} className="focus-ring rounded-full p-1 text-muted hover:bg-surface-alt" aria-label="Fechar">
            <X className="h-5 w-5" />
          </button>
        </div>

        <label className="block">
          <span className="mb-1 block text-sm font-medium">Nome</span>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={60}
            required
            className="focus-ring w-full rounded-card border border-border bg-transparent px-3 py-2 text-sm"
          />
        </label>

        <div>
          <p className="mb-1 text-sm font-medium">Colunas e ordem</p>
          <div className="rounded-card border border-border p-1.5">
            <ColumnListEditor screen={view.screen} columns={columns} onChange={setColumns} />
          </div>
        </div>

        {ownerIsAgent ? (
          <p className="rounded-card bg-surface-alt px-3 py-2 text-xs text-muted">Visão de atendente: só {view.ownerName} usa, não pode ser compartilhada.</p>
        ) : (
          <UserScopePicker value={audience} onChange={setAudience} hint={`Sem ninguém marcado, só ${view.ownerName} usa esta visão.`} />
        )}

        <div className="flex justify-end gap-2 pt-2">
          <button type="button" onClick={onClose} className="focus-ring rounded-card border border-border px-4 py-2 text-sm font-medium hover:bg-surface-alt">
            Cancelar
          </button>
          <button
            type="submit"
            disabled={saveMutation.isPending || !name.trim() || !columns.some((c) => c.visible)}
            className="focus-ring rounded-card bg-primary px-4 py-2 text-sm font-semibold text-primary-fg disabled:opacity-60"
          >
            {saveMutation.isPending ? "Salvando..." : "Salvar"}
          </button>
        </div>
      </form>
    </div>
  );
}
