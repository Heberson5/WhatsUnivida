import { useMutation, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle } from "lucide-react";
import { api } from "../../lib/api";
import { clientDataKey, useClientData } from "../../hooks/useClientData";

/** Mandatory once per conversation when a contract of this client is suspended for non-payment. */
export function SuspensionWarningModal({ conversationId }: { conversationId: string }) {
  const queryClient = useQueryClient();
  const { data } = useClientData(conversationId);
  const ackMutation = useMutation({
    mutationFn: () => api.post(`/conversations/${conversationId}/client-data/suspension-ack`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: clientDataKey(conversationId) }),
  });
  if (!data?.suspensionWarningPending || !data.client) return null;
  const suspended = data.client.contracts.filter((c) => c.suspended);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 px-4" role="alertdialog" aria-modal="true" aria-labelledby="suspension-title">
      <div className="w-full max-w-md overflow-hidden rounded-card border border-danger bg-surface shadow-elevated">
        <div className="flex items-center gap-2 bg-danger px-5 py-3 text-white">
          <AlertTriangle className="h-5 w-5 shrink-0" />
          <h2 id="suspension-title" className="text-base font-bold">
            Contrato suspenso
          </h2>
        </div>
        <div className="space-y-3 px-5 py-4 text-sm">
          {suspended.map((c) => (
            <p key={c.number}>
              Contrato <strong>{c.number}</strong> SUSPENSO por inadimplência ({c.overdueCount} parcelas vencidas). Todos os benefícios do contrato e de todos os
              beneficiários estão suspensos.
            </p>
          ))}
          <button
            autoFocus
            onClick={() => ackMutation.mutate()}
            disabled={ackMutation.isPending}
            className="focus-ring w-full rounded-card bg-danger py-2 text-sm font-semibold text-white disabled:opacity-60"
          >
            Entendi
          </button>
        </div>
      </div>
    </div>
  );
}
