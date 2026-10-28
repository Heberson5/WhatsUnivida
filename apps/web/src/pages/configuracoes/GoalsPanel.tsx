import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Pencil, Plus, Trash2 } from "lucide-react";
import clsx from "clsx";
import { GOAL_TYPE_LABEL, PERMISSION, type GoalDTO, type GoalScope, type GoalType } from "@whatsatendende/types";
import { api, getApiErrorMessage } from "../../lib/api";
import { useAuthStore } from "../../store/auth-store";

interface Option {
  id: string;
  name: string;
}

const SCOPE_LABEL: Record<GoalScope, string> = { ALL: "Todos", CONNECTIONS: "Conexões", AGENTS: "Atendentes" };
const EMPTY_GOAL: Omit<GoalDTO, "id"> = { type: "CLOSED_PER_DAY", target: 10, active: true, scope: "ALL", connectionIds: [], agentIds: [] };

function targetLabel(type: GoalType, target: number) {
  if (type === "AVG_FIRST_RESPONSE") return `até ${target} min`;
  if (type === "NPS") return `NPS ${target} ou mais`;
  return `${target} por dia`;
}

/** Metas: one rule per type and scope; on "Meu dia" the most specific active rule wins (atendente > conexão > todos). */
export function GoalsPanel() {
  const queryClient = useQueryClient();
  const canEdit = useAuthStore((s) => Boolean(s.permissions?.[PERMISSION.CONFIGURACOES_FILA_EDITAR]));
  const { data: goals } = useQuery({ queryKey: ["goals"], queryFn: async () => (await api.get<GoalDTO[]>("/goals")).data });
  const { data: connections } = useQuery({
    queryKey: ["goal-connections"],
    queryFn: async () => (await api.get<Option[]>("/whatsapp/connections")).data,
  });
  const { data: agents } = useQuery({
    queryKey: ["goal-agents"],
    queryFn: async () => (await api.get<{ id: string; displayName: string }[]>("/agents/attendants")).data.map((a) => ({ id: a.id, name: a.displayName })),
  });
  const [editing, setEditing] = useState<(Omit<GoalDTO, "id"> & { id?: string }) | null>(null);

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ["goals"] });
    queryClient.invalidateQueries({ queryKey: ["my-day"] });
  };
  const saveMutation = useMutation({
    mutationFn: async (goal: Omit<GoalDTO, "id"> & { id?: string }) => {
      const { id, ...body } = goal;
      return id ? api.put(`/goals/${id}`, body) : api.post("/goals", body);
    },
    onSuccess: () => {
      invalidate();
      setEditing(null);
      toast.success("Meta salva.");
    },
    onError: (err) => toast.error(getApiErrorMessage(err)),
  });
  const toggleMutation = useMutation({
    mutationFn: ({ id, ...goal }: GoalDTO) => api.put(`/goals/${id}`, { ...goal, active: !goal.active }),
    onSuccess: invalidate,
    onError: (err) => toast.error(getApiErrorMessage(err)),
  });
  const deleteMutation = useMutation({
    mutationFn: (id: string) => api.delete(`/goals/${id}`),
    onSuccess: invalidate,
    onError: (err) => toast.error(getApiErrorMessage(err)),
  });

  function scopeNames(goal: GoalDTO) {
    if (goal.scope === "CONNECTIONS") return goal.connectionIds.map((id) => connections?.find((c) => c.id === id)?.name ?? "?").join(", ");
    if (goal.scope === "AGENTS") return goal.agentIds.map((id) => agents?.find((a) => a.id === id)?.name ?? "?").join(", ");
    return "Todos";
  }

  return (
    <div className="border-t border-border pt-5">
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-base font-semibold">Metas</h2>
        {canEdit && !editing && (
          <button onClick={() => setEditing({ ...EMPTY_GOAL })} className="focus-ring inline-flex items-center gap-1 rounded-card px-2 py-1 text-sm font-medium text-primary hover:bg-surface-alt">
            <Plus className="h-4 w-4" /> Nova meta
          </button>
        )}
      </div>
      <p className="mt-1 text-sm text-muted">
        Aparecem como progresso no &quot;Meu dia&quot;, em Atendimento. Se mais de uma meta do mesmo tipo valer para alguém, a mais específica ganha: atendente, depois conexão,
        depois todos.
      </p>

      <div className="mt-3 space-y-2">
        {goals?.length === 0 && !editing && <p className="text-sm text-muted">Nenhuma meta cadastrada.</p>}
        {goals?.map((goal) => (
          <div key={goal.id} className={clsx("flex items-center gap-3 rounded-card border border-border px-3 py-2 text-sm", !goal.active && "opacity-60")}>
            <label className="flex items-center" title={goal.active ? "Desativar" : "Ativar"}>
              <input type="checkbox" checked={goal.active} disabled={!canEdit} onChange={() => toggleMutation.mutate(goal)} className="h-4 w-4 accent-[var(--color-primary)]" />
            </label>
            <div className="min-w-0 flex-1">
              <p className="font-medium">
                {GOAL_TYPE_LABEL[goal.type]} · {targetLabel(goal.type, goal.target)}
              </p>
              <p className="truncate text-xs text-muted">
                {SCOPE_LABEL[goal.scope]}
                {goal.scope !== "ALL" && `: ${scopeNames(goal)}`}
              </p>
            </div>
            {canEdit && (
              <>
                <button onClick={() => setEditing(goal)} className="focus-ring rounded-full p-1 text-muted hover:bg-surface-alt" aria-label="Editar meta">
                  <Pencil className="h-4 w-4" />
                </button>
                <button onClick={() => deleteMutation.mutate(goal.id)} className="focus-ring rounded-full p-1 text-muted hover:bg-surface-alt hover:text-danger" aria-label="Excluir meta">
                  <Trash2 className="h-4 w-4" />
                </button>
              </>
            )}
          </div>
        ))}
      </div>

      {editing && (
        <div className="mt-3 space-y-3 rounded-card border border-primary/40 p-3">
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="block">
              <span className="mb-1 block text-sm font-medium">Tipo</span>
              <select
                value={editing.type}
                onChange={(e) => setEditing({ ...editing, type: e.target.value as GoalType })}
                className="focus-ring w-full rounded-card border border-border bg-surface px-3 py-2 text-sm"
              >
                {(Object.keys(GOAL_TYPE_LABEL) as GoalType[]).map((t) => (
                  <option key={t} value={t}>
                    {GOAL_TYPE_LABEL[t]}
                  </option>
                ))}
              </select>
            </label>
            <label className="block">
              <span className="mb-1 block text-sm font-medium">{editing.type === "AVG_FIRST_RESPONSE" ? "No máximo (minutos)" : editing.type === "NPS" ? "NPS mínimo (-100 a 100)" : "Quantidade por dia"}</span>
              <input
                type="number"
                value={editing.target}
                min={editing.type === "NPS" ? -100 : 1}
                max={editing.type === "NPS" ? 100 : 1000}
                onChange={(e) => setEditing({ ...editing, target: Number(e.target.value) })}
                className="focus-ring w-full rounded-card border border-border bg-transparent px-3 py-2 text-sm"
              />
            </label>
          </div>
          <div>
            <span className="mb-1 block text-sm font-medium">Vale para</span>
            <div className="flex gap-2">
              {(Object.keys(SCOPE_LABEL) as GoalScope[]).map((scope) => (
                <button
                  key={scope}
                  type="button"
                  onClick={() => setEditing({ ...editing, scope })}
                  className={clsx("focus-ring rounded-full border px-3 py-1 text-xs font-medium", editing.scope === scope ? "border-primary bg-primary text-primary-fg" : "border-border hover:bg-surface-alt")}
                >
                  {SCOPE_LABEL[scope]}
                </button>
              ))}
            </div>
          </div>
          {editing.scope !== "ALL" && (
            <MultiPick
              options={(editing.scope === "CONNECTIONS" ? connections : agents) ?? []}
              selected={editing.scope === "CONNECTIONS" ? editing.connectionIds : editing.agentIds}
              onChange={(ids) => setEditing(editing.scope === "CONNECTIONS" ? { ...editing, connectionIds: ids } : { ...editing, agentIds: ids })}
            />
          )}
          <div className="flex justify-end gap-2">
            <button onClick={() => setEditing(null)} className="focus-ring rounded-card px-3 py-1.5 text-sm hover:bg-surface-alt">
              Cancelar
            </button>
            <button
              onClick={() =>
                saveMutation.mutate({
                  ...editing,
                  connectionIds: editing.scope === "CONNECTIONS" ? editing.connectionIds : [],
                  agentIds: editing.scope === "AGENTS" ? editing.agentIds : [],
                })
              }
              disabled={saveMutation.isPending}
              className="focus-ring rounded-card bg-primary px-3 py-1.5 text-sm font-semibold text-primary-fg disabled:opacity-60"
            >
              Salvar meta
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function MultiPick({ options, selected, onChange }: { options: Option[]; selected: string[]; onChange: (ids: string[]) => void }) {
  return (
    <div className="flex max-h-40 flex-wrap gap-1.5 overflow-y-auto">
      {options.map((o) => {
        const on = selected.includes(o.id);
        return (
          <button
            key={o.id}
            type="button"
            onClick={() => onChange(on ? selected.filter((id) => id !== o.id) : [...selected, o.id])}
            className={clsx("focus-ring rounded-full border px-2.5 py-0.5 text-xs", on ? "border-primary bg-primary/10 font-semibold text-primary" : "border-border hover:bg-surface-alt")}
          >
            {o.name}
          </button>
        );
      })}
    </div>
  );
}
