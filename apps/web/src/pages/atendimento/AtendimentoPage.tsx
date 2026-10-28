import { useEffect, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import clsx from "clsx";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { MessagesSquare, Plus, Radio, Search } from "lucide-react";
import { PERMISSION, type ConversationListItemDTO, type GroupListItemDTO } from "@whatsatendende/types";
import { api, getApiErrorMessage } from "../../lib/api";
import { ConversationCard, minutesWaiting } from "../../components/atendimento/ConversationCard";
import { useAlertThresholds } from "../../hooks/useAlertThresholds";
import { ClientPanel } from "../../components/atendimento/ClientPanel";
import { ResizableSidePanel } from "../../components/atendimento/ResizableSidePanel";
import { contactDisplayName } from "../../lib/contact-display";
import { useNow } from "../../hooks/useNow";
import { ChatPanel } from "../../components/atendimento/ChatPanel";
import { ReadOnlyConversationDrawer } from "../../components/gestao/ReadOnlyConversationDrawer";
import { ConnectionFilter } from "../../components/common/ConnectionFilter";
import { NovaConversaModal } from "../../components/atendimento/NovaConversaModal";
import { useActiveConversationStore } from "../../store/active-conversation-store";
import { useAuthStore } from "../../store/auth-store";
import { GroupCard } from "../../components/atendimento/GroupCard";
import { GroupChatPanel } from "../../components/atendimento/GroupChatPanel";
import { GroupInfoPanel } from "../../components/atendimento/GroupInfoPanel";
import { useActiveGroupStore } from "../../store/active-group-store";
import { MyDayStrip } from "../../components/atendimento/MyDayStrip";
import { ShortcutsHelp } from "../../components/atendimento/ShortcutsHelp";
import { useAgentExtras } from "../../hooks/useAgentExtras";
import { useDraftStore } from "../../store/draft-store";
import { useNoReturnWarnings } from "../../components/atendimento/NoReturn";

const CLIENT_PANEL_KEY = "client-panel-collapsed";
// Below this width the chat needs the room, so the panel starts collapsed.
const CLIENT_PANEL_AUTO_COLLAPSE_PX = 1280;
// Below Tailwind's md breakpoint there is no third column: the client/group panel opens full screen instead.
const SIDE_PANEL_MEDIA = "(min-width: 768px)";

function readClientPanelCollapsed() {
  try {
    const stored = localStorage.getItem(CLIENT_PANEL_KEY);
    if (stored !== null) return stored === "1";
  } catch {
    // storage blocked: fall back to the screen-size default
  }
  return window.innerWidth < CLIENT_PANEL_AUTO_COLLAPSE_PX;
}

type ListFilter = "all" | "unread" | "noReply";

export default function AtendimentoPage() {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [tab, setTab] = useState<"queue" | "mine" | "transferred" | "groups" | "abandoned">("mine");
  const [selectedGroupId, setSelectedGroupId] = useState<string | null>(null);
  const [connectionIds, setConnectionIds] = useState<string[]>([]);
  const [novaConversaOpen, setNovaConversaOpen] = useState(false);
  const [listSearch, setListSearch] = useState("");
  const [listFilter, setListFilter] = useState<ListFilter>("all");
  const [clientPanelCollapsed, setClientPanelCollapsed] = useState(readClientPanelCollapsed);
  const [mobileInfoOpen, setMobileInfoOpen] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const extras = useAgentExtras().data;
  const now = useNow();
  const { noReplyWarningMinutes } = useAlertThresholds();
  // Another conversation or group opened: back to the chat, not the previous one's panel.
  useEffect(() => setMobileInfoOpen(false), [selectedId, selectedGroupId, tab]);
  function toggleInfoPanel() {
    if (window.matchMedia(SIDE_PANEL_MEDIA).matches) toggleClientPanel();
    else setMobileInfoOpen((open) => !open);
  }
  function toggleClientPanel() {
    setClientPanelCollapsed((c) => {
      try {
        localStorage.setItem(CLIENT_PANEL_KEY, c ? "0" : "1");
      } catch {
        // storage blocked: the choice just won't persist
      }
      return !c;
    });
  }
  // A transferred-out conversation opens read-only (ReadOnlyConversationDrawer,
  // variant="inline") in the SAME right-column slot ChatPanel normally
  // fills — not a floating overlay like Gestão's own use of that
  // component — it's no longer this agent's to act on, only to watch. Kept
  // as a separate piece of state from selectedId (the two are mutually
  // exclusive, cleared of each other wherever either is set) rather than
  // reusing it, since a transferred-out row isn't in mineQuery's data at
  // all. See PROMPT: "possa abrir a conversa para acompanhar em tempo real
  // sem poder interferir" and "a tela de visualizar as conversas em Transf,
  // deve abrir normalmente... sem as funções de interagir, transferência e
  // encerramento".
  const [watchingConversation, setWatchingConversation] = useState<ConversationListItemDTO | null>(null);
  const queryClient = useQueryClient();
  const user = useAuthStore((s) => s.user);
  const setActiveConversationId = useActiveConversationStore((s) => s.setActiveConversationId);
  // AGENT always attends a single fixed connection — the server ignores
  // this filter for them anyway — so only MANAGER/ADMIN, who see every
  // connection's queue combined by default, get the filter UI at all.
  const canFilterByConnection = user?.role === "MANAGER" || user?.role === "ADMIN";
  const canSeeGroups = Boolean(useAuthStore((s) => s.permissions?.[PERMISSION.ATENDIMENTO_GRUPOS_VISUALIZAR]));
  const setActiveGroupId = useActiveGroupStore((s) => s.setActiveGroupId);
  const hasFixedConnection = Boolean(user?.whatsappConnectionName);

  // Realtime listening itself (toasts, desktop notifications, the socket
  // room join that keeps an open chat live) now lives in AppLayout so it
  // keeps working on every screen, not just this one — this just publishes
  // which conversation is currently open here so that global listener can
  // still skip the redundant toast for a message already visible live.
  // Cleared on unmount (leaving Atendimento entirely) so a stale id doesn't
  // keep suppressing that conversation's notifications from another page.
  useEffect(() => {
    setActiveConversationId(selectedId);
    return () => setActiveConversationId(null);
  }, [selectedId, setActiveConversationId]);

  const queueQuery = useQuery({
    queryKey: ["queue", connectionIds],
    queryFn: async () =>
      (
        await api.get<ConversationListItemDTO[]>("/conversations/queue", {
          params: { connectionId: canFilterByConnection && connectionIds.length ? connectionIds : undefined },
        })
      ).data,
    refetchInterval: 20_000,
  });

  const mineQuery = useQuery({
    queryKey: ["mine"],
    queryFn: async () => (await api.get<ConversationListItemDTO[]>("/conversations/mine")).data,
    refetchInterval: 20_000,
  });
  useNoReturnWarnings(mineQuery.data);

  // Deep link from the notification bell (?open=<conversationId>) — both
  // notification types (new message, transfer received) only ever point at
  // a conversation this agent already owns, so "Ativos" is always the
  // right place to select it. See PROMPT: "ao clicar em cima de alguma,
  // será direcionado para o local".
  const [searchParams, setSearchParams] = useSearchParams();
  useEffect(() => {
    const openId = searchParams.get("open");
    if (!openId || !mineQuery.data) return;
    if (mineQuery.data.some((c) => c.id === openId)) {
      setWatchingConversation(null);
      setSelectedId(openId);
      setTab("mine");
    }
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      next.delete("open");
      return next;
    }, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams, mineQuery.data]);

  // Drafts of conversations that left this list (closed, transferred away) aren't kept around.
  useEffect(() => {
    if (user?.id && mineQuery.data) useDraftStore.getState().prune(user.id, mineQuery.data.map((c) => c.id));
  }, [user?.id, mineQuery.data]);

  // WhatsApp groups (only on connections where an administrator turned them on) — each person's own unread counts.
  const groupsQuery = useQuery({
    queryKey: ["groups", connectionIds],
    queryFn: async () =>
      (await api.get<GroupListItemDTO[]>("/groups", { params: { connectionIds: canFilterByConnection && connectionIds.length ? connectionIds.join(",") : undefined } })).data,
    enabled: canSeeGroups,
    refetchInterval: 30_000,
  });
  const groups = groupsQuery.data ?? [];
  const selectedGroup = tab === "groups" ? (groups.find((g) => g.id === selectedGroupId) ?? null) : null;
  // The open group doesn't pop notices for its own messages (they're on screen).
  useEffect(() => {
    setActiveGroupId(selectedGroup?.id ?? null);
    return () => setActiveGroupId(null);
  }, [selectedGroup?.id, setActiveGroupId]);
  // Deep link from the bell / a notice: ?grupo=<id>.
  useEffect(() => {
    const groupId = searchParams.get("grupo");
    if (!groupId || !groupsQuery.data) return;
    if (groupsQuery.data.some((g) => g.id === groupId)) {
      setSelectedId(null);
      setWatchingConversation(null);
      setTab("groups");
      setSelectedGroupId(groupId);
    }
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      next.delete("grupo");
      return next;
    }, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams, groupsQuery.data]);

  const transferredOutQuery = useQuery({
    queryKey: ["transferred-out"],
    queryFn: async () => (await api.get<ConversationListItemDTO[]>("/conversations/transferred-out")).data,
    refetchInterval: 20_000,
  });

  // Abandonados: left by the Fluxo — the customer stopped answering its menus, or nobody of the transfer step was online.
  const abandonedQuery = useQuery({
    queryKey: ["abandoned", connectionIds],
    queryFn: async () =>
      (
        await api.get<ConversationListItemDTO[]>("/conversations/abandoned", {
          params: { connectionId: canFilterByConnection && connectionIds.length ? connectionIds : undefined },
        })
      ).data,
    refetchInterval: 30_000,
  });

  const acceptMutation = useMutation({
    mutationFn: (id: string) => api.post(`/conversations/${id}/accept`),
    onSuccess: (_res, id) => {
      queryClient.invalidateQueries({ queryKey: ["queue"] });
      queryClient.invalidateQueries({ queryKey: ["abandoned"] });
      queryClient.invalidateQueries({ queryKey: ["mine"] });
      setSelectedId(id);
      setTab("mine");
      toast.success("Conversa aceita. Ela agora é sua com exclusividade.");
    },
    onError: (err) => {
      toast.error(getApiErrorMessage(err, "Esta conversa já foi assumida por outro atendente."));
      queryClient.invalidateQueries({ queryKey: ["queue"] });
    },
  });

  const selectedConversation = mineQuery.data?.find((c) => c.id === selectedId) ?? null;
  // Highlights the Fila tab itself (not just its count) while there's at
  // least one conversation still waiting to be accepted — so an agent
  // parked on "Ativos" notices without having to switch tabs. Goes back to
  // the plain look the instant the queue empties out (accepted/transferred/
  // returned elsewhere), same as the count already does today. See PROMPT:
  // "destaque maior em filas... quando não tem conversas pendentes...
  // continue normalmente sem um destaque".
  const queueCount = queueQuery.data?.length ?? 0;
  const queueHasPending = queueCount > 0;

  const matchesSearch = (c: ConversationListItemDTO) => {
    const q = listSearch.trim().toLowerCase();
    if (!q) return true;
    return contactDisplayName(c.contact, c.channel).toLowerCase().includes(q) || (c.contact.phone ?? "").includes(q.replace(/\D/g, "") || q);
  };
  const mine = mineQuery.data ?? [];
  const unreadCount = mine.filter((c) => c.unreadCount > 0).length;
  const noReplyCount = mine.filter((c) => minutesWaiting(c, now) >= noReplyWarningMinutes).length;
  const pinnedIds = new Set(extras?.pinnedConversationIds ?? []);
  const reminderByConversation = new Map((extras?.reminders ?? []).map((r) => [r.conversationId, r]));
  const filteredMine = mine.filter(
    (c) =>
      matchesSearch(c) &&
      (listFilter === "all" || (listFilter === "unread" ? c.unreadCount > 0 : minutesWaiting(c, now) >= noReplyWarningMinutes))
  );
  const pinnedMine = filteredMine.filter((c) => pinnedIds.has(c.id));
  const otherMine = filteredMine.filter((c) => !pinnedIds.has(c.id));
  // The order on screen (pinned first) — what Alt+↓/↑ walks through.
  const visibleMine = [...pinnedMine, ...otherMine];
  const visibleQueue = (queueQuery.data ?? []).filter(matchesSearch);
  const abandoned = abandonedQuery.data ?? [];
  const visibleAbandoned = abandoned.filter(matchesSearch);
  // The tab shows up while someone is there (or it is open).
  const showAbandonedTab = abandoned.length > 0 || tab === "abandoned";
  const visibleTransferred = (transferredOutQuery.data ?? []).filter(matchesSearch);
  const panelConversation = tab === "groups" ? null : (selectedConversation ?? watchingConversation);
  const groupsWithUnread = groups.filter((g) => g.unreadCount > 0).length;
  const visibleGroups = groups.filter((g) => !listSearch.trim() || g.name.toLowerCase().includes(listSearch.trim().toLowerCase()));
  // The tab shows up once there's a group to see (an administrator turned groups on for a number this person attends).
  const showGroupsTab = canSeeGroups && (groups.length > 0 || tab === "groups");
  const chatOpen = tab === "groups" ? Boolean(selectedGroup) : Boolean(selectedConversation || watchingConversation);

  function renderMineCard(c: ConversationListItemDTO) {
    return (
      <ConversationCard
        key={c.id}
        conversation={c}
        selected={c.id === selectedId}
        pinned={pinnedIds.has(c.id)}
        reminder={reminderByConversation.get(c.id) ?? null}
        onSelect={() => {
          setWatchingConversation(null);
          setSelectedId((current) => (current === c.id ? null : c.id));
        }}
      />
    );
  }

  // List-level keyboard shortcuts (the open chat's own — Alt+N/T/E/L and "/" — live in ChatPanel).
  const shortcutState = { visibleMine, selectedId, firstQueued: visibleQueue[0], paused: user?.presence === "AWAY", accepting: acceptMutation.isPending, shortcutsOpen };
  const shortcutStateRef = useRef(shortcutState);
  shortcutStateRef.current = shortcutState;
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const state = shortcutStateRef.current;
      const target = e.target as HTMLElement;
      const typing = target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName);
      if (e.key === "?" && !typing && !state.shortcutsOpen) {
        e.preventDefault();
        setShortcutsOpen(true);
        return;
      }
      // Esc closes the open chat — unless something on top of it (a modal, a menu) is handling it.
      if (e.key === "Escape" && !typing && !state.shortcutsOpen && !document.querySelector("[role='dialog'], .drawer-backdrop, .fixed.inset-0")) {
        setSelectedId(null);
        setWatchingConversation(null);
        return;
      }
      if (!e.altKey || e.ctrlKey || e.metaKey) return;
      if (e.code === "ArrowDown" || e.code === "ArrowUp") {
        e.preventDefault();
        const list = state.visibleMine;
        if (!list.length) return;
        const index = list.findIndex((c) => c.id === state.selectedId);
        const step = e.code === "ArrowDown" ? 1 : -1;
        const next = index === -1 ? (step === 1 ? 0 : list.length - 1) : (index + step + list.length) % list.length;
        setTab("mine");
        setWatchingConversation(null);
        setSelectedId(list[next].id);
      } else if (e.code === "KeyA") {
        e.preventDefault();
        if (state.paused) toast.info("Você está pausado — retome o atendimento para aceitar conversas.");
        else if (!state.firstQueued) toast.info("Nenhuma conversa aguardando na fila.");
        else if (!state.accepting) acceptMutation.mutate(state.firstQueued.id);
      }
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const tabs = [
    { value: "mine" as const, label: "Meus", count: mine.length },
    { value: "queue" as const, label: "Fila", count: queueCount },
    { value: "transferred" as const, label: "Transf.", count: transferredOutQuery.data?.length ?? 0 },
    ...(showAbandonedTab ? [{ value: "abandoned" as const, label: "Aband.", count: abandoned.length }] : []),
    ...(showGroupsTab ? [{ value: "groups" as const, label: "Grupos", count: groupsWithUnread }] : []),
  ];
  const compactTabs = tabs.length >= 4;

  return (
    <div
      className={clsx(
        "grid h-full overflow-hidden",
        panelConversation || selectedGroup
          ? clientPanelCollapsed
            ? "md:grid-cols-[320px_1fr_auto]"
            : "md:grid-cols-[300px_minmax(0,1fr)_auto] xl:grid-cols-[320px_minmax(0,1fr)_auto]"
          : "md:grid-cols-[320px_1fr]"
      )}
    >
      <div
        className={clsx(
          "flex-col overflow-hidden border-r border-border bg-surface md:flex",
          chatOpen ? "hidden" : "flex"
        )}
      >
        {hasFixedConnection && user?.whatsappConnectionStatus !== "CONNECTED" && (
          <div className="border-b border-danger/20 bg-danger-soft px-3 py-2 text-xs font-medium text-danger">
            Sua conexão de WhatsApp está desconectada — não é possível enviar mensagens nem aceitar conversas até que ela seja reconectada. Avise um administrador.
          </div>
        )}
        <div className="space-y-2.5 border-b border-border px-3 pb-3 pt-3">
          <MyDayStrip onShowShortcuts={() => setShortcutsOpen(true)} />
          <div className="flex items-center gap-1.5">
            {canFilterByConnection ? (
              <div className="min-w-0 flex-1">
                <ConnectionFilter value={connectionIds} onChange={setConnectionIds} />
              </div>
            ) : (
              <span className="flex min-w-0 flex-1 items-center gap-1.5 truncate text-xs font-medium text-muted">
                <Radio className="h-3.5 w-3.5 shrink-0 text-primary" /> Conexão: {user?.whatsappConnectionName}
              </span>
            )}
            <button
              onClick={() => setNovaConversaOpen(true)}
              className="focus-ring flex shrink-0 items-center gap-1 rounded-lg bg-primary px-2.5 py-1.5 text-xs font-semibold text-primary-fg hover:opacity-90"
              title="Iniciar nova conversa a partir dos contatos do WhatsApp"
            >
              <Plus className="h-3.5 w-3.5" /> Nova conversa
            </button>
          </div>

          <div
            className={clsx(
              "grid rounded-[10px] border border-border bg-surface-alt p-[3px]",
              tabs.length === 5 ? "grid-cols-5" : tabs.length === 4 ? "grid-cols-4" : "grid-cols-3"
            )}
            role="tablist"
            aria-label="Conversas"
          >
            {tabs.map((t) => {
              const highlightQueue =
                (t.value === "queue" && queueHasPending) || (t.value === "groups" && groupsWithUnread > 0) || (t.value === "abandoned" && t.count > 0);
              return (
                <button
                  key={t.value}
                  role="tab"
                  aria-selected={tab === t.value}
                  onClick={() => setTab(t.value)}
                  className={clsx(
                    "focus-ring flex min-w-0 items-center justify-center rounded-[7px] py-1.5 font-medium transition-colors",
                    compactTabs ? "gap-1 text-[12px]" : "gap-1.5 text-[13px]",
                    tab === t.value ? "bg-surface font-semibold text-[var(--color-text)] shadow-sm" : "text-muted hover:text-[var(--color-text)]"
                  )}
                >
                  {t.label}
                  <span
                    className={clsx(
                      "rounded-full px-1.5 text-[11px] font-bold",
                      highlightQueue ? "animate-pulse bg-secondary text-secondary-fg" : "bg-border/70 text-muted"
                    )}
                  >
                    {t.count}
                  </span>
                </button>
              );
            })}
          </div>

          <label className="flex h-8 items-center gap-2 rounded-lg border border-border bg-surface px-2.5 text-xs text-muted focus-within:border-primary/50">
            <Search className="h-3.5 w-3.5 shrink-0" />
            <input
              value={listSearch}
              onChange={(e) => setListSearch(e.target.value)}
              placeholder="Buscar nome ou número"
              className="min-w-0 flex-1 bg-transparent text-[13px] text-[var(--color-text)] outline-none placeholder:text-muted"
              aria-label="Buscar conversas por nome ou número"
            />
          </label>

          {tab === "mine" && (
            <div className="flex flex-wrap gap-1.5">
              {(
                [
                  { value: "all", label: "Todas", count: mine.length },
                  { value: "unread", label: "Não lidas", count: unreadCount },
                  { value: "noReply", label: "Sem resposta", count: noReplyCount },
                ] as const
              ).map((f) => (
                <button
                  key={f.value}
                  onClick={() => setListFilter(f.value)}
                  aria-pressed={listFilter === f.value}
                  className={clsx(
                    "focus-ring rounded-full border px-2.5 py-0.5 text-[11.5px] font-medium",
                    listFilter === f.value ? "border-primary bg-primary/10 text-primary" : "border-border text-muted hover:text-[var(--color-text)]",
                    f.value === "noReply" && f.count > 0 && listFilter !== f.value && "border-warning/40 text-warning"
                  )}
                >
                  {f.label} · {f.count}
                </button>
              ))}
            </div>
          )}
        </div>

        <div className="flex-1 overflow-y-auto">
          {tab === "mine" &&
            (visibleMine.length ? (
              <>
                {pinnedMine.length > 0 && <SectionLabel>Fixadas</SectionLabel>}
                {pinnedMine.map(renderMineCard)}
                {pinnedMine.length > 0 && otherMine.length > 0 && <SectionLabel>Demais conversas</SectionLabel>}
                {otherMine.map(renderMineCard)}
              </>
            ) : (
              <EmptyState message={mine.length ? "Nenhuma conversa com esse filtro." : "Nenhum atendimento em andamento."} />
            ))}

          {tab === "queue" &&
            (visibleQueue.length ? (
              visibleQueue.map((c) => (
                <ConversationCard
                  key={c.id}
                  conversation={c}
                  onAccept={() => acceptMutation.mutate(c.id)}
                  accepting={acceptMutation.isPending && acceptMutation.variables === c.id}
                  agentPaused={user?.presence === "AWAY"}
                />
              ))
            ) : (
              <EmptyState message="Nenhuma conversa aguardando." />
            ))}

          {tab === "abandoned" && (
            <>
              <p className="border-b border-border bg-surface-alt px-3 py-1.5 text-[11px] text-muted">
                Clientes que pararam de responder os menus do fluxo, ou que chegaram quando ninguém do passo estava online. Ao aceitar, uma nota explica o motivo.
              </p>
              {visibleAbandoned.length ? (
                visibleAbandoned.map((c) => (
                  <ConversationCard
                    key={c.id}
                    conversation={c}
                    onAccept={() => acceptMutation.mutate(c.id)}
                    accepting={acceptMutation.isPending && acceptMutation.variables === c.id}
                    agentPaused={user?.presence === "AWAY"}
                  />
                ))
              ) : (
                <EmptyState message="Nenhum cliente em Abandonados." />
              )}
            </>
          )}

          {tab === "groups" &&
            (visibleGroups.length ? (
              visibleGroups.map((g) => <GroupCard key={g.id} group={g} selected={g.id === selectedGroupId} onSelect={() => setSelectedGroupId(g.id === selectedGroupId ? null : g.id)} />)
            ) : (
              <EmptyState message={groups.length ? "Nenhum grupo com esse nome." : "Nenhum grupo nas conexões que você atende."} />
            ))}

          {tab === "transferred" &&
            (visibleTransferred.length ? (
              visibleTransferred.map((c) => (
                <ConversationCard
                  key={c.id}
                  conversation={c}
                  transferredOutView
                  selected={c.id === watchingConversation?.id}
                  onSelect={() => {
                    setSelectedId(null);
                    setWatchingConversation(c);
                  }}
                />
              ))
            ) : (
              <EmptyState message="Você ainda não transferiu nenhuma conversa." />
            ))}
        </div>
      </div>

      <div className={clsx("min-w-0 overflow-hidden bg-[var(--color-bg)]", chatOpen ? "block" : "hidden md:block")}>
        {tab === "groups" ? (
          selectedGroup ? (
            <GroupChatPanel
              key={selectedGroup.id}
              group={selectedGroup}
              onBack={() => setSelectedGroupId(null)}
              infoPanelOpen={!clientPanelCollapsed}
              onToggleInfoPanel={toggleInfoPanel}
            />
          ) : (
            <div className="flex h-full flex-col items-center justify-center gap-2 text-sm text-muted">
              <MessagesSquare className="h-10 w-10 opacity-30" />
              Selecione um grupo para ver as mensagens
            </div>
          )
        ) : selectedConversation ? (
          <ChatPanel
            conversation={selectedConversation}
            onClosed={() => setSelectedId(null)}
            onBack={() => setSelectedId(null)}
            onConversationStarted={(conv) => {
              queryClient.invalidateQueries({ queryKey: ["mine"] });
              setSelectedId(conv.id);
              setTab("mine");
            }}
            clientPanelOpen={!clientPanelCollapsed}
            onToggleClientPanel={toggleInfoPanel}
          />
        ) : watchingConversation ? (
          <ReadOnlyConversationDrawer key={watchingConversation.id} variant="inline" conversation={watchingConversation} onClose={() => setWatchingConversation(null)} />
        ) : (
          <div className="flex h-full flex-col items-center justify-center gap-2 text-sm text-muted">
            <MessagesSquare className="h-10 w-10 opacity-30" />
            Selecione um atendimento para visualizar a conversa
          </div>
        )}
      </div>

      {selectedGroup && (
        <ResizableSidePanel resizable={!clientPanelCollapsed}>
          {clientPanelCollapsed ? null : <GroupInfoPanel group={selectedGroup} onClose={toggleClientPanel} />}
        </ResizableSidePanel>
      )}

      {panelConversation && (
        <ResizableSidePanel resizable={!clientPanelCollapsed}>
          <ClientPanel
            key={panelConversation.id}
            conversation={panelConversation}
            collapsed={clientPanelCollapsed}
            onToggle={toggleClientPanel}
            readOnly={!selectedConversation}
          />
        </ResizableSidePanel>
      )}

      {mobileInfoOpen && (selectedGroup || panelConversation) && (
        <div className="fixed inset-0 z-40 bg-surface md:hidden">
          {selectedGroup ? (
            <GroupInfoPanel group={selectedGroup} onClose={() => setMobileInfoOpen(false)} />
          ) : (
            <ClientPanel
              key={panelConversation!.id}
              conversation={panelConversation!}
              collapsed={false}
              onToggle={() => setMobileInfoOpen(false)}
              readOnly={!selectedConversation}
            />
          )}
        </div>
      )}

      {shortcutsOpen && <ShortcutsHelp onClose={() => setShortcutsOpen(false)} />}

      {novaConversaOpen && (
        <NovaConversaModal
          fixedConnectionId={hasFixedConnection ? user!.whatsappConnectionId : null}
          onClose={() => setNovaConversaOpen(false)}
          onStarted={(conversation) => {
            queryClient.invalidateQueries({ queryKey: ["mine"] });
            setSelectedId(conversation.id);
            setTab("mine");
            setNovaConversaOpen(false);
          }}
        />
      )}
    </div>
  );
}

function SectionLabel({ children }: { children: string }) {
  return <p className="border-b border-border bg-surface-alt px-3 py-1 text-[10.5px] font-semibold uppercase tracking-wide text-muted">{children}</p>;
}

function EmptyState({ message }: { message: string }) {
  return <p className="px-4 py-10 text-center text-sm text-muted">{message}</p>;
}
