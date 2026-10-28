import { useQuery } from "@tanstack/react-query";
import { format, isToday } from "date-fns";
import { Check, CheckCheck, Clock, Info } from "lucide-react";
import type { ChatMessageDTO, ChatMessageInfoDTO } from "@whatsatendende/types";
import { api } from "../../lib/api";
import { ChatDialog } from "./ChatDialogs";
import { PersonAvatar } from "./ChatAvatar";

const when = (at: string) => `${isToday(new Date(at)) ? "hoje" : format(new Date(at), "dd/MM")} ${format(new Date(at), "HH:mm")}`;

/** "Dados da mensagem", like WhatsApp's: who read it, who only received it, and who hasn't yet — each with the time. */
export function MessageInfoPanel({ message, oversight, onClose }: { message: ChatMessageDTO; oversight?: boolean; onClose: () => void }) {
  const { data } = useQuery({
    queryKey: ["internal-chat", "info", message.id],
    queryFn: async () => (await api.get<ChatMessageInfoDTO>(oversight ? `/internal-chat/oversight/messages/${message.id}/info` : `/internal-chat/messages/${message.id}/info`)).data,
  });
  const section = (title: string, icon: React.ReactNode, people: { userId: string; name: string; photoUrl: string | null; at?: string }[]) =>
    people.length > 0 && (
      <div className="space-y-1.5">
        <p className="flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-wider text-muted">
          {icon}
          {title} · {people.length}
        </p>
        {people.map((p) => (
          <div key={p.userId} className="flex items-center gap-2.5">
            <PersonAvatar name={p.name} photoUrl={p.photoUrl} id={p.userId} size="sm" />
            <span className="flex-1 truncate">{p.name}</span>
            {p.at && <span className="text-xs tabular-nums text-muted">{when(p.at)}</span>}
          </div>
        ))}
      </div>
    );
  return (
    <ChatDialog title="Dados da mensagem" icon={<Info className="h-4 w-4 text-primary" />} onClose={onClose}>
      <div className="space-y-4">
        <div className="rounded-xl bg-surface-alt px-3 py-2 text-sm">
          <p className="line-clamp-3">{message.body ?? (message.kind === "AUDIO" ? "🎤 Áudio" : message.attachment?.name ?? "Mensagem")}</p>
          <p className="mt-1 text-right text-[11px] text-muted">enviada {when(message.createdAt)}</p>
        </div>
        {!data && <p className="text-muted">Carregando…</p>}
        {data && (
          <>
            {section("Lida por", <CheckCheck className="h-3.5 w-3.5 text-[var(--color-read-receipt)]" />, data.readBy)}
            {section("Entregue a", <CheckCheck className="h-3.5 w-3.5" />, data.deliveredTo)}
            {section("Ainda não recebeu", <Clock className="h-3.5 w-3.5" />, data.pending)}
            {!data.readBy.length && !data.deliveredTo.length && !data.pending.length && (
              <p className="flex items-center gap-1.5 text-muted">
                <Check className="h-4 w-4" /> Ninguém mais estava na conversa.
              </p>
            )}
          </>
        )}
      </div>
    </ChatDialog>
  );
}
