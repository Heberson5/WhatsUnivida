import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { Check, Forward, X } from "lucide-react";
import clsx from "clsx";
import type { ConversationListItemDTO, MessageDTO } from "@whatsatendende/types";
import { api, getApiErrorMessage } from "../../lib/api";
import { contactDisplayName } from "../../lib/contact-display";

const MAX_TARGETS = 10;

/** "Encaminhar": picks one or more of the agent's own conversations to send a copy of `message` to. */
export function ForwardModal({ message, currentConversationId, onClose }: { message: MessageDTO; currentConversationId: string; onClose: () => void }) {
  const { data: conversations } = useQuery({
    queryKey: ["mine"],
    queryFn: async () => (await api.get<ConversationListItemDTO[]>("/conversations/mine")).data,
  });
  const [selected, setSelected] = useState<string[]>([]);
  const [filter, setFilter] = useState("");

  const targets = (conversations ?? []).filter(
    (c) => c.id !== currentConversationId && ["IN_PROGRESS", "TRANSFERRED"].includes(c.status) && contactDisplayName(c.contact).toLowerCase().includes(filter.trim().toLowerCase())
  );

  const forwardMutation = useMutation({
    mutationFn: () => api.post(`/messages/${message.id}/forward`, { conversationIds: selected }),
    onSuccess: () => {
      toast.success(selected.length === 1 ? "Mensagem encaminhada" : `Mensagem encaminhada para ${selected.length} conversas`);
      onClose();
    },
    onError: (err) => toast.error(getApiErrorMessage(err)),
  });

  function toggle(id: string) {
    setSelected((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : prev.length < MAX_TARGETS ? [...prev, id] : prev));
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-4">
      <div className="w-full max-w-md rounded-card border border-border bg-surface p-5 shadow-elevated">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-base font-semibold">Encaminhar mensagem</h2>
          <button onClick={onClose} className="focus-ring rounded-full p-1 text-muted hover:bg-surface-alt" aria-label="Fechar">
            <X className="h-5 w-5" />
          </button>
        </div>
        <p className="mb-3 line-clamp-2 rounded-card bg-surface-alt px-3 py-2 text-xs text-muted">
          {message.body || message.attachments[0]?.fileName || "Arquivo"}
        </p>
        <input
          autoFocus
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="Buscar entre as suas conversas"
          className="focus-ring mb-2 w-full rounded-card border border-border bg-surface px-3 py-2 text-sm"
        />
        <div className="max-h-64 overflow-y-auto rounded-card border border-border p-1">
          {targets.length === 0 && <p className="px-2 py-3 text-sm text-muted">Nenhuma outra conversa em atendimento com você.</p>}
          {targets.map((c) => {
            const checked = selected.includes(c.id);
            return (
              <button
                key={c.id}
                onClick={() => toggle(c.id)}
                className={clsx("flex w-full items-center gap-2 rounded-card px-2 py-2 text-left text-sm hover:bg-surface-alt", checked && "bg-primary/10")}
              >
                <span className={clsx("flex h-4 w-4 shrink-0 items-center justify-center rounded border", checked ? "border-primary bg-primary text-primary-fg" : "border-border")}>
                  {checked && <Check className="h-3 w-3" />}
                </span>
                <span className="flex-1 truncate">{contactDisplayName(c.contact)}</span>
              </button>
            );
          })}
        </div>
        <p className="mt-2 text-xs text-muted">Até {MAX_TARGETS} conversas. Vai como uma mensagem sua, com o seu nome se essa opção estiver ligada.</p>
        <div className="mt-4 flex justify-end gap-2">
          <button onClick={onClose} className="focus-ring rounded-card px-3 py-2 text-sm hover:bg-surface-alt">
            Cancelar
          </button>
          <button
            onClick={() => forwardMutation.mutate()}
            disabled={selected.length === 0 || forwardMutation.isPending}
            className="focus-ring inline-flex items-center gap-1.5 rounded-card bg-primary px-3 py-2 text-sm font-medium text-primary-fg disabled:opacity-50"
          >
            <Forward className="h-4 w-4" /> Encaminhar{selected.length > 1 ? ` (${selected.length})` : ""}
          </button>
        </div>
      </div>
    </div>
  );
}
