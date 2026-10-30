import { useEffect, useState, type ReactNode } from "react";
import { format } from "date-fns";
import clsx from "clsx";
import {
  Ban,
  Check,
  CheckCheck,
  Copy,
  History,
  Info,
  Link2,
  MoreHorizontal,
  Pencil,
  Pin,
  Reply,
  Plus,
  SmilePlus,
  Timer,
  Trash2,
  Zap,
} from "lucide-react";
import { EmojiPickerDialog } from "../common/EmojiPicker";
import { CHAT_EDIT_WINDOW_MINUTES, chatDurationLabel, type ChatMessageDTO } from "@whatsatendende/types";
import { renderWhatsAppFormatting } from "../../lib/whatsappFormatting";
import { api } from "../../lib/api";
import { ChatAttachment } from "./ChatAttachment";
import { ChatAudioPlayer } from "./ChatAudioPlayer";
import { ChatPollCard } from "./ChatPollCard";
import { PersonAvatar, personColor } from "./ChatAvatar";

export const QUICK_REACTIONS = ["👍", "❤️", "😂", "😮", "😢", "🙏"];

export interface BubbleActions {
  onReply?: (m: ChatMessageDTO) => void;
  onReact?: (m: ChatMessageDTO, emoji: string | null) => void;
  onInfo?: (m: ChatMessageDTO) => void;
  onPin?: (m: ChatMessageDTO) => void;
  onEdit?: (m: ChatMessageDTO) => void;
  onDelete?: (m: ChatMessageDTO) => void;
  onVote?: (pollId: string, optionIds: string[]) => void;
  onOpenConversation?: (id: string) => void;
  onJumpTo?: (messageId: string) => void;
  /** Administrador: "Excluir mensagem", for good. */
  onErase?: (m: ChatMessageDTO) => void;
  /** Gestão: "Editada · ver versões". */
  onShowEdits?: (m: ChatMessageDTO) => void;
}

/** Bold "@Nome" inside the text, the rest with the WhatsApp formatting (*negrito*, _itálico_...). */
function MessageText({ body, mine }: { body: string; mine: boolean }) {
  const parts = body.split(/(@[\p{L}][\p{L}\d._-]*)/u);
  return (
    <p className="whitespace-pre-wrap break-words">
      {parts.map((part, i) =>
        part.startsWith("@") && i % 2 === 1 ? (
          <span key={i} className={clsx("font-bold", mine ? "text-secondary" : "text-primary")}>
            {part}
          </span>
        ) : (
          <span key={i}>{renderWhatsAppFormatting(part)}</span>
        )
      )}
    </p>
  );
}

/** The ring that empties until a temporary message disappears. */
function TempTimer({ expiresAt, ttlSeconds, ttlFromRead }: { expiresAt: string | null; ttlSeconds: number; ttlFromRead: boolean }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!expiresAt) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [expiresAt]);
  if (!expiresAt) {
    return (
      <span className="inline-flex items-center gap-0.5" title={`Some ${chatDurationLabel(ttlSeconds)} depois de lida`}>
        <Timer className="h-3 w-3" />
        {ttlFromRead ? "após ler" : ""}
      </span>
    );
  }
  const left = Math.max(0, new Date(expiresAt).getTime() - now);
  const share = Math.min(1, left / (ttlSeconds * 1000));
  const seconds = Math.ceil(left / 1000);
  const label = seconds >= 86400 ? `${Math.floor(seconds / 86400)}d` : seconds >= 3600 ? `${Math.floor(seconds / 3600)}h` : seconds >= 60 ? `${Math.floor(seconds / 60)}min` : `${seconds}s`;
  return (
    <span className="inline-flex items-center gap-1" title="Mensagem temporária">
      <span className="inline-block h-3 w-3 rounded-full" style={{ background: `conic-gradient(currentColor ${share * 360}deg, transparent 0)`, boxShadow: "inset 0 0 0 1px currentColor" }} />
      {label}
    </span>
  );
}

function Ticks({ status }: { status: ChatMessageDTO["status"] }) {
  if (status === "READ") return <CheckCheck className="h-3.5 w-3.5 text-[var(--color-read-receipt)]" aria-label="Lida" />;
  if (status === "DELIVERED") return <CheckCheck className="h-3.5 w-3.5 opacity-80" aria-label="Entregue" />;
  return <Check className="h-3.5 w-3.5 opacity-80" aria-label="Enviada" />;
}

function ViewOnceCard({ message, mine, oversight }: { message: ChatMessageDTO; mine: boolean; oversight: boolean }) {
  const [opened, setOpened] = useState<{ url: string; mime: string } | null>(null);
  const available = Boolean(message.attachment);
  async function open() {
    if (!message.attachment) return;
    const res = await api.get<Blob>(message.attachment.url, { responseType: "blob" });
    setOpened({ url: URL.createObjectURL(res.data), mime: message.attachment.mimeType });
  }
  const viewedBy = message.oversight?.viewedBy ?? [];
  return (
    <>
      <button
        type="button"
        onClick={open}
        disabled={!available || (!mine && message.viewedByMe)}
        className="flex min-w-[210px] items-center gap-3 rounded-xl border border-dashed border-current px-3 py-2 text-left enabled:hover:bg-black/5"
      >
        <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full border-2 border-current text-xs font-black">1</span>
        <span className="min-w-0">
          <span className="block truncate text-sm font-semibold">{mine || oversight ? (message.attachment?.name ?? "Arquivo") : message.viewedByMe ? "Aberta" : "Toque para abrir"}</span>
          <span className="block text-[11px] opacity-80">
            Visualização única{oversight && viewedBy.length ? ` · aberta por ${viewedBy.map((v) => `${v.name} às ${format(new Date(v.at), "HH:mm")}`).join(", ")}` : ""}
          </span>
        </span>
      </button>
      {opened && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/85 p-6" onClick={() => (URL.revokeObjectURL(opened.url), setOpened(null))}>
          {opened.mime.startsWith("image/") ? (
            <img src={opened.url} alt="" className="max-h-full max-w-full rounded-lg object-contain" />
          ) : opened.mime.startsWith("video/") ? (
            <video src={opened.url} controls autoPlay className="max-h-full max-w-full rounded-lg" />
          ) : (
            <iframe src={opened.url} title="Arquivo" className="h-full w-full rounded-lg bg-white" />
          )}
          <p className="absolute bottom-4 left-0 right-0 text-center text-xs text-white/80">Visualização única: ao fechar, não abre de novo. Clique para fechar.</p>
        </div>
      )}
    </>
  );
}

function SystemLine({ children, tone = "muted" }: { children: ReactNode; tone?: "muted" | "warning" }) {
  return (
    <div className="flex justify-center py-1">
      <span
        className={clsx(
          "inline-flex max-w-[90%] items-center gap-1.5 rounded-full px-3 py-1 text-center text-[11.5px]",
          tone === "warning" ? "bg-warning-soft font-semibold text-warning" : "bg-surface/80 text-muted shadow-sm"
        )}
      >
        {children}
      </span>
    </div>
  );
}

/**
 * One message of the chat interno. `first`/`last` say where it sits in a run of messages from the same person:
 * the name goes on the first, the photo and the bubble's tail on the last.
 */
export function ChatMessageBubble({
  message,
  mine,
  meId,
  first,
  last,
  readOnly,
  oversight,
  canPin,
  highlighted,
  actions,
}: {
  message: ChatMessageDTO;
  mine: boolean;
  meId: string | null;
  first: boolean;
  last: boolean;
  readOnly?: boolean;
  oversight?: boolean;
  canPin?: boolean;
  highlighted?: boolean;
  actions: BubbleActions;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [allEmojis, setAllEmojis] = useState(false);
  const eraseButton = actions.onErase && (
    <button type="button" onClick={() => actions.onErase!(message)} className="inline-flex items-center gap-0.5 rounded-full bg-danger-soft px-1.5 font-semibold text-danger" title="Excluir mensagem definitivamente">
      <Trash2 className="h-3 w-3" /> Excluir
    </button>
  );
  const time = format(new Date(message.createdAt), "HH:mm");

  if (!message.authorId) {
    return (
      <SystemLine>
        {message.body}
        {oversight && ` · ${format(new Date(message.createdAt), "dd/MM HH:mm")}`}
        {eraseButton}
      </SystemLine>
    );
  }
  if (message.kind === "NUDGE") {
    // Gestão reads it with the names, whoever it is "seen as".
    const text = oversight
      ? `${message.authorName} chamou a atenção de ${message.nudgeTargetName}`
      : message.nudgeTargetId === meId
        ? `${message.authorName} chamou sua atenção!`
        : mine
          ? `Você chamou a atenção de ${message.nudgeTargetName}`
          : `${message.authorName} chamou a atenção de ${message.nudgeTargetName}`;
    return (
      <SystemLine tone="warning">
        <Zap className="h-3.5 w-3.5" />
        {text} · {time}
        {eraseButton}
      </SystemLine>
    );
  }

  const deleted = Boolean(message.deletedAt);
  const expired = Boolean(message.oversight?.expired);
  const erased = deleted && !message.body && !message.attachment && !message.poll;
  const deletable = mine && !deleted && !readOnly;
  const editable = mine && !deleted && !readOnly && Date.now() - new Date(message.createdAt).getTime() < CHAT_EDIT_WINDOW_MINUTES * 60_000;
  const showFile = message.attachment && !message.viewOnce && message.kind !== "AUDIO";

  return (
    <div id={`chat-msg-${message.id}`} className={clsx("group/msg chat-pop", highlighted && "rounded-xl bg-secondary/25 transition-colors")}>
      <div className={clsx("flex items-end gap-2", mine ? "justify-end" : "justify-start", last ? "mb-1.5" : "mb-0.5")}>
        {!mine && <span className="w-7 shrink-0">{last && <PersonAvatar name={message.authorName ?? "?"} photoUrl={null} id={message.authorId} size="sm" />}</span>}
        <div className={clsx("relative max-w-[78%]", mine && "order-1")}>
          {!readOnly && !deleted && (
            <div
              className={clsx(
                "absolute -top-4 z-10 hidden items-center gap-0.5 rounded-full border border-border bg-surface px-1 py-0.5 text-muted shadow-elevated group-hover/msg:flex",
                mine ? "right-2" : "left-2",
                (menuOpen || pickerOpen || allEmojis) && "!flex"
              )}
            >
              {QUICK_REACTIONS.slice(0, 3).map((e) => (
                <button key={e} type="button" onClick={() => actions.onReact?.(message, e)} className="rounded-full px-1 text-sm hover:bg-surface-alt" aria-label={`Reagir com ${e}`}>
                  {e}
                </button>
              ))}
              <button type="button" onClick={() => setPickerOpen((v) => !v)} className="rounded-full p-1 hover:bg-surface-alt" aria-label="Mais reações">
                <SmilePlus className="h-3.5 w-3.5" />
              </button>
              <button type="button" onClick={() => actions.onReply?.(message)} className="rounded-full p-1 hover:bg-surface-alt" aria-label="Responder" title="Responder">
                <Reply className="h-3.5 w-3.5" />
              </button>
              <button type="button" onClick={() => setMenuOpen((v) => !v)} className="rounded-full p-1 hover:bg-surface-alt" aria-label="Mais opções">
                <MoreHorizontal className="h-3.5 w-3.5" />
              </button>
              {pickerOpen && (
                <div className={clsx("absolute top-7 flex gap-0.5 rounded-full border border-border bg-surface px-1.5 py-1 shadow-elevated", mine ? "right-0" : "left-0")}>
                  {QUICK_REACTIONS.map((e) => (
                    <button key={e} type="button" onClick={() => (actions.onReact?.(message, e), setPickerOpen(false))} className="rounded-full px-1 text-lg hover:bg-surface-alt">
                      {e}
                    </button>
                  ))}
                  <button type="button" onClick={() => (setAllEmojis(true), setPickerOpen(false))} className="rounded-full p-1 hover:bg-surface-alt" aria-label="Mais emojis" title="Mais emojis">
                    <Plus className="h-4 w-4" />
                  </button>
                </div>
              )}
              {allEmojis && (
                <EmojiPickerDialog
                  onClose={() => setAllEmojis(false)}
                  onPick={(e) => {
                    actions.onReact?.(message, e);
                    setAllEmojis(false);
                  }}
                />
              )}
              {menuOpen && (
                <div className={clsx("absolute top-7 w-48 rounded-xl border border-border bg-surface p-1 text-sm text-[var(--color-text)] shadow-elevated", mine ? "right-0" : "left-0")} onMouseLeave={() => setMenuOpen(false)}>
                  <MenuItem icon={<Reply className="h-4 w-4" />} onClick={() => (actions.onReply?.(message), setMenuOpen(false))}>
                    Responder
                  </MenuItem>
                  {message.body && (
                    <MenuItem icon={<Copy className="h-4 w-4" />} onClick={() => (navigator.clipboard?.writeText(message.body ?? "").catch(() => undefined), setMenuOpen(false))}>
                      Copiar texto
                    </MenuItem>
                  )}
                  {mine && (
                    <MenuItem icon={<Info className="h-4 w-4" />} onClick={() => (actions.onInfo?.(message), setMenuOpen(false))}>
                      Dados da mensagem
                    </MenuItem>
                  )}
                  {canPin && (
                    <MenuItem icon={<Pin className="h-4 w-4" />} onClick={() => (actions.onPin?.(message), setMenuOpen(false))}>
                      Fixar
                    </MenuItem>
                  )}
                  {editable && message.kind === "TEXT" && (
                    <MenuItem icon={<Pencil className="h-4 w-4" />} onClick={() => (actions.onEdit?.(message), setMenuOpen(false))}>
                      Editar
                    </MenuItem>
                  )}
                  {deletable && (
                    <MenuItem danger icon={<Trash2 className="h-4 w-4" />} onClick={() => (actions.onDelete?.(message), setMenuOpen(false))}>
                      Apagar para todos
                    </MenuItem>
                  )}
                </div>
              )}
            </div>
          )}
          <div
            className={clsx(
              "space-y-1 rounded-2xl px-3 py-1.5 text-sm shadow-sm",
              mine ? "bg-primary text-primary-fg" : "bg-surface text-[var(--color-text)]",
              last && (mine ? "rounded-br-md" : "rounded-bl-md"),
              (expired || (oversight && deleted)) && "opacity-75"
            )}
          >
            {!mine && first && (
              <p className="text-xs font-bold" style={{ color: personColor(message.authorId) }}>
                {message.authorName}
              </p>
            )}
            {message.replyTo && (
              <button
                type="button"
                onClick={() => actions.onJumpTo?.(message.replyTo!.id)}
                className={clsx("block w-full rounded-lg border-l-[3px] px-2 py-1 text-left text-xs", mine ? "border-secondary bg-white/15" : "border-primary bg-surface-alt")}
              >
                <b className="block">{message.replyTo.authorName ?? "Sistema"}</b>
                <span className="line-clamp-2 opacity-90">{message.replyTo.preview}</span>
              </button>
            )}
            {deleted && (!oversight || erased) ? (
              <p className="flex items-center gap-1.5 italic opacity-80">
                <Ban className="h-3.5 w-3.5" /> Mensagem apagada
              </p>
            ) : (
              <>
                {message.kind === "AUDIO" && message.attachment && message.audio && (
                  <ChatAudioPlayer url={message.attachment.url} durationMs={message.audio.durationMs} waveform={message.audio.waveform} mine={mine} />
                )}
                {message.viewOnce && <ViewOnceCard message={message} mine={mine} oversight={Boolean(oversight)} />}
                {showFile && <ChatAttachment attachment={message.attachment!} />}
                {message.poll && <ChatPollCard poll={message.poll} mine={mine} readOnly={readOnly} onVote={(ids) => actions.onVote?.(message.poll!.id, ids)} />}
                {message.body && message.kind !== "POLL" && (
                  <div className={clsx(oversight && deleted && "line-through")}>
                    <MessageText body={message.body} mine={mine} />
                  </div>
                )}
                {message.conversation && (
                  <button
                    type="button"
                    onClick={() => actions.onOpenConversation?.(message.conversation!.id)}
                    disabled={!actions.onOpenConversation}
                    className="flex w-full min-w-[220px] items-center gap-2 rounded-xl border border-border bg-surface px-2.5 py-2 text-left text-[var(--color-text)] enabled:hover:bg-surface-alt"
                  >
                    <Link2 className="h-4 w-4 shrink-0 text-primary" />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[13px] font-bold">{message.conversation.contactName}</span>
                      <span className="block text-[11px] text-muted">Conversa de cliente citada</span>
                    </span>
                    {actions.onOpenConversation && <span className="rounded-full bg-primary/10 px-2.5 py-1 text-xs font-bold text-primary">Abrir</span>}
                  </button>
                )}
              </>
            )}
            <p className="flex flex-wrap items-center justify-end gap-x-1.5 gap-y-0.5 text-[10.5px] opacity-80">
              {oversight && expired && <Badge tone="warning">Temporária · sumiu {message.expiresAt && format(new Date(message.expiresAt), "dd/MM HH:mm:ss")}</Badge>}
              {oversight && !expired && message.ttlSeconds && <Badge tone="warning">Temporária · {chatDurationLabel(message.ttlSeconds)}</Badge>}
              {oversight && deleted && <Badge tone="danger">{erased ? "Excluída pelo administrador" : "Apagada por quem enviou"} · {format(new Date(message.deletedAt!), "dd/MM HH:mm")}</Badge>}
              {eraseButton}
              {!oversight && message.ttlSeconds && !deleted && <TempTimer expiresAt={message.expiresAt} ttlSeconds={message.ttlSeconds} ttlFromRead={message.ttlFromRead} />}
              {message.editedAt &&
                (oversight && actions.onShowEdits ? (
                  <button type="button" onClick={() => actions.onShowEdits!(message)} className="inline-flex items-center gap-0.5 rounded-full bg-info-soft px-1.5 font-semibold text-info">
                    <History className="h-3 w-3" /> Editada · ver versões
                  </button>
                ) : (
                  <span className="italic">editada</span>
                ))}
              <span>{oversight ? format(new Date(message.createdAt), "dd/MM HH:mm") : time}</span>
              {(mine || oversight) && <Ticks status={message.status} />}
            </p>
          </div>
          {message.reactions.length > 0 && (
            <div className={clsx("-mt-1.5 flex flex-wrap gap-1 px-2", mine ? "justify-end" : "justify-start")}>
              {message.reactions.map((r) => (
                <button
                  key={r.emoji}
                  type="button"
                  disabled={readOnly}
                  onClick={() => actions.onReact?.(message, r.mine ? null : r.emoji)}
                  title={r.names.join(", ")}
                  className={clsx(
                    "inline-flex items-center gap-1 rounded-full border bg-surface px-1.5 py-px text-xs shadow-sm",
                    r.mine ? "border-primary bg-primary/10" : "border-border"
                  )}
                >
                  {r.emoji}
                  {r.count > 1 && <b className="text-[10.5px] text-muted">{r.count}</b>}
                </button>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function Badge({ tone, children }: { tone: "warning" | "danger"; children: ReactNode }) {
  return <span className={clsx("rounded-full px-1.5 font-semibold", tone === "warning" ? "bg-warning-soft text-warning" : "bg-danger-soft text-danger")}>{children}</span>;
}

function MenuItem({ icon, children, onClick, danger }: { icon: ReactNode; children: ReactNode; onClick: () => void; danger?: boolean }) {
  return (
    <button type="button" onClick={onClick} className={clsx("flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left hover:bg-surface-alt", danger && "text-danger")}>
      {icon}
      {children}
    </button>
  );
}

