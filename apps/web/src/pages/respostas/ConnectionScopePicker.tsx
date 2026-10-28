import { useQuery } from "@tanstack/react-query";
import clsx from "clsx";
import type { ConnectionScopeDTO } from "@whatsatendende/types";
import { api } from "../../lib/api";

export interface ConnectionScopeValue {
  allConnections: boolean;
  connectionIds: string[];
}

interface ConnectionOption {
  id: string;
  name: string;
  connectionMode: "QRCODE" | "OFFICIAL_API";
}

export function toConnectionScopeValue(scope: ConnectionScopeDTO | undefined, fallbackAll: boolean): ConnectionScopeValue {
  if (!scope) return { allConnections: fallbackAll, connectionIds: [] };
  return { allConnections: scope.allConnections, connectionIds: scope.connections.map((c) => c.id) };
}

export function describeConnectionScope(scope: ConnectionScopeDTO): string {
  return scope.allConnections ? "Todas as conexões" : scope.connections.map((c) => c.name).join(", ");
}

/** "Todas as conexões" or a checklist of WhatsApp connections — shared by respostas rápidas, Transferência/Aceite and Encerramento. */
export function ConnectionScopePicker({ value, onChange, hint }: { value: ConnectionScopeValue; onChange: (value: ConnectionScopeValue) => void; hint: string }) {
  const { data: connections } = useQuery({
    queryKey: ["whatsapp-connections"],
    queryFn: async () => (await api.get<ConnectionOption[]>("/whatsapp/connections")).data,
  });

  function toggle(id: string) {
    const connectionIds = value.connectionIds.includes(id) ? value.connectionIds.filter((c) => c !== id) : [...value.connectionIds, id];
    onChange({ allConnections: false, connectionIds });
  }

  return (
    <fieldset>
      <legend className="mb-1 block text-sm font-medium">Conexões</legend>
      <div className="flex rounded-card border border-border p-0.5" role="radiogroup" aria-label="Onde vale">
        {[
          { all: true, label: "Todas as conexões" },
          { all: false, label: "Escolher conexões" },
        ].map((option) => (
          <button
            key={option.label}
            type="button"
            role="radio"
            aria-checked={value.allConnections === option.all}
            onClick={() => onChange({ ...value, allConnections: option.all })}
            className={clsx(
              "focus-ring flex-1 rounded-[10px] px-2 py-1.5 text-xs font-semibold",
              value.allConnections === option.all ? "bg-primary text-primary-fg" : "text-muted hover:bg-surface-alt"
            )}
          >
            {option.label}
          </button>
        ))}
      </div>
      {!value.allConnections && (
        <div className="mt-2 max-h-44 space-y-1 overflow-y-auto rounded-card border border-border p-1.5">
          {connections?.length === 0 && <p className="px-2 py-1.5 text-xs text-muted">Nenhuma conexão cadastrada — crie uma em Conexões primeiro.</p>}
          {connections?.map((c) => (
            <label key={c.id} className="flex cursor-pointer items-center gap-2 rounded-lg px-2 py-1.5 text-sm hover:bg-surface-alt">
              <input type="checkbox" checked={value.connectionIds.includes(c.id)} onChange={() => toggle(c.id)} className="h-4 w-4 accent-primary" />
              <span className="min-w-0 flex-1 truncate">{c.name}</span>
              <span className="shrink-0 text-[10.5px] text-muted">{c.connectionMode === "OFFICIAL_API" ? "Oficial" : "QR Code"}</span>
            </label>
          ))}
        </div>
      )}
      <p className="mt-1 text-xs text-muted">{hint}</p>
    </fieldset>
  );
}
