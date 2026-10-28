import { useQuery } from "@tanstack/react-query";
import { api } from "../../lib/api";

interface IbgeState {
  id: number;
  sigla: string;
  nome: string;
}
interface IbgeCity {
  id: number;
  nome: string;
}

/**
 * Estado → Cidade cascading picker backed by the IBGE locations proxy (see
 * holidays.routes.ts) — see PROMPT: "lista pronta que aparece após
 * selecionar o estado". Shared by the Usuários form (cidade onde trabalha)
 * and the Feriados screen (estado/cidade of a STATE/MUNICIPAL entry).
 */
export function StateCitySelect({
  state,
  city,
  onChange,
  disabled,
}: {
  state: string | null;
  city: string | null;
  onChange: (next: { state: string | null; city: string | null }) => void;
  disabled?: boolean;
}) {
  const { data: states } = useQuery({
    queryKey: ["ibge-states"],
    queryFn: async () => (await api.get<IbgeState[]>("/holidays/locations/states")).data,
    staleTime: 60 * 60 * 1000,
  });

  const { data: cities, isFetching: loadingCities } = useQuery({
    queryKey: ["ibge-cities", state],
    queryFn: async () => (await api.get<IbgeCity[]>(`/holidays/locations/states/${state}/cities`)).data,
    enabled: Boolean(state),
    staleTime: 60 * 60 * 1000,
  });

  return (
    <div className="grid grid-cols-2 gap-2">
      <select
        value={state ?? ""}
        disabled={disabled}
        onChange={(e) => onChange({ state: e.target.value || null, city: null })}
        className="focus-ring w-full rounded-card border border-border bg-transparent px-3 py-2 text-sm disabled:opacity-60"
      >
        <option value="">Estado...</option>
        {states?.map((s) => (
          <option key={s.sigla} value={s.sigla}>
            {s.nome}
          </option>
        ))}
      </select>
      <select
        value={city ?? ""}
        disabled={disabled || !state}
        onChange={(e) => onChange({ state, city: e.target.value || null })}
        className="focus-ring w-full rounded-card border border-border bg-transparent px-3 py-2 text-sm disabled:opacity-60"
      >
        <option value="">{!state ? "Selecione o estado" : loadingCities ? "Carregando..." : "Cidade..."}</option>
        {cities?.map((c) => (
          <option key={c.id} value={c.nome}>
            {c.nome}
          </option>
        ))}
      </select>
    </div>
  );
}
