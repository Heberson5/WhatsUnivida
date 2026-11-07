import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { UserRoundPen } from "lucide-react";
import type { ClientDataCorrectionDTO } from "@whatsatendende/types";
import { api, getApiErrorMessage } from "../../lib/api";

const dismissKey = (conversationId: string, correctionId: string) => `data-correction-seen:${conversationId}:${correctionId}`;

function wasDismissed(conversationId: string, correctionId: string): boolean {
  try {
    return sessionStorage.getItem(dismissKey(conversationId, correctionId)) === "1";
  } catch {
    return false;
  }
}

/**
 * "Cadastro desatualizado": the customer told the Assistente Virtual a name/address different from the data source.
 * Pops up for whoever attends the customer — in every conversation they accept — until someone clicks "Cadastro já
 * atualizado" (kept with who and when). "Lembrar depois" only closes it for this conversation.
 */
export function DataCorrectionModal({ conversationId }: { conversationId: string }) {
  const queryClient = useQueryClient();
  const [, setTick] = useState(0);
  const { data } = useQuery({
    queryKey: ["data-corrections", conversationId],
    queryFn: async () => (await api.get<ClientDataCorrectionDTO[]>(`/conversations/${conversationId}/data-corrections`)).data,
  });
  const resolve = useMutation({
    mutationFn: async (correctionId: string) => (await api.post<ClientDataCorrectionDTO>(`/conversations/${conversationId}/data-corrections/${correctionId}/resolve`)).data,
    onSuccess: () => {
      toast.success("Cadastro marcado como atualizado.");
      queryClient.invalidateQueries({ queryKey: ["data-corrections", conversationId] });
      queryClient.invalidateQueries({ queryKey: ["notes", conversationId] });
    },
    onError: (err) => toast.error(getApiErrorMessage(err)),
  });

  const correction = data?.find((c) => !wasDismissed(conversationId, c.id));
  if (!correction) return null;

  const later = () => {
    try {
      sessionStorage.setItem(dismissKey(conversationId, correction.id), "1");
    } catch {
      // Without storage it simply shows again on the next render.
    }
    setTick((t) => t + 1);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 px-4" role="alertdialog" aria-modal="true" aria-labelledby="data-correction-title">
      <div className="w-full max-w-lg overflow-hidden rounded-card border border-warning bg-surface shadow-elevated">
        <div className="flex items-center gap-2 bg-warning px-5 py-3 text-white">
          <UserRoundPen className="h-5 w-5 shrink-0" />
          <h2 id="data-correction-title" className="text-base font-bold">
            Cadastro desatualizado
          </h2>
        </div>
        <div className="space-y-3 px-5 py-4 text-sm">
          <p>
            Ao Assistente Virtual, em {new Date(correction.createdAt).toLocaleString("pt-BR")}, o cliente (CPF {correction.cpf}) informou dados diferentes do cadastro. Atualize o cadastro
            no sistema da empresa.
          </p>
          <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 rounded-card border border-border p-3">
            <dt className="text-muted">Nome no cadastro</dt>
            <dd>{correction.clientName ?? "—"}</dd>
            <dt className="text-muted">Nome informado</dt>
            <dd>{correction.informedName ?? "—"}</dd>
            <dt className="text-muted">Endereço no cadastro</dt>
            <dd>{correction.registeredAddress ?? "—"}</dd>
            <dt className="font-semibold">Endereço informado</dt>
            <dd className="font-semibold">{correction.informedAddress ?? "—"}</dd>
          </dl>
          <div className="flex flex-wrap justify-end gap-2 pt-1">
            <button onClick={later} className="focus-ring rounded-card border border-border px-4 py-2 text-sm font-medium hover:bg-surface-alt">
              Lembrar depois
            </button>
            <button
              autoFocus
              onClick={() => resolve.mutate(correction.id)}
              disabled={resolve.isPending}
              className="focus-ring rounded-card bg-primary px-4 py-2 text-sm font-semibold text-primary-fg disabled:opacity-60"
            >
              Cadastro já atualizado
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
