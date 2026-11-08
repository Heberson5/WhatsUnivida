import { useQuery } from "@tanstack/react-query";
import { CheckCircle2, CircleAlert, TriangleAlert } from "lucide-react";
import type { AiAssistantClientDataDTO } from "@whatsatendende/types";
import { api } from "../../lib/api";

function when(iso: string | null): string {
  return iso
    ? new Date(iso).toLocaleString("pt-BR", {
        day: "2-digit",
        month: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
      })
    : "—";
}

/**
 * Configurações › Assistente Virtual › Dados dos clientes: for each connection the assistant attends, whether it can
 * consult the client data right now. In working hours only up-to-date data; outside them and on holidays, a little older
 * too (the boleto then goes with "se já pagou, desconsidere").
 */
export function AssistenteDadosClientes() {
  const { data } = useQuery({
    queryKey: ["ai-assistant-client-data"],
    queryFn: async () =>
      (
        await api.get<AiAssistantClientDataDTO[]>(
          "/settings/ai-assistant/client-data",
        )
      ).data,
    refetchInterval: 60_000,
  });

  return (
    <div className="rounded-card border border-border p-4">
      <p className="text-sm font-semibold">Dados dos clientes</p>
      {!data ? (
        <p className="mt-2 text-sm text-muted">Verificando…</p>
      ) : data.length === 0 ? (
        <p className="mt-2 text-sm text-muted">
          Escolha as conexões em que o assistente atende.
        </p>
      ) : (
        <ul className="mt-2 space-y-3">
          {data.map((item) => (
            <li key={item.connectionId} className="text-sm">
              <p className="font-medium">{item.connectionName}</p>
              {item.usableNow && item.status === "OK" ? (
                <p className="mt-0.5 flex items-start gap-2 text-emerald-700 dark:text-emerald-300">
                  <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" /> Em dia —{" "}
                  {item.sourceName}, dados de {when(item.dataUpdatedAt)}.
                </p>
              ) : item.usableNow ? (
                <p className="mt-0.5 flex items-start gap-2 text-warning">
                  <CircleAlert className="mt-0.5 h-4 w-4 shrink-0" /> Fora do
                  prazo (dados de {when(item.dataUpdatedAt)}), mas usada agora
                  por estar fora do expediente. O boleto vai com “se já pagou,
                  desconsidere”.
                </p>
              ) : (
                <p className="mt-0.5 flex items-start gap-2 text-red-600">
                  <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" />
                  <span>
                    Não dá para consultar: {item.reason}. Quem pedir boleto ou
                    débitos vai para a equipe com o CPF anotado.
                  </span>
                </p>
              )}
              <p className="mt-0.5 text-xs text-muted">
                {item.closedNow
                  ? "Agora: fora do expediente."
                  : "Agora: dentro do expediente."}
              </p>
            </li>
          ))}
        </ul>
      )}
      <p className="mt-3 text-xs text-muted">
        No expediente, o assistente só usa dados dentro do prazo da fonte. Fora
        do expediente e nos feriados, usa dados até{" "}
        {data?.[0]?.staleToleranceHours ?? 72} horas além do prazo.
      </p>
    </div>
  );
}
