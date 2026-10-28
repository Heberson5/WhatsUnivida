import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Pencil, Plus, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { PERMISSION, WEEKDAY_KEYS, type WeekdayKey, type WorkScheduleDTO } from "@whatsatendende/types";
import { useAuthStore } from "../../store/auth-store";
import { api, getApiErrorMessage } from "../../lib/api";
import { ExpedienteFormModal, type ExpedienteFormValues } from "./ExpedienteFormModal";
import { ColumnViewMenu } from "../../components/common/ColumnViewMenu";
import { useColumnView } from "../../hooks/useColumnView";

const WEEKDAY_SHORT: Record<WeekdayKey, string> = { MON: "Seg", TUE: "Ter", WED: "Qua", THU: "Qui", FRI: "Sex", SAT: "Sáb", SUN: "Dom" };

/** "Seg a Sex 08:00–18:00" style summary; days with the same window are grouped. */
function describeDays(days: WorkScheduleDTO["days"]): string {
  const groups = new Map<string, WeekdayKey[]>();
  for (const key of WEEKDAY_KEYS) {
    const window = days[key];
    if (!window) continue;
    const label = window.allDay ? "24h" : `${window.start}–${window.end}`;
    groups.set(label, [...(groups.get(label) ?? []), key]);
  }
  return [...groups.entries()].map(([label, keys]) => `${keys.map((k) => WEEKDAY_SHORT[k]).join(", ")} ${label}`).join(" · ");
}

/** Respostas › Horário de expediente — each connection picks (in Conexões) the one it follows. */
export function ExpedienteTab() {
  const columnView = useColumnView("respostasExpediente");
  const queryClient = useQueryClient();
  const permissions = useAuthStore((s) => s.permissions);
  const canAdicionar = permissions?.[PERMISSION.RESPOSTAS_EXPEDIENTE_ADICIONAR];
  const canEditar = permissions?.[PERMISSION.RESPOSTAS_EXPEDIENTE_EDITAR];
  const canExcluir = permissions?.[PERMISSION.RESPOSTAS_EXPEDIENTE_EXCLUIR];
  const [modalTarget, setModalTarget] = useState<WorkScheduleDTO | null | "new">(null);
  const [deleteTarget, setDeleteTarget] = useState<WorkScheduleDTO | null>(null);

  const { data: schedules, isLoading } = useQuery({
    queryKey: ["work-schedules"],
    queryFn: async () => (await api.get<WorkScheduleDTO[]>("/work-schedules")).data,
  });

  function refresh() {
    queryClient.invalidateQueries({ queryKey: ["work-schedules"] });
    queryClient.invalidateQueries({ queryKey: ["work-schedule-options"] });
  }

  const saveMutation = useMutation({
    mutationFn: ({ id, values }: { id: string | null; values: ExpedienteFormValues }) => (id ? api.patch(`/work-schedules/${id}`, values) : api.post("/work-schedules", values)),
    onSuccess: () => {
      refresh();
      toast.success("Horário de expediente salvo.");
    },
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => api.delete(`/work-schedules/${id}`),
    onSuccess: () => {
      refresh();
      toast.success("Horário de expediente excluído.");
      setDeleteTarget(null);
    },
    onError: (err) => toast.error(getApiErrorMessage(err)),
  });

  async function handleSubmit(values: ExpedienteFormValues) {
    try {
      await saveMutation.mutateAsync({ id: modalTarget && modalTarget !== "new" ? modalTarget.id : null, values });
    } catch (err) {
      throw new Error(getApiErrorMessage(err));
    }
  }

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-muted">
          Cadastre os dias e horários de atendimento. Cada conexão escolhe, em Conexões, o horário que segue: fora dele, o cliente recebe a mensagem de fora do
          expediente. Conexão sem horário atende 24 horas.
        </p>
        {canAdicionar && (
          <button
            onClick={() => setModalTarget("new")}
            className="focus-ring flex shrink-0 items-center gap-1.5 rounded-card bg-primary px-4 py-2 text-sm font-semibold text-primary-fg hover:opacity-90"
          >
            <Plus className="h-4 w-4" /> Novo horário
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
                  case "city":
                    return (
                      <th key="city" className="px-4 py-3">Cidade</th>
                    );
                  case "schedule":
                    return (
                      <th key="schedule" className="px-4 py-3">Dias e horários</th>
                    );
                  case "connections":
                    return (
                      <th key="connections" className="px-4 py-3">Conexões</th>
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
            {!isLoading && schedules?.length === 0 && (
              <tr>
                <td colSpan={columnView.visibleKeys.length + 2} className="px-4 py-8 text-center text-muted">
                  Nenhum horário cadastrado — todas as conexões atendem 24 horas.
                </td>
              </tr>
            )}
            {schedules?.map((s) => (
              <tr key={s.id} className="border-t border-border hover:bg-surface-alt">
                <td className="w-0 p-0" />
                {columnView.visibleKeys.map((key) => {
                  switch (key) {
                    case "name":
                      return (
                        <td key="name" className="px-4 py-3 font-medium">{s.name}</td>
                      );
                    case "city":
                      return (
                        <td key="city" className="whitespace-nowrap px-4 py-3 text-muted">
                          {s.city}/{s.state}
                        </td>
                      );
                    case "schedule":
                      return (
                        <td key="schedule" className="max-w-sm px-4 py-3 text-muted">
                          {describeDays(s.days)}
                          {s.partialHolidays.length > 0 && <span className="block text-xs">{s.partialHolidays.length} feriado(s) parcial(is)</span>}
                        </td>
                      );
                    case "connections":
                      return (
                        <td key="connections" className="max-w-[14rem] truncate px-4 py-3 text-muted" title={s.connections.map((c) => c.name).join(", ")}>
                          {s.connections.length > 0 ? s.connections.map((c) => c.name).join(", ") : "Nenhuma"}
                        </td>
                      );
                    default:
                      return null;
                  }
                })}
                <td className="px-4 py-3">
                  <div className="flex justify-end gap-1">
                    {canEditar && (
                      <button onClick={() => setModalTarget(s)} className="focus-ring rounded-card p-1.5 text-muted hover:bg-surface-alt" aria-label="Editar" title="Editar">
                        <Pencil className="h-4 w-4" />
                      </button>
                    )}
                    {canExcluir && (
                      <button
                        onClick={() => setDeleteTarget(s)}
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

      {modalTarget && <ExpedienteFormModal schedule={modalTarget === "new" ? null : modalTarget} onClose={() => setModalTarget(null)} onSubmit={handleSubmit} />}

      {deleteTarget && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-4">
          <div className="w-full max-w-sm rounded-card border border-border bg-surface p-5 shadow-elevated">
            <h2 className="text-base font-semibold">Excluir horário de expediente?</h2>
            <p className="mt-2 text-sm text-muted">
              "{deleteTarget.name}" será removido. {deleteTarget.connections.length > 0 && "Ele está em uso: escolha outro horário nas conexões antes de excluir."}
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
