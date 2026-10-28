import clsx from "clsx";
import { formatDistanceToNow } from "date-fns";
import { ptBR } from "date-fns/locale";
import type { ConversationListItemDTO } from "@whatsunivida/types";

function initials(name: string) {
  return name
    .split(" ")
    .slice(0, 2)
    .map((p) => p[0])
    .join("")
    .toUpperCase();
}

export function ConversationCard({
  conversation,
  selected,
  onSelect,
  onAccept,
  accepting,
}: {
  conversation: ConversationListItemDTO;
  selected?: boolean;
  onSelect?: () => void;
  onAccept?: () => void;
  accepting?: boolean;
}) {
  const displayName = conversation.contact.name || conversation.contact.phone;
  // When there's a saved name, displayName hides the phone entirely — show
  // it as a subtitle too, since the phone number is what an agent actually
  // needs to confirm/dial/search by, not just a name that could be wrong
  // or shared by two different contacts.
  const showPhoneSubtitle = Boolean(conversation.contact.name);
  // A disconnected connection can't actually deliver anything — accepting
  // from here would just leave the customer with no reply possible, so the
  // button is disabled instead of letting the click fail server-side.
  const connectionDisconnected = conversation.whatsappConnectionStatus !== "CONNECTED";

  return (
    <div
      role={onSelect ? "button" : undefined}
      tabIndex={onSelect ? 0 : undefined}
      onClick={onSelect}
      onKeyDown={(e) => onSelect && e.key === "Enter" && onSelect()}
      className={clsx(
        "focus-ring shadow-soft flex cursor-pointer items-start gap-3 rounded-card border p-3 pl-2.5 transition-colors",
        selected ? "border-primary bg-primary/5" : "border-border hover:bg-surface-alt"
      )}
      style={{ borderLeft: `4px solid ${conversation.whatsappConnectionColor}` }}
    >
      <div className="relative shrink-0">
        {conversation.contact.photoUrl ? (
          <img src={conversation.contact.photoUrl} alt="" className="h-11 w-11 rounded-full object-cover" />
        ) : (
          <div className="flex h-11 w-11 items-center justify-center rounded-full bg-surface-alt text-sm font-semibold text-muted">
            {initials(displayName)}
          </div>
        )}
        {conversation.isNew && (
          <span className="absolute -right-0.5 -top-0.5 h-3 w-3 rounded-full border-2 border-surface bg-secondary" />
        )}
        {conversation.unreadCount > 0 && (
          <span className="absolute -bottom-1 -right-1 flex h-5 min-w-[20px] items-center justify-center rounded-full border-2 border-surface bg-primary px-1 text-[10px] font-bold text-primary-fg">
            {conversation.unreadCount > 99 ? "99+" : conversation.unreadCount}
          </span>
        )}
      </div>

      <div className="min-w-0 flex-1">
        <div className="flex items-center justify-between gap-2">
          <p className={clsx("truncate text-sm", conversation.unreadCount > 0 ? "font-bold" : "font-semibold")}>{displayName}</p>
          <span className="shrink-0 text-xs text-muted">
            {formatDistanceToNow(new Date(conversation.enteredQueueAt), { locale: ptBR, addSuffix: false })}
          </span>
        </div>

        {showPhoneSubtitle && <p className="truncate text-xs text-muted">{conversation.contact.phone}</p>}

        <div className="mt-1 flex flex-wrap items-center gap-1.5">
          <span
            className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium"
            style={{ backgroundColor: `${conversation.whatsappConnectionColor}1A`, color: conversation.whatsappConnectionColor }}
          >
            <span className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: conversation.whatsappConnectionColor }} />
            {conversation.whatsappConnectionName}
          </span>
          {conversation.transfer && (
            <span className="inline-flex items-center rounded-full bg-secondary/40 px-2 py-0.5 text-[11px] font-medium text-secondary-fg">
              Transferido de {conversation.transfer.fromAgentName}
            </span>
          )}
          {connectionDisconnected && (
            <span className="inline-flex items-center rounded-full bg-red-100 px-2 py-0.5 text-[11px] font-medium text-red-700">
              Conexão desconectada
            </span>
          )}
        </div>

        {conversation.lastMessagePreview ? (
          <p className="mt-0.5 truncate text-xs text-muted">{conversation.lastMessagePreview}</p>
        ) : (
          <p className="mt-0.5 text-xs text-muted">{onAccept ? "Nova conversa" : "Em atendimento"}</p>
        )}

        {onAccept && (
          <button
            onClick={(e) => {
              e.stopPropagation();
              onAccept();
            }}
            disabled={accepting || connectionDisconnected}
            title={connectionDisconnected ? "Conexão desconectada — não é possível aceitar conversas" : undefined}
            className="focus-ring mt-2 w-full rounded-card bg-primary py-1.5 text-xs font-semibold text-primary-fg disabled:opacity-60"
          >
            {accepting ? "Aceitando..." : connectionDisconnected ? "Conexão desconectada" : "ACEITAR"}
          </button>
        )}
      </div>
    </div>
  );
}
