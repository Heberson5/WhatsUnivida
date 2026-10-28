import { PollCard } from "./PollCard";
import clsx from "clsx";
import { format } from "date-fns";
import { ptBR } from "date-fns/locale";
import { Calendar, Check, CheckCheck, Clock, ExternalLink, FileText, Forward, MapPin, MessageCircle, ReplyIcon, Smile, Trash2, User, X } from "lucide-react";
import type { MessageDTO, MessageAttachmentDTO } from "@whatsatendende/types";
import { useState } from "react";
import { firstUrl, renderWhatsAppFormatting } from "../../lib/whatsappFormatting";
import { withAuthToken } from "../../lib/api";
import { MediaLightbox, type LightboxMedia } from "./MediaLightbox";
import { DocumentAttachment } from "./DocumentPreview";
import { LinkPreviewCard } from "./LinkPreviewCard";
import { groupReactions } from "../../lib/reactions";

const QUICK_REACTIONS = ["👍", "❤️", "😂", "😮", "😢", "🙏"];

function StatusIcon({ status }: { status: MessageDTO["status"] }) {
  if (status === "PENDING") return <Clock className="h-3.5 w-3.5" />;
  if (status === "SENT") return <Check className="h-3.5 w-3.5" />;
  if (status === "DELIVERED") return <CheckCheck className="h-3.5 w-3.5" />;
  // Uses the theme's read-receipt color (secondary by default, or an
  // admin override — see Identidade Visual) instead of a hardcoded blue,
  // so it stays visible against whatever primary color is configured.
  if (status === "READ") return <CheckCheck className="h-3.5 w-3.5" style={{ color: "var(--color-read-receipt)" }} />;
  return <span className="text-red-400">!</span>;
}

function vcardName(vcard: string | undefined, fallback: string): string {
  const match = vcard?.match(/FN:(.+)/);
  return match?.[1]?.trim() || fallback;
}

/**
 * A vCard's TEL line looks like `TEL;type=CELL;waid=5511999998888:+55 11
 * 99999-8888` — `waid` (when present) is WhatsApp's own already-normalized
 * number, more reliable than re-parsing the free-form display value next
 * to it. Falls back to stripping non-digits from the TEL value itself for
 * a vCard that doesn't carry a waid (e.g. a contact shared from outside
 * WhatsApp's own address book picker).
 */
function vcardPhone(vcard: string | undefined): string | null {
  if (!vcard) return null;
  const waid = vcard.match(/waid=(\d+)/);
  if (waid) return waid[1];
  const tel = vcard.match(/TEL[^:\n]*:([^\n]+)/);
  if (!tel) return null;
  const digits = tel[1].replace(/\D/g, "");
  return digits || null;
}

function Attachment({
  att,
  onOpenMedia,
  onStartConversation,
}: {
  att: MessageAttachmentDTO;
  onOpenMedia: (media: LightboxMedia) => void;
  /** Starts a new conversation with a phone number found inside a received vCard — omitted (button hidden) in read-only views. */
  onStartConversation?: (phone: string, name: string) => void;
}) {
  if (att.kind === "IMAGE") {
    const src = withAuthToken(att.url);
    return (
      <button type="button" onClick={() => onOpenMedia({ url: src, kind: "IMAGE", fileName: att.fileName })} className="focus-ring block">
        <img src={src} alt={att.fileName} className="max-h-64 max-w-full cursor-zoom-in rounded object-cover" />
      </button>
    );
  }
  if (att.kind === "VIDEO" && att.isGif) {
    // A WhatsApp GIF is a short silent video: it plays by itself, in a loop, like in WhatsApp.
    const src = withAuthToken(att.url);
    return (
      <button type="button" onClick={() => onOpenMedia({ url: src, kind: "VIDEO", fileName: att.fileName })} className="focus-ring relative block overflow-hidden rounded">
        <video src={src} autoPlay loop muted playsInline className="max-h-64 max-w-full cursor-zoom-in rounded" aria-label="GIF" />
        <span className="pointer-events-none absolute left-1.5 top-1.5 rounded bg-black/60 px-1.5 py-0.5 text-[10px] font-bold text-white">GIF</span>
      </button>
    );
  }
  if (att.kind === "VIDEO") {
    const src = withAuthToken(att.url);
    return (
      <button
        type="button"
        onClick={() => onOpenMedia({ url: src, kind: "VIDEO", fileName: att.fileName })}
        className="focus-ring group relative block overflow-hidden rounded"
      >
        <video src={src} className="max-h-64 max-w-full rounded" />
        <div className="absolute inset-0 flex items-center justify-center bg-black/20 opacity-0 transition-opacity group-hover:opacity-100">
          <span className="rounded-full bg-black/60 px-3 py-1 text-xs text-white">Abrir</span>
        </div>
      </button>
    );
  }
  if (att.kind === "AUDIO") {
    return <audio src={withAuthToken(att.url)} controls className="w-full min-w-[220px]" />;
  }
  if (att.kind === "LOCATION" && att.latitude !== undefined && att.longitude !== undefined) {
    // No third-party static-map image here on purpose — that used to depend
    // on an external image host that can be blocked (corporate proxy,
    // ad/tracker blockers) or simply go down, silently leaving the whole
    // location bubble blank. Coordinates + a link to a real, live map is
    // slower to scan but never fails to render.
    return (
      <a
        href={`https://maps.google.com/?q=${att.latitude},${att.longitude}`}
        target="_blank"
        rel="noreferrer"
        className="flex items-center gap-2.5 rounded border border-black/10 bg-black/5 px-3 py-2.5 hover:bg-black/10"
      >
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-black/10">
          <MapPin className="h-4.5 w-4.5" />
        </span>
        <div className="min-w-0">
          <p className="text-sm font-medium">Localização compartilhada</p>
          <p className="text-xs opacity-75">
            {att.latitude.toFixed(5)}, {att.longitude.toFixed(5)} · Abrir no mapa
          </p>
        </div>
      </a>
    );
  }
  if (att.kind === "POLL") return <PollCard att={att} />;
  if (att.kind === "EVENT") {
    return (
      <div className="min-w-[220px] rounded border border-black/10 bg-black/5 px-3 py-2.5">
        <div className="mb-1 flex items-center gap-1.5 text-xs font-medium opacity-75">
          <Calendar className="h-3.5 w-3.5" /> Evento
        </div>
        <p className="text-sm font-medium">{att.eventName}</p>
        {att.eventStartAt && (
          <p className="mt-0.5 text-xs opacity-90">{format(new Date(att.eventStartAt), "EEEE, d 'de' MMMM 'às' HH:mm", { locale: ptBR })}</p>
        )}
        {att.eventDescription && <p className="mt-1 whitespace-pre-wrap text-xs opacity-90">{att.eventDescription}</p>}
        {att.latitude !== undefined && att.longitude !== undefined && (
          <a
            href={`https://maps.google.com/?q=${att.latitude},${att.longitude}`}
            target="_blank"
            rel="noreferrer"
            className="mt-1.5 flex items-center gap-1 text-xs font-medium underline opacity-90 hover:opacity-100"
          >
            <MapPin className="h-3 w-3" /> Ver localização
          </a>
        )}
        {att.eventJoinLink && (
          <a
            href={att.eventJoinLink}
            target="_blank"
            rel="noreferrer"
            className="focus-ring mt-2 flex w-full items-center justify-center gap-1.5 rounded border border-black/10 bg-black/5 py-1.5 text-xs font-medium hover:bg-black/10"
          >
            <ExternalLink className="h-3.5 w-3.5" /> Entrar
          </a>
        )}
      </div>
    );
  }
  if (att.kind === "CONTACT") {
    const name = vcardName(att.vcard, att.fileName);
    const phone = vcardPhone(att.vcard);
    return (
      <div className="min-w-[220px] rounded border border-black/10 bg-black/5 px-3 py-2">
        <div className="flex items-center gap-2">
          <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-black/10">
            <User className="h-4 w-4" />
          </span>
          <div className="min-w-0">
            <p className="truncate text-sm font-medium">{name}</p>
            <p className="text-xs opacity-75">{phone ?? "Contato"}</p>
          </div>
        </div>
        {onStartConversation && phone && (
          <button
            type="button"
            onClick={() => onStartConversation(phone, name)}
            className="focus-ring mt-2 flex w-full items-center justify-center gap-1.5 rounded border border-black/10 bg-black/5 py-1.5 text-xs font-medium hover:bg-black/10"
          >
            <MessageCircle className="h-3.5 w-3.5" /> Iniciar conversa
          </button>
        )}
      </div>
    );
  }
  // DOCUMENT (and any historical media without a downloaded binary — url is empty in that case)
  if (!att.url) {
    return (
      <div className="flex items-center gap-2 rounded border border-black/10 bg-black/5 px-3 py-2 text-xs opacity-75">
        <FileText className="h-4 w-4 shrink-0" /> Mídia de antes deste sistema acompanhar anexos
      </div>
    );
  }
  return <DocumentAttachment att={att} />;
}

const FORWARDABLE_TYPES = ["TEXT", "IMAGE", "VIDEO", "DOCUMENT", "AUDIO"];

export function MessageBubble({
  message,
  onReply,
  onReact,
  onDelete,
  onForward,
  onStartConversation,
  repliedMessage,
  onJumpToMessage,
  readOnly,
  canDelete,
  highlighted,
}: {
  message: MessageDTO;
  onReply: (message: MessageDTO) => void;
  /** Omitted where reactions aren't offered (WhatsApp groups). */
  onReact?: (message: MessageDTO, emoji: string) => void;
  onDelete?: (message: MessageDTO) => void;
  /** "Encaminhar" — omitted where forwarding isn't offered (groups, read-only views). */
  onForward?: (message: MessageDTO) => void;
  /** Starts a new conversation with a phone number found inside a received vCard attachment. Omitted in read-only views (Gestão). */
  onStartConversation?: (phone: string, name: string) => void;
  repliedMessage?: MessageDTO;
  /** Clicking the quote of a reply goes to the message it answers. */
  onJumpToMessage?: (messageId: string) => void;
  /** Gestão's oversight view: same bubble rendering as Atendimento, but no reply/react — gestores only watch. */
  readOnly?: boolean;
  /** ADMIN-only "excluir mensagem" affordance — local to this app, never touches WhatsApp. */
  canDelete?: boolean;
  /** The current match of an in-conversation search (see ChatPanel's search bar) — a ring around the bubble marks which one is selected. */
  highlighted?: boolean;
}) {
  const [showReactions, setShowReactions] = useState(false);
  const [showReactors, setShowReactors] = useState(false);
  const [openMedia, setOpenMedia] = useState<LightboxMedia | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const isOutbound = message.direction === "OUTBOUND";

  const bubble = (
    <div
      className={clsx(
        // Same bubbles as the chat interno: rounder, the corner toward the sender squarer, on the dotted wallpaper.
        "chat-pop relative max-w-[70%] rounded-2xl px-3 py-2 text-sm shadow-sm transition-shadow",
        isOutbound ? "rounded-br-md bg-primary text-primary-fg" : "rounded-bl-md bg-surface",
        highlighted && "ring-2 ring-yellow-400 ring-offset-2 ring-offset-[var(--color-bg)]"
      )}
    >
      {!isOutbound && message.senderParticipant && (
        <p className="mb-0.5 text-xs font-bold" style={{ color: message.senderParticipant.color }}>
          {message.senderParticipant.name}
          {message.senderParticipant.phone && message.senderParticipant.name !== `+${message.senderParticipant.phone}` && (
            <span className="ml-1.5 font-normal text-muted">+{message.senderParticipant.phone}</span>
          )}
        </p>
      )}
      {isOutbound && message.senderAgentDisplayName && (
        <>
          <p className="text-xs font-bold opacity-90">{message.senderAgentDisplayName}</p>
          {/* Blank line separating the agent's name from the message itself (never part of the text sent to WhatsApp). */}
          <div className="h-3" aria-hidden="true" />
        </>
      )}

      {message.forwarded && (
        <p className="mb-0.5 flex items-center gap-1 text-[11px] italic opacity-75">
          <Forward className="h-3 w-3" /> Encaminhada
        </p>
      )}

      {repliedMessage && (
        <button
          type="button"
          onClick={() => onJumpToMessage?.(repliedMessage.id)}
          disabled={!onJumpToMessage}
          title={onJumpToMessage ? "Ir para a mensagem respondida" : undefined}
          className="focus-ring mb-1.5 block w-full rounded border-s-2 border-secondary bg-black/10 px-2 py-1 text-start text-xs opacity-90 enabled:cursor-pointer enabled:hover:bg-black/15"
        >
          <p className="font-semibold">{repliedMessage.senderAgentDisplayName ?? repliedMessage.senderParticipant?.name ?? "Cliente"}</p>
          <p className="truncate">{repliedMessage.body ?? "Anexo"}</p>
        </button>
      )}

      {/*
        A reply to a WhatsApp Status/Story rather than to another message
        here — the story itself was never fetched or stored (WhatsApp
        doesn't keep it once it expires), so this is a plain, non-clickable
        marker + the small preview WhatsApp embedded in the reply itself,
        same as WhatsApp Web shows it. Deliberately not a link/button:
        there is nowhere for it to navigate to.
      */}
      {message.replyToStory && (
        <div className="mb-1.5 flex items-center gap-2 rounded border-l-2 border-secondary bg-black/10 px-2 py-1 text-xs opacity-90">
          {message.replyToStory.thumbnailUrl && (
            <img src={message.replyToStory.thumbnailUrl} alt="" className="h-8 w-8 shrink-0 rounded object-cover" />
          )}
          <div className="min-w-0">
            <p className="font-semibold">Respondeu a um status</p>
            {message.replyToStory.text && <p className="truncate">{message.replyToStory.text}</p>}
          </div>
        </div>
      )}

      {message.attachments.map((att) => (
        <div key={att.id} className="mb-1.5">
          <Attachment att={att} onOpenMedia={setOpenMedia} onStartConversation={readOnly ? undefined : onStartConversation} />
        </div>
      ))}

      {/* Link-preview card (WhatsApp Web parity) — above the text, same as WhatsApp Web itself; only present when a URL in the text actually resolved to Open Graph metadata — a plain/unfetchable link still renders clickable via renderWhatsAppFormatting below, just without this card. */}
      {message.linkPreview && (
        <a
          href={message.linkPreview.url || undefined}
          target="_blank"
          rel="noreferrer"
          className="mb-1.5 flex overflow-hidden rounded border border-black/10 bg-black/5 hover:bg-black/10"
        >
          {message.linkPreview.thumbnailUrl && (
            <img src={message.linkPreview.thumbnailUrl} alt="" className="h-16 w-16 shrink-0 object-cover" />
          )}
          <div className="min-w-0 px-2 py-1.5">
            <p className="truncate text-xs font-semibold">{message.linkPreview.title}</p>
            {message.linkPreview.description && <p className="line-clamp-2 text-xs opacity-75">{message.linkPreview.description}</p>}
            <p className="truncate text-[11px] opacity-60">{message.linkPreview.url}</p>
          </div>
        </a>
      )}

      {/* A link WhatsApp didn't attach a card to (typed by an agent here, or sent without one) still gets a preview, fetched by the server. */}
      {!message.linkPreview && message.body && !message.attachments.length && (() => {
        const url = firstUrl(message.body);
        return url ? <LinkPreviewCard url={url} /> : null;
      })()}

      {message.body && <p className="whitespace-pre-wrap break-words">{renderWhatsAppFormatting(message.body)}</p>}

      <div className={clsx("mt-1 flex items-center gap-1 text-[11px] opacity-75", isOutbound ? "justify-end" : "justify-start")}>
        <span>{format(new Date(message.createdAt), "HH:mm")}</span>
        {isOutbound && <StatusIcon status={message.status} />}
      </div>

      {message.reactions.length > 0 && (
        <div className="absolute -bottom-3 right-2 z-10">
          {/* Like WhatsApp Web: the emojis with how many used each; a click lists who reacted with what. */}
          <button
            type="button"
            onClick={() => setShowReactors((s) => !s)}
            aria-expanded={showReactors}
            aria-label="Ver quem reagiu"
            className="focus-ring flex gap-1 rounded-full border border-border bg-surface px-1.5 py-0.5 text-xs shadow hover:bg-surface-alt"
          >
            {groupReactions(message.reactions).map((group) => (
              <span key={group.emoji} title={group.names.join(", ")} data-testid="reaction-chip">
                {group.emoji}
                {group.count > 1 && <span className="ml-0.5 text-[10px] font-medium opacity-75">{group.count}</span>}
              </span>
            ))}
          </button>
          {showReactors && (
            <div
              role="dialog"
              aria-label="Reações"
              className={clsx(
                // Opens upward, over the message itself: below, the conversation's last message (the usual one) cut it off.
                "absolute bottom-full z-20 mb-1 w-56 rounded-card border border-border bg-surface p-2 text-sm text-[var(--color-text)] shadow-elevated",
                isOutbound ? "right-0" : "left-0"
              )}
            >
              <div className="mb-1 flex items-center justify-between px-1 text-xs text-muted">
                <span>
                  {message.reactions.length} {message.reactions.length === 1 ? "reação" : "reações"}
                </span>
                <button type="button" onClick={() => setShowReactors(false)} className="focus-ring rounded p-0.5 hover:bg-surface-alt" aria-label="Fechar reações">
                  <X className="h-3.5 w-3.5" />
                </button>
              </div>
              <ul className="max-h-56 overflow-y-auto">
                {message.reactions.map((reaction) => (
                  <li key={reaction.id} className="flex items-center gap-2 rounded px-1 py-1">
                    <span className="truncate flex-1">{reaction.userDisplayName}</span>
                    <span className="text-base leading-none">{reaction.emoji}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </div>
  );

  // WhatsApp Web puts the hover reply/react icons in the gutter beside the
  // bubble (toward the center of the conversation), not floating above it —
  // real flex siblings here instead of absolute-positioning over the bubble,
  // ordered so they land on the correct side for each direction.
  const actions = (
    <div className="flex shrink-0 items-center gap-0.5 self-center rounded-full border border-border bg-surface px-0.5 opacity-0 shadow-sm transition-opacity group-hover:opacity-100">
      <button onClick={() => onReply(message)} className="focus-ring rounded-full p-1.5 text-muted hover:bg-surface-alt hover:text-[var(--color-text)]" aria-label="Responder">
        <ReplyIcon className="h-3.5 w-3.5" />
      </button>
      {onForward && FORWARDABLE_TYPES.includes(message.type) && (
        <button onClick={() => onForward(message)} className="focus-ring rounded-full p-1.5 text-muted hover:bg-surface-alt hover:text-[var(--color-text)]" aria-label="Encaminhar" title="Encaminhar">
          <Forward className="h-3.5 w-3.5" />
        </button>
      )}
      {canDelete && onDelete && (
        <button
          onClick={() => setConfirmDelete(true)}
          className="focus-ring rounded-full p-1.5 text-muted hover:bg-surface-alt hover:text-red-600"
          aria-label="Excluir mensagem"
          title="Excluir mensagem (somente neste sistema)"
        >
          <Trash2 className="h-3.5 w-3.5" />
        </button>
      )}
      {onReact && (
        <div className="relative">
          <button
            onClick={() => setShowReactions((s) => !s)}
            className="focus-ring rounded-full p-1.5 text-muted hover:bg-surface-alt hover:text-[var(--color-text)]"
            aria-label="Reagir"
          >
            <Smile className="h-3.5 w-3.5" />
          </button>
          {showReactions && (
            <div
              className={clsx(
                "absolute top-8 z-10 flex gap-1 rounded-full border border-border bg-surface px-2 py-1 shadow-lg",
                isOutbound ? "right-0" : "left-0"
              )}
            >
              {QUICK_REACTIONS.map((emoji) => (
                <button
                  key={emoji}
                  onClick={() => {
                    onReact(message, emoji);
                    setShowReactions(false);
                  }}
                  className="focus-ring text-base transition-transform hover:scale-125"
                >
                  {emoji}
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );

  return (
    <>
      <div className={clsx("group flex items-end gap-1", isOutbound ? "justify-end" : "justify-start")}>
        {readOnly ? (
          bubble
        ) : isOutbound ? (
          <>
            {actions}
            {bubble}
          </>
        ) : (
          <>
            {bubble}
            {actions}
          </>
        )}
      </div>
      {openMedia && <MediaLightbox media={openMedia} onClose={() => setOpenMedia(null)} />}

      {confirmDelete && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-4">
          <div className="w-full max-w-sm rounded-card border border-border bg-surface p-5 shadow-elevated">
            <h2 className="text-base font-semibold">Excluir mensagem?</h2>
            <p className="mt-2 text-sm text-muted">
              A mensagem some apenas desta conversa neste sistema. O WhatsApp do cliente e qualquer outro
              aparelho conectado (celular, WhatsApp Web) não são afetados.
            </p>
            <div className="mt-4 flex gap-2">
              <button onClick={() => setConfirmDelete(false)} className="focus-ring flex-1 rounded-card border border-border py-2 text-sm">
                Cancelar
              </button>
              <button
                onClick={() => {
                  onDelete?.(message);
                  setConfirmDelete(false);
                }}
                className="focus-ring flex-1 rounded-card bg-red-600 py-2 text-sm font-semibold text-white hover:opacity-90"
              >
                Excluir
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
