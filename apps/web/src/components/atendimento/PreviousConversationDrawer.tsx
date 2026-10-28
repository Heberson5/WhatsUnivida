import { useQuery } from "@tanstack/react-query";
import { format } from "date-fns";
import { ptBR } from "date-fns/locale";
import { Star, StickyNote, X } from "lucide-react";
import type { PreviousConversationDetailDTO } from "@whatsatendende/types";
import { api } from "../../lib/api";
import { MessageBubble } from "./MessageBubble";

/** An earlier conversation of the same contact, opened read-only from the client panel. */
export function PreviousConversationDrawer({ conversationId, previousId, onClose }: { conversationId: string; previousId: string; onClose: () => void }) {
  const { data, isLoading } = useQuery({
    queryKey: ["previous-conversation", conversationId, previousId],
    queryFn: async () => (await api.get<PreviousConversationDetailDTO>(`/conversations/${conversationId}/previous/${previousId}`)).data,
  });

  return (
    <div className="fixed inset-0 z-40 flex justify-end bg-black/30" onClick={onClose}>
      <aside className="flex h-full w-full max-w-lg flex-col border-l border-border bg-[var(--color-bg)] shadow-elevated" onClick={(e) => e.stopPropagation()} aria-label="Conversa anterior">
        <header className="flex items-start justify-between gap-2 border-b border-border bg-surface px-4 py-3">
          <div className="min-w-0">
            <h2 className="text-sm font-semibold">Conversa de {data ? format(new Date(data.startedAt), "dd 'de' MMM yyyy", { locale: ptBR }) : "..."}</h2>
            {data && (
              <p className="text-xs text-muted">
                {data.agentName ?? "Sem atendente"}
                {data.closedAt && ` · encerrada ${format(new Date(data.closedAt), "dd/MM HH:mm")}`} · somente leitura
              </p>
            )}
          </div>
          <button onClick={onClose} className="focus-ring rounded-full p-1 text-muted hover:bg-surface-alt" aria-label="Fechar">
            <X className="h-5 w-5" />
          </button>
        </header>

        {data && (data.survey || data.notes.length > 0) && (
          <div className="space-y-2 border-b border-border bg-surface px-4 py-3 text-xs">
            {data.survey && (
              <p className="flex items-center gap-1.5">
                <Star className="h-3.5 w-3.5 text-warning" />
                Pesquisa: <strong>{data.survey.score ?? "sem nota"}</strong>
                {data.survey.answerText && <span className="truncate text-muted">“{data.survey.answerText}”</span>}
              </p>
            )}
            {data.notes.map((n) => (
              <p key={n.id} className="flex items-start gap-1.5">
                <StickyNote className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted" />
                <span>
                  <strong>{n.authorName}</strong> <span className="text-muted">{format(new Date(n.createdAt), "dd/MM HH:mm")}</span>: {n.body}
                </span>
              </p>
            ))}
          </div>
        )}

        <div className="flex-1 space-y-3 overflow-y-auto px-4 py-4">
          {isLoading && <p className="text-center text-xs text-muted">Carregando...</p>}
          {data?.messages.length === 0 && <p className="text-center text-xs text-muted">Sem mensagens nesta conversa.</p>}
          {data?.messages.map((m) => (
            <div key={m.id} className={m.direction === "OUTBOUND" ? "flex justify-end" : "flex justify-start"}>
              <MessageBubble message={m} onReply={() => undefined} readOnly />
            </div>
          ))}
        </div>
      </aside>
    </div>
  );
}
