import { StickyNote } from "lucide-react";
import { format } from "date-fns";
import { ptBR } from "date-fns/locale";
import type { ConversationListItemDTO } from "@whatsatendende/types";

/**
 * Internal annotation left by whoever transferred a conversation — app-only
 * data (conversation.transfer.note, never a Message row), so it can never
 * reach WhatsApp/the customer no matter what. Rendered INLINE in the
 * message timeline, at the point the transfer actually happened — between
 * the last message sent before it and the first one after — rather than as
 * a static banner pinned above the messages regardless of scroll position.
 * See PROMPT: "As observações quando é transferida a conversa, deve ficar
 * dentro da conversa entre a última mensagem enviada e as novas depois da
 * transferência."
 */
export function TransferNoteCard({ transfer }: { transfer: NonNullable<ConversationListItemDTO["transfer"]> }) {
  if (!transfer.note) return null;
  return (
    <div className="flex justify-center">
      <div className="flex max-w-md items-start gap-2 rounded-card border border-secondary/50 bg-secondary/20 px-3 py-2 text-center sm:text-left">
        <StickyNote className="mt-0.5 hidden h-4 w-4 shrink-0 text-text sm:block" />
        <div className="min-w-0">
          <p className="text-xs font-semibold text-text">
            Observação de {transfer.fromAgentName} · {format(new Date(transfer.at), "dd/MM 'às' HH:mm", { locale: ptBR })}
          </p>
          <p className="mt-0.5 whitespace-pre-wrap text-sm text-text">{transfer.note}</p>
        </div>
      </div>
    </div>
  );
}
