import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { GitMerge, X } from "lucide-react";
import type { ConversationListItemDTO } from "@whatsatendende/types";
import { api, getApiErrorMessage } from "../../lib/api";
import { contactDisplayName } from "../../lib/contact-display";

/**
 * ADMIN-only cleanup tool for the @lid duplicate-conversation bug (see
 * findOrCreateContact) — picks another conversation on the same WhatsApp
 * connection to fold this duplicate into. Only ever needed for
 * already-existing duplicates; the underlying bug itself is fixed, so new
 * ones shouldn't keep appearing.
 */
export function MergeConversationModal({
  conversation,
  onClose,
  onMerged,
}: {
  conversation: ConversationListItemDTO;
  onClose: () => void;
  onMerged: () => void;
}) {
  const [search, setSearch] = useState("");
  const queryClient = useQueryClient();

  const candidatesQuery = useQuery({
    queryKey: ["merge-candidates", conversation.whatsappConnectionId, search],
    queryFn: async () =>
      (
        await api.get<ConversationListItemDTO[]>("/conversations/oversight", {
          params: { connectionId: [conversation.whatsappConnectionId], q: search || undefined },
        })
      ).data.filter((c) => c.id !== conversation.id),
    enabled: search.trim().length >= 2,
  });

  const mergeMutation = useMutation({
    mutationFn: (intoConversationId: string) =>
      api.post(`/conversations/${conversation.id}/merge`, { intoConversationId }),
    onSuccess: () => {
      toast.success("Conversas mescladas com sucesso.");
      queryClient.invalidateQueries({ queryKey: ["oversight"] });
      onMerged();
    },
    onError: (err) => toast.error(getApiErrorMessage(err)),
  });

  const displayName = contactDisplayName(conversation.contact, conversation.channel);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-4">
      <div className="w-full max-w-md rounded-card border border-border bg-surface p-5 shadow-elevated">
        <div className="flex items-center justify-between gap-2">
          <h2 className="flex items-center gap-2 text-base font-semibold">
            <GitMerge className="h-4 w-4 text-primary" /> Mesclar conversa duplicada
          </h2>
          <button onClick={onClose} className="focus-ring rounded-full p-1 text-muted hover:bg-surface-alt" aria-label="Fechar">
            <X className="h-4 w-4" />
          </button>
        </div>

        <p className="mt-2 text-sm text-muted">
          Todas as mensagens de <strong>{displayName}</strong> serão movidas para a conversa escolhida abaixo, e esta será
          removida. Essa ação não pode ser desfeita.
        </p>

        <input
          autoFocus
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Buscar a conversa correta por nome ou telefone..."
          className="focus-ring mt-4 w-full rounded-card border border-border bg-surface px-3 py-2 text-sm"
        />

        <div className="mt-3 max-h-64 overflow-y-auto rounded-card border border-border">
          {search.trim().length < 2 && <p className="p-4 text-center text-xs text-muted">Digite ao menos 2 caracteres para buscar.</p>}
          {search.trim().length >= 2 && candidatesQuery.isLoading && (
            <p className="p-4 text-center text-xs text-muted">Buscando...</p>
          )}
          {search.trim().length >= 2 && candidatesQuery.data?.length === 0 && (
            <p className="p-4 text-center text-xs text-muted">Nenhuma outra conversa encontrada.</p>
          )}
          {candidatesQuery.data?.map((c) => (
            <button
              key={c.id}
              onClick={() => mergeMutation.mutate(c.id)}
              disabled={mergeMutation.isPending}
              className="focus-ring flex w-full items-center justify-between gap-2 border-b border-border px-3 py-2 text-left text-sm last:border-b-0 hover:bg-surface-alt disabled:opacity-60"
            >
              <span className="min-w-0">
                <span className="block truncate font-medium">{contactDisplayName(c.contact)}</span>
                {c.contact.phone && <span className="block truncate text-xs text-muted">{c.contact.phone}</span>}
              </span>
              <span className="shrink-0 text-xs font-semibold text-primary">
                {mergeMutation.isPending && mergeMutation.variables === c.id ? "Mesclando..." : "Mesclar aqui"}
              </span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
