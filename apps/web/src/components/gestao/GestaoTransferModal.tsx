import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { AlertTriangle, Check, X } from "lucide-react";
import type { ConversationListItemDTO } from "@whatsatendende/types";
import { api, getApiErrorMessage } from "../../lib/api";
import { contactDisplayName } from "../../lib/contact-display";

interface AgentOption {
  id: string;
  displayName: string;
  presence: "ONLINE" | "AWAY" | "OFFLINE";
  status: "ACTIVE" | "INACTIVE";
  whatsappConnectionName: string | null;
  pauseReasonName: string | null;
}

const PRESENCE_DOT: Record<string, string> = { ONLINE: "bg-green-500", AWAY: "bg-yellow-500", OFFLINE: "bg-gray-400" };
const PRESENCE_LABEL: Record<string, string> = { ONLINE: "Online", AWAY: "Ausente", OFFLINE: "Offline" };

// See TransferModal's presenceLabel — same reasoning, duplicated here since this
// modal fetches agents via a different endpoint (/agents vs /agents/transfer-targets).
function presenceLabel(agent: Pick<AgentOption, "presence" | "pauseReasonName">) {
  return agent.presence === "AWAY" && agent.pauseReasonName ? `Pausado — ${agent.pauseReasonName}` : PRESENCE_LABEL[agent.presence];
}

/**
 * MANAGER/ADMIN routing a conversation straight from Gestão — to a chosen
 * agent, from any still-active status (including one nobody has ever
 * claimed, or a customer parked in HANDLED_EXTERNALLY). See PROMPT: "No
 * menu gestão, precisa ter a opção de transferir para algum atendente ou
 * enviar para fila."
 */
export function GestaoTransferModal({
  conversations,
  onClose,
  onTransferred,
}: {
  /** One conversation, or several picked with Gestão's bulk selection — all go to the same agent. */
  conversations: ConversationListItemDTO[];
  onClose: () => void;
  onTransferred: () => void;
}) {
  const conversation = conversations[0];
  const isBulk = conversations.length > 1;
  const queryClient = useQueryClient();
  const [selected, setSelected] = useState<string | null>(null);
  const [confirmingOffline, setConfirmingOffline] = useState(false);

  const { data: agents } = useQuery({
    queryKey: ["agents"],
    queryFn: async () => (await api.get<AgentOption[]>("/agents")).data,
  });
  const activeAgents = (agents ?? []).filter((a) => a.status === "ACTIVE");
  const selectedAgent = activeAgents.find((a) => a.id === selected) ?? null;

  const transferMutation = useMutation({
    mutationFn: async (toAgentId: string) => {
      const targets = conversations.filter((c) => c.assignedAgentId !== toAgentId);
      const results = await Promise.allSettled(targets.map((c) => api.post(`/conversations/${c.id}/gestao-transfer`, { toAgentId })));
      const failed = results.filter((r) => r.status === "rejected") as PromiseRejectedResult[];
      if (failed.length === targets.length && failed.length > 0) throw failed[0].reason;
      return { ok: targets.length - failed.length, failed: failed.length };
    },
    onSuccess: ({ ok, failed }) => {
      const who = selectedAgent?.displayName ?? "o atendente";
      toast.success(isBulk ? `${ok} ${ok === 1 ? "conversa transferida" : "conversas transferidas"} para ${who}.` : `Conversa transferida para ${who}.`);
      if (failed) toast.error(`${failed} não puderam ser transferidas.`);
      queryClient.invalidateQueries({ queryKey: ["oversight"] });
      onTransferred();
    },
    onError: (err) => toast.error(getApiErrorMessage(err)),
  });

  function handleConfirmClick() {
    if (!selectedAgent) return;
    if (selectedAgent.presence !== "ONLINE" && !confirmingOffline) {
      setConfirmingOffline(true);
      return;
    }
    transferMutation.mutate(selectedAgent.id);
  }

  const displayName = contactDisplayName(conversation.contact, conversation.channel);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-4">
      <div className="w-full max-w-md rounded-card border border-border bg-surface p-5 shadow-elevated">
        <div className="mb-1 flex items-center justify-between">
          <h2 className="text-base font-semibold">Transferir para um atendente</h2>
          <button onClick={onClose} className="focus-ring rounded-full p-1 text-muted hover:bg-surface-alt" aria-label="Fechar">
            <X className="h-5 w-5" />
          </button>
        </div>
        <p className="mb-4 text-sm text-muted">
          {isBulk ? (
            <>
              <strong>{conversations.length} conversas</strong> selecionadas.
            </>
          ) : (
            <>
              Conversa de <strong>{displayName}</strong>
              {conversation.assignedAgentName ? <> — atualmente com {conversation.assignedAgentName}</> : null}.
            </>
          )}
        </p>

        <div className="max-h-64 overflow-y-auto rounded-card border border-border">
          {activeAgents.length === 0 && <p className="p-4 text-center text-xs text-muted">Nenhum atendente disponível.</p>}
          {activeAgents.map((agent) => (
            <button
              key={agent.id}
              type="button"
              onClick={() => {
                setSelected(agent.id);
                setConfirmingOffline(false);
              }}
              disabled={!isBulk && agent.id === conversation.assignedAgentId}
              className={`focus-ring flex w-full items-center gap-3 border-b border-border px-3 py-2 text-left last:border-b-0 disabled:cursor-not-allowed disabled:opacity-50 ${
                selected === agent.id ? "bg-primary/10 shadow-[inset_3px_0_0_0_var(--color-primary)]" : "hover:bg-surface-alt"
              }`}
            >
              <span className={`h-2 w-2 shrink-0 rounded-full ${PRESENCE_DOT[agent.presence]}`} />
              <span className={`min-w-0 flex-1 truncate text-sm ${selected === agent.id ? "font-semibold text-primary" : ""}`}>{agent.displayName}</span>
              <span className="shrink-0 text-xs text-muted">
                {!isBulk && agent.id === conversation.assignedAgentId ? "Atendente atual" : presenceLabel(agent)}
                {agent.whatsappConnectionName ? ` · ${agent.whatsappConnectionName}` : ""}
              </span>
              {selected === agent.id && <Check className="h-4 w-4 shrink-0 text-primary" />}
            </button>
          ))}
        </div>

        {confirmingOffline && selectedAgent && (
          <div className="mt-3 flex items-start gap-2 rounded-card bg-secondary/30 px-3 py-2 text-sm text-text">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
            <span>
              <strong>{selectedAgent.displayName}</strong> está offline agora. Tem certeza que deseja transferir mesmo assim?
            </span>
          </div>
        )}

        <div className="mt-4 flex gap-2">
          <button onClick={onClose} className="focus-ring flex-1 rounded-card border border-border py-2 text-sm">
            Cancelar
          </button>
          <button
            onClick={handleConfirmClick}
            disabled={!selected || transferMutation.isPending}
            className="focus-ring flex-1 rounded-card bg-primary py-2 text-sm font-semibold text-primary-fg disabled:opacity-60"
          >
            {transferMutation.isPending ? "Transferindo..." : confirmingOffline ? "Sim, transferir mesmo assim" : "Transferir"}
          </button>
        </div>
      </div>
    </div>
  );
}
