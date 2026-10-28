import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { RefreshCw, Trash2 } from "lucide-react";
import type { HolidayDTO, HolidayScope } from "@whatsunivida/types";
import { api, getApiErrorMessage } from "../../lib/api";
import { StateCitySelect } from "../../components/common/StateCitySelect";

const SCOPE_LABEL: Record<HolidayScope, string> = { NATIONAL: "Nacional", STATE: "Estadual", MUNICIPAL: "Municipal" };

interface NewHoliday {
  date: string;
  name: string;
  scope: HolidayScope;
  state: string | null;
  city: string | null;
}

const EMPTY_NEW_HOLIDAY: NewHoliday = { date: "", name: "", scope: "NATIONAL", state: null, city: null };

export function FeriadosPanel() {
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState<NewHoliday>(EMPTY_NEW_HOLIDAY);

  const { data: holidays, isLoading } = useQuery({
    queryKey: ["holidays"],
    queryFn: async () => (await api.get<HolidayDTO[]>("/holidays")).data,
  });

  const createMutation = useMutation({
    mutationFn: (input: NewHoliday) => api.post("/holidays", input),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["holidays"] });
      setDraft(EMPTY_NEW_HOLIDAY);
      toast.success("Feriado cadastrado.");
    },
    onError: (err) => toast.error(getApiErrorMessage(err)),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => api.delete(`/holidays/${id}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["holidays"] });
      toast.success("Feriado removido.");
    },
    onError: (err) => toast.error(getApiErrorMessage(err)),
  });

  const syncMutation = useMutation({
    mutationFn: () => api.post<{ national: { imported: number; skipped: boolean } }>("/holidays/sync"),
    onSuccess: (res) => {
      queryClient.invalidateQueries({ queryKey: ["holidays"] });
      const { national } = res.data;
      toast.success(
        national.skipped
          ? "Feriados nacionais já sincronizados este ano."
          : `${national.imported} feriados nacionais importados.`
      );
    },
    onError: (err) => toast.error(getApiErrorMessage(err)),
  });

  function handleCreate() {
    if (!draft.date || !draft.name.trim()) {
      toast.error("Informe a data e o nome do feriado");
      return;
    }
    createMutation.mutate(draft);
  }

  const sorted = [...(holidays ?? [])].sort((a, b) => a.date.localeCompare(b.date));

  return (
    <div className="shadow-soft max-w-3xl space-y-6 rounded-card border border-border bg-surface p-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-base font-semibold">Feriados</h2>
          <p className="mt-1 text-sm text-muted">
            Controla o bloqueio automático de acesso em feriados — nacionais valem para todos; estaduais/municipais valem só para
            quem tem a cidade correspondente no cadastro (Usuários).
          </p>
        </div>
        <button
          onClick={() => syncMutation.mutate()}
          disabled={syncMutation.isPending}
          className="focus-ring flex shrink-0 items-center gap-1.5 rounded-card border border-border px-3 py-1.5 text-xs font-medium hover:bg-surface-alt disabled:opacity-60"
        >
          <RefreshCw className={`h-3.5 w-3.5 ${syncMutation.isPending ? "animate-spin" : ""}`} />
          Sincronizar feriados nacionais
        </button>
      </div>

      <p className="text-xs text-muted">
        A sincronização automática busca somente os feriados nacionais do ano (via BrasilAPI), uma vez por ano. Feriados
        estaduais e municipais são sempre cadastrados manualmente abaixo, sem risco de serem apagados ou duplicados pela
        sincronização.
      </p>

      <div className="rounded-card border border-border p-3">
        <p className="mb-2 text-sm font-medium">Cadastrar feriado manualmente</p>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          <input
            type="date"
            value={draft.date}
            onChange={(e) => setDraft((d) => ({ ...d, date: e.target.value }))}
            className="focus-ring rounded-card border border-border bg-transparent px-3 py-2 text-sm"
          />
          <input
            value={draft.name}
            onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))}
            placeholder="Nome do feriado"
            className="focus-ring col-span-2 rounded-card border border-border bg-transparent px-3 py-2 text-sm sm:col-span-1"
          />
          <select
            value={draft.scope}
            onChange={(e) => setDraft((d) => ({ ...d, scope: e.target.value as HolidayScope, state: null, city: null }))}
            className="focus-ring rounded-card border border-border bg-transparent px-3 py-2 text-sm"
          >
            <option value="NATIONAL">Nacional</option>
            <option value="STATE">Estadual</option>
            <option value="MUNICIPAL">Municipal</option>
          </select>
        </div>
        {draft.scope !== "NATIONAL" && (
          <div className="mt-2">
            <StateCitySelect
              state={draft.state}
              city={draft.scope === "MUNICIPAL" ? draft.city : null}
              onChange={({ state, city }) => setDraft((d) => ({ ...d, state, city: d.scope === "MUNICIPAL" ? city : null }))}
            />
          </div>
        )}
        <button
          onClick={handleCreate}
          disabled={createMutation.isPending}
          className="focus-ring mt-3 rounded-card bg-primary px-4 py-2 text-sm font-semibold text-primary-fg disabled:opacity-60"
        >
          {createMutation.isPending ? "Salvando..." : "Adicionar feriado"}
        </button>
      </div>

      <div className="overflow-x-auto rounded-card border border-border">
        <table className="w-full text-sm">
          <thead className="bg-surface-alt text-left text-xs uppercase tracking-wide text-muted">
            <tr>
              <th className="px-3 py-2">Data</th>
              <th className="px-3 py-2">Nome</th>
              <th className="px-3 py-2">Abrangência</th>
              <th className="px-3 py-2">Origem</th>
              <th className="px-3 py-2" />
            </tr>
          </thead>
          <tbody>
            {isLoading && (
              <tr>
                <td colSpan={5} className="px-3 py-6 text-center text-muted">
                  Carregando...
                </td>
              </tr>
            )}
            {!isLoading && sorted.length === 0 && (
              <tr>
                <td colSpan={5} className="px-3 py-6 text-center text-muted">
                  Nenhum feriado cadastrado ainda.
                </td>
              </tr>
            )}
            {sorted.map((h) => (
              <tr key={h.id} className="border-t border-border">
                <td className="px-3 py-2 whitespace-nowrap">{new Date(`${h.date}T00:00:00`).toLocaleDateString("pt-BR")}</td>
                <td className="px-3 py-2">{h.name}</td>
                <td className="px-3 py-2 text-muted">
                  {SCOPE_LABEL[h.scope]}
                  {h.scope !== "NATIONAL" && h.state ? ` — ${h.city ? `${h.city}/` : ""}${h.state}` : ""}
                </td>
                <td className="px-3 py-2">
                  <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${h.source === "AUTO" ? "bg-primary/10 text-primary" : "bg-secondary/40 text-secondary-fg"}`}>
                    {h.source === "AUTO" ? "Automático" : "Manual"}
                  </span>
                </td>
                <td className="px-3 py-2 text-right">
                  <button
                    onClick={() => deleteMutation.mutate(h.id)}
                    className="focus-ring rounded-full p-1.5 text-muted hover:bg-surface-alt hover:text-red-600"
                    aria-label={`Remover ${h.name}`}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
