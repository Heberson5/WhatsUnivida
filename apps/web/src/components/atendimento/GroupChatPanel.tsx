import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useInfiniteQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { ArrowLeft, Bell, BellOff, Eye, History, Loader2, PanelRight, Users } from "lucide-react";
import clsx from "clsx";
import { PERMISSION, type GroupListItemDTO, type GroupParticipantDTO, type MessageDTO, type PaginatedResult } from "@whatsatendende/types";
import { api, getApiErrorMessage } from "../../lib/api";
import { useAuthStore } from "../../store/auth-store";
import { getSocket } from "../../lib/socket";
import { customerTypingLabel, useTypingStore } from "../../store/typing-store";
import { initials, seenByLabel, upToDateReaders } from "../../lib/groups";
import { MessageBubble } from "./MessageBubble";
import { Composer, type ComposerMentions } from "./Composer";
import { TimelineByDay, type TimelineEntry } from "./TimelineByDay";

/** An open WhatsApp group: its messages, the team's reading, and the reply box (with "Responder em grupos"). */
export function GroupChatPanel({
  group,
  onBack,
  infoPanelOpen,
  onToggleInfoPanel,
}: {
  group: GroupListItemDTO;
  onBack?: () => void;
  infoPanelOpen?: boolean;
  onToggleInfoPanel?: () => void;
}) {
  const queryClient = useQueryClient();
  const canReply = Boolean(useAuthStore((s) => s.permissions?.[PERMISSION.ATENDIMENTO_GRUPOS_RESPONDER]));
  const [replyTo, setReplyTo] = useState<MessageDTO | null>(null);
  // Where *this* person had stopped when they opened the group — kept while it stays open, so the
  // "não lidas" cut doesn't jump away the moment the reading is saved.
  const [opened] = useState(() => ({ unread: group.unreadCount, lastReadAt: group.myLastReadAt }));
  const scrollRef = useRef<HTMLDivElement>(null);

  // Newest 100 first; "Carregar mensagens anteriores" pages back through what's stored, then asks WhatsApp.
  const messagesQuery = useInfiniteQuery({
    queryKey: ["group-messages", group.id],
    queryFn: async ({ pageParam }) =>
      (await api.get<PaginatedResult<MessageDTO>>(`/groups/${group.id}/messages`, { params: { limit: 100, cursor: pageParam } })).data,
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
  // Set while older messages are being added at the top: the view keeps its place instead of jumping to the end.
  const keepPositionRef = useRef<number | null>(null);
  const [askingWhatsApp, setAskingWhatsApp] = useState(false);
  const accessToken = useAuthStore((s) => s.accessToken);

  const olderHistory = useMutation({
    mutationFn: () => api.post(`/groups/${group.id}/older-history`),
    onSuccess: () => setAskingWhatsApp(true),
    onError: (err) => toast.error(getApiErrorMessage(err)),
  });
  async function loadOlder() {
    keepPositionRef.current = scrollRef.current?.scrollHeight ?? null;
    if (messagesQuery.hasNextPage) await messagesQuery.fetchNextPage();
    else olderHistory.mutate();
  }
  // What WhatsApp sends back arrives a moment later (group:history); nothing within 20 s means nothing came.
  useEffect(() => {
    if (!askingWhatsApp) return;
    const socket = getSocket();
    const onHistory = async (payload: { conversationId: string; count: number }) => {
      if (payload.conversationId !== group.id) return;
      setAskingWhatsApp(false);
      keepPositionRef.current = scrollRef.current?.scrollHeight ?? null;
      const refreshed = await messagesQuery.refetch();
      if (refreshed.data?.pages.at(-1)?.nextCursor) await messagesQuery.fetchNextPage();
      toast.success(payload.count === 1 ? "1 mensagem anterior carregada." : `${payload.count} mensagens anteriores carregadas.`);
    };
    socket?.on("group:history", onHistory);
    const timer = setTimeout(() => {
      setAskingWhatsApp(false);
      toast.info("O WhatsApp não enviou mensagens anteriores agora. Pode ser que o celular não tenha mais essas mensagens; tente de novo mais tarde.");
    }, 20_000);
    return () => {
      socket?.off("group:history", onHistory);
      clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [askingWhatsApp, group.id, accessToken]);

  const markRead = useMutation({
    mutationFn: () => api.post(`/groups/${group.id}/read`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["groups"] });
      queryClient.invalidateQueries({ queryKey: ["notifications"] });
    },
  });
  const pages = messagesQuery.data?.pages;
  const newestId = pages?.[0]?.items.at(-1)?.id;
  // Opening it, and every new message while it is open, is read by this person.
  useEffect(() => {
    markRead.mutate();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [group.id, newestId]);

  const muteMutation = useMutation({
    mutationFn: (muted: boolean) => (muted ? api.post(`/groups/${group.id}/mute`) : api.delete(`/groups/${group.id}/mute`)),
    onSuccess: (_res, muted) => {
      queryClient.invalidateQueries({ queryKey: ["groups"] });
      toast.success(muted ? "Grupo silenciado: sem avisos, mas as não lidas continuam contando." : "Avisos do grupo ligados de novo.");
    },
  });

  const afterSend = {
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["group-messages", group.id] });
      queryClient.invalidateQueries({ queryKey: ["groups"] });
    },
    onError: (err: unknown) => toast.error(getApiErrorMessage(err)),
  };
  const sendText = useMutation({
    mutationFn: (input: { body: string; replyToMessageId?: string } & Partial<ComposerMentions>) => api.post(`/groups/${group.id}/text`, input),
    ...afterSend,
  });
  // Same list (and cache) as the group's info panel — what "@" offers.
  const loadMentionCandidates = useCallback(
    () =>
      queryClient.fetchQuery({
        queryKey: ["group-participants", group.id],
        queryFn: async () => (await api.get<GroupParticipantDTO[]>(`/groups/${group.id}/participants`)).data,
      }),
    [queryClient, group.id]
  );
  const sendFile = useMutation({
    mutationFn: ({ file, caption }: { file: File; caption?: string }) => {
      const form = new FormData();
      form.append("file", file);
      if (caption) form.append("caption", caption);
      return api.post(`/groups/${group.id}/file`, form, { headers: { "Content-Type": "multipart/form-data" } });
    },
    ...afterSend,
  });
  const sendAudio = useMutation({
    mutationFn: (file: File) => {
      const form = new FormData();
      form.append("file", file);
      return api.post(`/groups/${group.id}/audio`, form, { headers: { "Content-Type": "multipart/form-data" } });
    },
    ...afterSend,
  });
  const sendLocation = useMutation({ mutationFn: (input: { latitude: number; longitude: number }) => api.post(`/groups/${group.id}/location`, input), ...afterSend });

  const messages = useMemo(() => [...(pages ?? [])].reverse().flatMap((p) => p.items), [pages]);
  const messageById = useMemo(() => new Map(messages.map((m) => [m.id, m])), [messages]);
  const firstUnreadId = useMemo(() => {
    if (opened.unread === 0) return null;
    // Read before: the cut goes right after where they stopped. Never opened: before the last N (their count).
    if (opened.lastReadAt) {
      const cutoff = new Date(opened.lastReadAt).getTime();
      return messages.find((m) => new Date(m.createdAt).getTime() > cutoff)?.id ?? null;
    }
    return messages[Math.max(0, messages.length - opened.unread)]?.id ?? null;
  }, [messages, opened]);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el || messages.length === 0) return;
    // Older messages were added above: stay on what was on screen.
    if (keepPositionRef.current !== null) {
      el.scrollTop += el.scrollHeight - keepPositionRef.current;
      keepPositionRef.current = null;
      return;
    }
    const divider = el.querySelector("[data-unread-divider]");
    // The day's pill sticks to the top: leave room for it above the "não lidas" cut.
    if (divider && opened.unread > 0 && !el.dataset.scrolled) {
      el.scrollTop += divider.getBoundingClientRect().top - el.getBoundingClientRect().top - 48;
      el.dataset.scrolled = "1";
    } else el.scrollTop = el.scrollHeight;
  }, [messages.length, newestId, opened.unread]);

  const timeline: TimelineEntry[] = messages.map((m) => ({
    key: m.id,
    at: new Date(m.createdAt).getTime(),
    node: (
      <>
        {m.id === firstUnreadId && (
          <div data-unread-divider className="flex items-center gap-3 py-1" role="separator" aria-label="Mensagens não lidas">
            <span className="h-px flex-1 bg-primary/30" />
            <span className="rounded-full bg-primary/10 px-3 py-0.5 text-[11.5px] font-semibold text-primary">
              {opened.unread} {opened.unread === 1 ? "mensagem não lida" : "mensagens não lidas"}
            </span>
            <span className="h-px flex-1 bg-primary/30" />
          </div>
        )}
        <MessageBubble
          message={m}
          repliedMessage={m.replyToMessageId ? messageById.get(m.replyToMessageId) : undefined}
          onReply={setReplyTo}
          readOnly={!canReply}
        />
      </>
    ),
  }));

  const seenBy = seenByLabel(group.readers);
  const upToDate = upToDateReaders(group.readers);
  const typingEntries = useTypingStore((s) => s.typing[group.id]);
  const participants = group.participantsCount ? `${group.participantsCount} participantes` : "participantes";
  const disconnected = group.whatsappConnectionStatus !== "CONNECTED";
  const typing = customerTypingLabel(typingEntries);

  return (
    <div className="relative flex h-full flex-col">
      {/* On a phone the actions go to a second row, right-aligned, so the group name gets the whole first row. */}
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border bg-surface px-2 py-3 sm:flex-nowrap sm:px-4">
        <div className="flex min-w-0 basis-full items-center gap-3 sm:basis-auto">
          {onBack && (
            <button onClick={onBack} className="focus-ring shrink-0 rounded-full p-1.5 text-muted hover:bg-surface-alt md:hidden" aria-label="Voltar para a lista de grupos">
              <ArrowLeft className="h-4 w-4" />
            </button>
          )}
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-secondary/25 text-secondary-fg">
            <Users className="h-5 w-5" />
          </div>
          <div className="min-w-0">
            <p className="truncate text-sm font-semibold">{group.name}</p>
            {typing ? (
              <p className={clsx("truncate text-xs font-semibold italic", typing.kind === "recording" ? "text-danger" : "text-success")}>{typing.text}</p>
            ) : (
              <p className="truncate text-xs text-muted">
                Grupo · {participants} · {group.whatsappConnectionName}
              </p>
            )}
          </div>
        </div>
        <div className="ms-auto flex shrink-0 items-center gap-2">
          <button
            onClick={onToggleInfoPanel}
            className="focus-ring flex items-center gap-1.5 rounded-card border border-border px-2 py-1 text-xs text-muted hover:bg-surface-alt"
            title="Quem da equipe já está em dia com este grupo"
          >
            <Eye className="h-3.5 w-3.5" />
            <span className="flex -space-x-1.5" aria-hidden>
              {upToDate.slice(0, 3).map((r) => (
                <span key={r.userId} className="flex h-5 w-5 items-center justify-center rounded-full border border-surface bg-primary/15 text-[8.5px] font-bold text-primary">
                  {initials(r.name)}
                </span>
              ))}
            </span>
            <span className="hidden max-w-[180px] truncate font-medium sm:inline">{seenBy ? seenBy.replace(/^Visto por /, "") : "Ninguém em dia"}</span>
          </button>
          <button
            onClick={() => muteMutation.mutate(!group.muted)}
            className={clsx(
              "focus-ring flex items-center rounded-card border p-1.5",
              group.muted ? "border-warning/40 bg-warning-soft text-warning" : "border-border text-muted hover:bg-surface-alt"
            )}
            aria-pressed={group.muted}
            aria-label={group.muted ? "Ligar os avisos deste grupo" : "Silenciar este grupo"}
            title={group.muted ? "Silenciado: clique para voltar a receber avisos" : "Silenciar avisos deste grupo (só para você)"}
          >
            {group.muted ? <BellOff className="h-3.5 w-3.5" /> : <Bell className="h-3.5 w-3.5" />}
          </button>
          {onToggleInfoPanel && (
            <button
              onClick={onToggleInfoPanel}
              className={clsx(
                "focus-ring flex items-center rounded-card border p-1.5",
                infoPanelOpen ? "border-primary/30 bg-primary/10 text-primary" : "border-border text-muted hover:bg-surface-alt"
              )}
              aria-pressed={infoPanelOpen}
              aria-label="Painel do grupo"
            >
              <PanelRight className="h-3.5 w-3.5" />
            </button>
          )}
        </div>
      </div>

      <div ref={scrollRef} className="flex-1 overflow-y-auto px-4 py-4">
        <div className="space-y-3">
          {messages.length > 0 && (
            <div className="flex justify-center">
              <button
                onClick={() => void loadOlder()}
                disabled={askingWhatsApp || olderHistory.isPending || messagesQuery.isFetchingNextPage}
                className="focus-ring flex items-center gap-1.5 rounded-full border border-border bg-surface px-3 py-1 text-xs font-medium text-muted shadow-sm hover:text-[var(--color-text)] disabled:opacity-70"
              >
                {askingWhatsApp || olderHistory.isPending || messagesQuery.isFetchingNextPage ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <History className="h-3.5 w-3.5" />
                )}
                {askingWhatsApp ? "Buscando no WhatsApp…" : "Carregar mensagens anteriores"}
              </button>
            </div>
          )}
          {messages.length === 0 && !messagesQuery.isLoading ? (
            <p className="py-10 text-center text-sm text-muted">Nenhuma mensagem neste grupo desde que os grupos foram ligados.</p>
          ) : (
            <TimelineByDay entries={timeline} />
          )}
        </div>
      </div>

      {canReply ? (
        <>
          <p className="border-t border-border bg-surface px-4 pt-2 text-[11.5px] text-muted">
            Sua mensagem vai para <span className="font-semibold text-[var(--color-text)]">todos os {participants}</span> do grupo, com o seu nome de exibição no início.
          </p>
          <Composer
            disabled={sendText.isPending || disconnected}
            replyTo={replyTo}
            onCancelReply={() => setReplyTo(null)}
            loadMentionCandidates={loadMentionCandidates}
            onSendText={async (body, replyToMessageId, mentions) => {
              await sendText.mutateAsync({ body, replyToMessageId, ...mentions });
              setReplyTo(null);
            }}
            onSendFile={async (file, caption) => {
              await sendFile.mutateAsync({ file, caption });
            }}
            onSendAudio={async (file) => {
              await sendAudio.mutateAsync(file);
            }}
            onSendLocation={async (latitude, longitude) => {
              await sendLocation.mutateAsync({ latitude, longitude });
            }}
          />
        </>
      ) : (
        <p className="border-t border-border bg-surface px-4 py-3 text-center text-xs text-muted">Você pode ler este grupo, mas não tem permissão para responder nele.</p>
      )}
    </div>
  );
}
