import clsx from "clsx";
import { format, formatDistanceToNow, isToday, isYesterday } from "date-fns";
import { ptBR } from "date-fns/locale";
import { AlarmClock, Facebook, Instagram, Mic, PencilLine, Pin, Smartphone, type LucideIcon } from "lucide-react";
import type { CardTagDTO, Channel, ConversationListItemDTO, ConversationReminderDTO } from "@whatsatendende/types";
import { contactDisplayName } from "../../lib/contact-display";
import { formatPhone } from "../../lib/format-phone";
import { useNow } from "../../hooks/useNow";
import { ContactPhoto } from "../common/ContactPhoto";
import { useAuthStore } from "../../store/auth-store";
import { draftKey, useDraftStore } from "../../store/draft-store";
import { useCustomerTyping } from "../../store/typing-store";
import { useAlertThresholds } from "../../hooks/useAlertThresholds";
import { NoReturnBadge } from "./NoReturn";
import { businessMinutesSince, businessWaitLabel, PAUSED_LABEL, waitPaused } from "../../lib/business-wait";


function shortTime(iso: string) {
  const d = new Date(iso);
  if (isToday(d)) return format(d, "HH:mm");
  if (isYesterday(d)) return "ontem";
  return format(d, "dd/MM");
}

function shortReminderTime(iso: string) {
  const d = new Date(iso);
  return isToday(d) ? format(d, "HH:mm") : format(d, "dd/MM HH:mm");
}

/** How long the customer has waited for a reply — inside the Horário de expediente only. */
export function minutesWaiting(conversation: ConversationListItemDTO, now: number) {
  return conversation.awaitingReplySince ? businessMinutesSince(conversation.businessClock, conversation.awaitingReplySince, now) : 0;
}

// null = no icon, just the colored dot (WhatsApp's original look, unchanged).
const CHANNEL_ICON: Record<Channel, LucideIcon | null> = {
  WHATSAPP: null,
  INSTAGRAM: Instagram,
  MESSENGER: Facebook,
};

const CARD_TAG_LIMIT = 3;

/** The contact's tags beside the number, right-aligned — up to 3, the rest as "+N" (hover lists them). */
function CardTags({ tags }: { tags: CardTagDTO[] }) {
  if (tags.length === 0) return null;
  const shown = tags.slice(0, CARD_TAG_LIMIT);
  const rest = tags.slice(CARD_TAG_LIMIT);
  return (
    <span className="ms-auto flex flex-wrap justify-end gap-1" aria-label={`Etiquetas: ${tags.map((t) => t.name).join(", ")}`}>
      {shown.map((tag) => (
        <span key={tag.id} className="inline-flex max-w-[9rem] items-center gap-1 rounded-full border border-border bg-surface px-1.5 py-px text-[10.5px] text-[var(--color-text)]">
          <span className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ backgroundColor: tag.color }} />
          <span className="truncate">{tag.name}</span>
        </span>
      ))}
      {rest.length > 0 && (
        <span title={rest.map((t) => t.name).join(", ")} className="inline-flex items-center rounded-full border border-border bg-surface px-1.5 py-px text-[10.5px] text-muted">
          +{rest.length}
        </span>
      )}
    </span>
  );
}

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
  agentPaused,
  transferredOutView,
  pinned,
  reminder,
}: {
  conversation: ConversationListItemDTO;
  selected?: boolean;
  onSelect?: () => void;
  onAccept?: () => void;
  accepting?: boolean;
  // See PROMPT: "quando estiver pausado, não permitirá aceitar novas
  // conversas, só poderá responder as existentes" — mirrors the backend
  // check in acceptConversation, disabled client-side first so the agent
  // never has to find out by watching the click fail.
  agentPaused?: boolean;
  // "Transferidas" tab: this agent's own transfer is the point of the
  // card, so the badge and timestamp read from conversation.transfer
  // (who *I* sent it to, and when) instead of the usual "who sent it to
  // me" badge and the last-message timestamp.
  transferredOutView?: boolean;
  /** "Meus" only: pinned to the top by this attendant, and their "lembrar de retornar" for it. */
  pinned?: boolean;
  reminder?: ConversationReminderDTO | null;
}) {
  const now = useNow();
  const userId = useAuthStore((s) => s.user?.id);
  const customerTyping = useCustomerTyping(conversation.id);
  // Only the attendant's own conversations can hold a draft (queue/transferred cards have no composer).
  const hasDraft = useDraftStore((s) => Boolean(!onAccept && !transferredOutView && userId && s.drafts[draftKey(userId, conversation.id)]?.trim()));
  const displayName = contactDisplayName(conversation.contact, conversation.channel);
  const ChannelIcon = CHANNEL_ICON[conversation.channel];
  // When there's a saved name, displayName hides the phone entirely — show
  // it as a subtitle too, since the phone number is what an agent actually
  // needs to confirm/dial/search by.
  const showPhoneSubtitle = Boolean(conversation.contact.name && conversation.contact.phone);
  const cardTags = conversation.tags ?? [];
  const birthdays = conversation.birthdaysToday ?? [];
  // A disconnected connection can't actually deliver anything — accepting
  // from here would just leave the customer with no reply possible.
  const connectionDisconnected = conversation.whatsappConnectionStatus !== "CONNECTED";
  const thresholds = useAlertThresholds();
  // Fila: how long it has waited to be accepted; Meus: how long the customer has waited for a reply.
  const queueMinutes = onAccept ? businessMinutesSince(conversation.businessClock, conversation.enteredQueueAt, now) : 0;
  const queueWarning = Boolean(onAccept) && queueMinutes >= thresholds.queueWarningMinutes;
  const queueDanger = Boolean(onAccept) && queueMinutes >= thresholds.queueDangerMinutes;
  const waitingMinutes = transferredOutView ? 0 : minutesWaiting(conversation, now);
  const noReply = waitingMinutes >= thresholds.noReplyWarningMinutes;
  const noReplyDanger = waitingMinutes >= thresholds.noReplyDangerMinutes;
  const alertDanger = noReplyDanger || queueDanger;
  const alertWarning = !alertDanger && (noReply || queueWarning);
  const timeLabel = noReply
    ? `há ${businessWaitLabel(conversation.businessClock, conversation.awaitingReplySince!, now)}`
    : onAccept
      ? businessWaitLabel(conversation.businessClock, conversation.enteredQueueAt, now)
      : shortTime(transferredOutView && conversation.transfer ? conversation.transfer.at : conversation.lastMessageAt);
  // A queue or "sem resposta" wait stands still while the connection is closed — say so instead of letting it look stuck.
  const paused = (Boolean(onAccept) || noReply) && waitPaused(conversation.businessClock, now);

  return (
    <div
      role={onSelect ? "button" : undefined}
      tabIndex={onSelect ? 0 : undefined}
      onClick={onSelect}
      onKeyDown={(e) => onSelect && e.key === "Enter" && onSelect()}
      aria-current={selected ? "true" : undefined}
      className={clsx(
        "focus-ring relative flex items-start gap-3 border-b border-border px-3 py-3 transition-colors",
        onSelect && "cursor-pointer",
        selected ? "bg-primary/[0.07]" : alertDanger ? "bg-danger-soft/60 hover:bg-danger-soft" : alertWarning ? "bg-warning-soft/60 hover:bg-warning-soft" : "hover:bg-surface-alt"
      )}
    >
      {!selected && (alertDanger || alertWarning) && (
        <span className={clsx("absolute inset-y-0 left-0 w-[3px]", alertDanger ? "bg-danger" : "bg-warning")} aria-hidden />
      )}
      {selected && <span className="absolute inset-y-2 left-0 w-[3px] rounded-r bg-primary" aria-hidden />}
      <div className="relative shrink-0">
        {conversation.contact.photoUrl ? (
          <ContactPhoto photoUrl={conversation.contact.photoUrl} name={displayName} phone={conversation.contact.phone}>
            <img src={conversation.contact.photoUrl} alt="" className="h-10 w-10 rounded-full object-cover" />
          </ContactPhoto>
        ) : (
          <div className="flex h-10 w-10 items-center justify-center rounded-full bg-primary/10 text-[13px] font-semibold text-primary">
            {initials(displayName)}
          </div>
        )}
        {conversation.isNew && <span className="absolute -right-0.5 -top-0.5 h-3 w-3 rounded-full border-2 border-surface bg-secondary" />}
      </div>

      <div className="min-w-0 flex-1">
        <div className="flex items-baseline justify-between gap-2">
          <p className={clsx("flex min-w-0 items-center gap-1 text-[13.5px]", conversation.unreadCount > 0 ? "font-bold" : "font-semibold")}>
            {pinned && <Pin className="h-3 w-3 shrink-0 text-primary" aria-label="Fixada" />}
            <span className="truncate">{displayName}</span>
            {birthdays.length > 0 && (
              <span
                className="shrink-0 rounded-full bg-secondary/60 px-1.5 text-[10.5px] font-bold text-secondary-fg"
                title={birthdays.map((b) => `${b.name} (${b.holder ? "titular" : (b.relation ?? "beneficiário")}) faz ${b.age} anos hoje`).join("\n")}
              >
                🎂 {birthdays.length > 1 ? `${birthdays.length} aniversários` : birthdays[0].holder ? "Aniversário hoje" : `${birthdays[0].relation ?? "Beneficiário"} faz ${birthdays[0].age}`}
              </span>
            )}
          </p>
          <span
            className={clsx(
              "shrink-0 text-[11px]",
              alertDanger ? "font-semibold text-danger" : alertWarning ? "font-semibold text-warning" : "text-muted"
            )}
          >
            {timeLabel}
          </span>
        </div>

        {/* The number with the tags at its right; on a narrow screen the tags drop below it. */}
        {(showPhoneSubtitle || cardTags.length > 0) && (
          <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
            {showPhoneSubtitle && <p className="min-w-0 truncate text-[11.5px] tabular-nums text-muted">{formatPhone(conversation.contact.phone!)}</p>}
            <CardTags tags={cardTags} />
          </div>
        )}
        {paused && (
          <p className="truncate text-[11px] text-muted" title="O tempo de espera só conta dentro do Horário de expediente">
            {PAUSED_LABEL}
          </p>
        )}
        {customerTyping ? (
          <p className={clsx("flex items-center gap-1 truncate text-xs font-semibold italic", customerTyping.kind === "recording" ? "text-danger" : "text-success")}>
            {customerTyping.kind === "recording" && <Mic className="chat-pulse h-3 w-3 shrink-0" />}
            {customerTyping.text}
          </p>
        ) : conversation.lastMessagePreview ? (
          <p className={clsx("truncate text-xs", conversation.unreadCount > 0 ? "font-medium text-[var(--color-text)]" : "text-muted")}>
            {conversation.lastMessagePreview}
          </p>
        ) : showPhoneSubtitle ? null : (
          <p className="text-xs text-muted">{onAccept ? "Nova conversa" : "Em atendimento"}</p>
        )}

        <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
          <span className="inline-flex min-w-0 items-center gap-1 text-[11px] text-muted">
            {ChannelIcon ? (
              <ChannelIcon className="h-3 w-3 shrink-0" style={{ color: conversation.whatsappConnectionColor }} />
            ) : (
              <span className="h-2 w-2 shrink-0 rounded-sm" style={{ backgroundColor: conversation.whatsappConnectionColor }} />
            )}
            <span className="truncate">{conversation.whatsappConnectionName}</span>
          </span>
          {!onAccept && !transferredOutView && <NoReturnBadge conversation={conversation} />}
          {conversation.transfer && (
            <span className="inline-flex items-center rounded-full bg-info-soft px-2 py-0.5 text-[10.5px] font-semibold text-info">
              {transferredOutView ? `para ${conversation.transfer.toAgentName}` : `de ${conversation.transfer.fromAgentName}`}
            </span>
          )}
          {connectionDisconnected && (
            <span className="inline-flex items-center rounded-full bg-danger-soft px-2 py-0.5 text-[10.5px] font-semibold text-danger">Conexão desconectada</span>
          )}
          {reminder && (
            <span
              className={clsx(
                "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10.5px] font-semibold",
                reminder.firedAt ? "animate-pulse bg-warning-soft text-warning" : "bg-warning-soft text-warning"
              )}
            >
              <AlarmClock className="h-3 w-3" />
              {reminder.firedAt ? "Retornar agora" : `Retornar ${shortReminderTime(reminder.remindAt)}`}
            </span>
          )}
          {conversation.startedOnDevice && (
            <span className="inline-flex items-center gap-1 rounded-full bg-surface-alt px-2 py-0.5 text-[10.5px] font-semibold text-muted" title="Começou no celular da conexão">
              <Smartphone className="h-3 w-3" /> Iniciada pelo celular
            </span>
          )}
          {hasDraft && (
            <span className="inline-flex items-center gap-1 rounded-full bg-surface-alt px-2 py-0.5 text-[10.5px] font-semibold text-muted">
              <PencilLine className="h-3 w-3" /> Rascunho
            </span>
          )}
          {noReply && (
            <span
              className={clsx(
                "inline-flex items-center rounded-full px-2 py-0.5 text-[10.5px] font-semibold",
                noReplyDanger ? "bg-danger-soft text-danger" : "bg-warning-soft text-warning"
              )}
            >
              sem resposta
            </span>
          )}
          {conversation.unreadCount > 0 && (
            <span className="ml-auto flex h-[18px] min-w-[18px] items-center justify-center rounded-full bg-primary px-1.5 text-[10px] font-bold text-primary-fg">
              {conversation.unreadCount > 99 ? "99+" : conversation.unreadCount}
            </span>
          )}
        </div>

        {onAccept && (
          <button
            onClick={(e) => {
              e.stopPropagation();
              onAccept();
            }}
            disabled={accepting || connectionDisconnected || agentPaused}
            title={
              agentPaused
                ? "Você está pausado — retome o atendimento para aceitar conversas"
                : connectionDisconnected
                  ? "Conexão desconectada — não é possível aceitar conversas"
                  : undefined
            }
            className="focus-ring mt-2 w-full rounded-lg bg-primary py-1.5 text-xs font-semibold text-primary-fg disabled:opacity-60"
          >
            {accepting ? "Aceitando..." : agentPaused ? "Você está pausado" : connectionDisconnected ? "Conexão desconectada" : "Aceitar"}
          </button>
        )}
      </div>
    </div>
  );
}
