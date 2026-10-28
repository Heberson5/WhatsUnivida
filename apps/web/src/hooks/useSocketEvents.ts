import { useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import type { AgentPresence, ChatRoomDTO, ConversationReminderDTO, NotificationDTO, WhatsAppConnectionStatus } from "@whatsatendende/types";
import { showReminderToast } from "../components/atendimento/ReminderToast";
import { getSocket } from "../lib/socket";
import { useTypingStore } from "../store/typing-store";
import { notifyDesktop } from "./useDesktopNotifications";
import { playUserAlertSound } from "../lib/alert-sounds";
import { useInternalChatStore } from "../store/internal-chat-store";
import { useAuthStore } from "../store/auth-store";
import type { NotificationsResponse } from "../components/layout/NotificationBell";
import { useActiveGroupStore } from "../store/active-group-store";

/** Subscribes to server-pushed realtime events and invalidates the affected React Query caches — no polling. */
export function useSocketEvents(activeConversationId: string | null) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  // A token refresh makes AppLayout call connectSocket() again, which
  // creates a brand-new socket object (see lib/socket.ts) and discards the
  // old one — without this dependency, this effect would never re-run to
  // move its listeners onto the new socket, silently going deaf for the
  // rest of the session after the first refresh.
  const accessToken = useAuthStore((s) => s.accessToken);

  useEffect(() => {
    const socket = getSocket();
    if (!socket) return;

    const onBrandingUpdated = () => {
      queryClient.invalidateQueries({ queryKey: ["branding"] });
      queryClient.invalidateQueries({ queryKey: ["export-branding"] });
    };
    const onQueueUpdated = () => queryClient.invalidateQueries({ queryKey: ["queue"] });
    // A contact's tags changed: the cards show them (Meus, Fila and Transf.).
    const onContactTags = () => {
      queryClient.invalidateQueries({ queryKey: ["mine"] });
      queryClient.invalidateQueries({ queryKey: ["transferred-out"] });
      queryClient.invalidateQueries({ queryKey: ["queue"] });
    };
    const onNewQueueConversation = (payload: { conversationId: string; contactName: string }) => {
      queryClient.invalidateQueries({ queryKey: ["queue"] });
      toast.info(`Nova conversa na fila: ${payload.contactName}`);
      playUserAlertSound("newQueue");
      notifyDesktop("Nova conversa na fila", payload.contactName, `wa-queue-${payload.conversationId}`);
    };
    // Periodic nudge while this agent's connection still has a conversation
    // waiting to be accepted — see lib/queue-reminder.ts on the API. Tagged
    // by connectionId (not conversationId/tick) so each re-fire replaces the
    // previous desktop notification instead of stacking a new one every
    // interval. See PROMPT: "notificações a cada um minuto quando tem
    // conversas na fila para ser aceitas".
    const onQueueReminder = (payload: { connectionId: string; connectionName: string; waitingCount: number }) => {
      const message =
        payload.waitingCount === 1
          ? `1 conversa aguardando em ${payload.connectionName}`
          : `${payload.waitingCount} conversas aguardando em ${payload.connectionName}`;
      toast.info(message);
      notifyDesktop("Conversas aguardando na fila", message, `wa-queue-reminder-${payload.connectionId}`);
    };
    // One per conversation whose customer is still waiting, every "X minutos" (Configurações › Fila).
    const onNoReplyReminder = (payload: { conversationId: string; contactName: string; minutes: number }) => {
      const message = `${payload.contactName} aguardando resposta há ${payload.minutes} min`;
      playUserAlertSound("newMessage");
      toast.warning(message, {
        id: `wa-no-reply-${payload.conversationId}`,
        action: { label: "Abrir", onClick: () => navigate(`/atendimento?open=${payload.conversationId}`) },
      });
      notifyDesktop("Cliente aguardando resposta", message, `wa-no-reply-${payload.conversationId}`);
    };
    const onAssigned = () => {
      queryClient.invalidateQueries({ queryKey: ["mine"] });
      queryClient.invalidateQueries({ queryKey: ["queue"] });
      toast.success("Nova conversa aceita.");
    };
    const onRemoved = () => {
      queryClient.invalidateQueries({ queryKey: ["mine"] });
      queryClient.invalidateQueries({ queryKey: ["my-day"] });
      // A transfer-out is the only thing that fires conversation:removed for
      // the FROM side — this keeps "Transferidas" live the moment an agent
      // sends one away, without waiting for the 20s poll.
      queryClient.invalidateQueries({ queryKey: ["transferred-out"] });
    };
    const onTransferredIn = () => {
      queryClient.invalidateQueries({ queryKey: ["mine"] });
      toast.info("Uma conversa foi transferida para você.");
    };
    const onMessageNew = (payload: { conversationId: string }) => {
      queryClient.invalidateQueries({ queryKey: ["mine"] });
      queryClient.invalidateQueries({ queryKey: ["messages", payload.conversationId] });
    };
    // Distinct from onMessageNew: only fires for inbound customer messages
    // on a conversation the agent already owns, and only toasts if they
    // aren't already looking at that conversation (it's visible live there).
    const onInboundNotification = (payload: { conversationId: string; contactName: string; preview: string }) => {
      if (payload.conversationId === activeConversationId) return;
      playUserAlertSound("newMessage");
      toast.message(payload.contactName, { description: payload.preview });
      notifyDesktop(payload.contactName, payload.preview, `wa-conversation-${payload.conversationId}`);
    };
    const onMessageStatus = (payload: { conversationId: string }) => {
      queryClient.invalidateQueries({ queryKey: ["messages", payload.conversationId] });
    };
    // The linked phone marked a chat as read (WhatsApp's own multi-device
    // sync) — refresh so the unread badge here matches what's already read
    // on the phone, without waiting for the 20s poll.
    const onConversationRead = () => queryClient.invalidateQueries({ queryKey: ["mine"] });
    // Chat interno: sound and Windows notification unless that very room is on screen, or the room is muted
    // (an @mention of this person still comes through). Gestão's copies of the events (oversight) only refresh.
    const onInternalChatMessage = (payload: { roomId: string; authorName?: string; preview?: string; roomName?: string | null; mentions?: string[]; authorId?: string; oversight?: boolean }) => {
      if (payload.oversight) return void queryClient.invalidateQueries({ queryKey: ["internal-chat-oversight"] });
      queryClient.invalidateQueries({ queryKey: ["internal-chat"] });
      const chat = useInternalChatStore.getState();
      if (!payload.authorName) return;
      // The message arrived: whoever was typing it is done.
      if (payload.authorId) chat.clearTyping(payload.roomId, payload.authorId);
      if (chat.open && chat.activeRoomId === payload.roomId) return;
      const me = useAuthStore.getState().user?.id;
      const mentioned = Boolean(me && payload.mentions?.some((m) => m === me || m === "ALL"));
      const room = queryClient.getQueryData<ChatRoomDTO[]>(["internal-chat", "rooms"])?.find((r) => r.id === payload.roomId);
      if (room?.mutedUntil && new Date(room.mutedUntil) > new Date() && !mentioned) return;
      playUserAlertSound("internalChat");
      notifyDesktop(mentioned ? `${payload.authorName} mencionou você` : (payload.roomName ?? "Chat interno"), `${payload.authorName}: ${payload.preview ?? ""}`, `wa-internal-chat-${payload.roomId}`);
    };
    const onInternalChatRead = (payload: { roomId: string; oversight?: boolean }) =>
      queryClient.invalidateQueries({ queryKey: payload.oversight ? ["internal-chat-oversight"] : ["internal-chat", "messages", payload.roomId] });
    const onInternalChatTyping = (payload: { roomId: string; userId: string; name: string; kind?: "typing" | "recording" }) =>
      useInternalChatStore.getState().setTyping(payload.roomId, payload.userId, payload.name, payload.kind ?? "typing");
    const onInternalChatRooms = (payload: { deletedRoomId?: string; oversight?: boolean }) => {
      if (payload?.oversight) return void queryClient.invalidateQueries({ queryKey: ["internal-chat-oversight"] });
      queryClient.invalidateQueries({ queryKey: ["internal-chat"] });
      const chat = useInternalChatStore.getState();
      if (payload?.deletedRoomId && chat.activeRoomId === payload.deletedRoomId) {
        chat.setActiveRoom(null);
        toast.info("O grupo foi excluído por quem o criou.");
      }
    };
    // "Chamar a atenção": the whole app shakes (or flashes, for whoever asked the computer for less motion), the
    // buzz sounds and the chat opens on that conversation.
    const onInternalChatNudge = (payload: { roomId: string; fromName: string }) => {
      const target = document.getElementById("root") ?? document.body;
      const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
      const cls = reduce ? "chat-nudge-flash" : "chat-nudge-shake";
      target.classList.remove("chat-nudge-shake", "chat-nudge-flash");
      void target.offsetWidth;
      target.classList.add(cls);
      setTimeout(() => target.classList.remove(cls), 1600);
      playUserAlertSound("nudge");
      if (navigator.vibrate) navigator.vibrate([120, 60, 120]);
      toast.warning(`${payload.fromName} chamou sua atenção!`);
      notifyDesktop("Chat interno", `${payload.fromName} chamou sua atenção!`, `wa-internal-nudge-${payload.roomId}`);
      const chat = useInternalChatStore.getState();
      chat.setOpen(true);
      chat.setActiveRoom(payload.roomId);
    };
    const onGoalsChanged = () => queryClient.invalidateQueries({ queryKey: ["my-day"] });
    // A data source started or stopped working: tags, quick replies with tags and Dados do cliente follow at once.
    const onDataSourceStatus = () => {
      for (const key of ["client-data", "quick-replies", "data-sources"]) queryClient.invalidateQueries({ queryKey: [key] });
    };
    const onOversightUpdated = () => queryClient.invalidateQueries({ queryKey: ["oversight"] });
    const onNotes = (payload: { conversationId: string }) => queryClient.invalidateQueries({ queryKey: ["notes", payload.conversationId] });
    // Gestão › Intervir started/ended: the agent's chat locks or unlocks, the manager's panel follows.
    const onIntervention = (payload: { conversationId: string }) => {
      queryClient.invalidateQueries({ queryKey: ["mine"] });
      queryClient.invalidateQueries({ queryKey: ["oversight"] });
      queryClient.invalidateQueries({ queryKey: ["notes", payload.conversationId] });
    };
    // A connection's status changing affects every conversation/queue card
    // tied to it (accept/send get enabled or disabled — see PROMPT: alerta
    // e bloqueio para conexões desconectadas) and, for an AGENT whose own
    // home connection this is, the banner in Atendimento — patched directly
    // into the auth store (a no-op for MANAGER/ADMIN, who have none) so it
    // updates instantly instead of waiting for the next login/refresh.
    const onWhatsappStatus = (payload: { connectionId: string; status: { state: WhatsAppConnectionStatus } }) => {
      queryClient.invalidateQueries({ queryKey: ["whatsapp-status"] });
      queryClient.invalidateQueries({ queryKey: ["queue"] });
      queryClient.invalidateQueries({ queryKey: ["mine"] });
      useAuthStore.getState().updateOwnConnectionStatus(payload.connectionId, payload.status.state);
    };
    // Emitted once, right when this socket registers server-side — patches
    // the topbar's presence dot instantly instead of leaving it stuck on
    // whatever was last persisted (typically OFFLINE, from the previous
    // session ending) until the next login/refresh. See PROMPT: "não está
    // aparecendo Online".
    const onPresenceSelf = (payload: { presence: AgentPresence }) => {
      useAuthStore.getState().updateOwnPresence(payload.presence);
    };
    // Writes straight into NotificationBell's own query-cache key — see its
    // comment for why the listener lives here instead of in that (more
    // deeply nested) component.
    // A group's bell entry is updated in place (one per group): it moves to the top instead of adding another.
    const onNotificationNew = (notification: NotificationDTO) => {
      queryClient.setQueryData<NotificationsResponse | undefined>(["notifications"], (prev) => {
        if (!prev) return { items: [notification], unreadCount: 1 };
        const existing = prev.items.find((n) => n.id === notification.id);
        const wasUnread = Boolean(existing && !existing.readAt);
        return {
          items: [notification, ...prev.items.filter((n) => n.id !== notification.id)].slice(0, 30),
          unreadCount: prev.unreadCount + (wasUnread ? 0 : 1),
        };
      });
    };
    // A new message in a WhatsApp group: everybody who sees the group is told, unless it's open on
    // their screen, they silenced it, or they wrote it (the server sends notify=false then).
    const onGroupMessage = (payload: { conversationId: string; groupName: string; senderName: string; preview: string; notify: boolean }) => {
      queryClient.invalidateQueries({ queryKey: ["groups"] });
      queryClient.invalidateQueries({ queryKey: ["group-messages", payload.conversationId] });
      if (!payload.notify || useActiveGroupStore.getState().activeGroupId === payload.conversationId) return;
      const text = `${payload.senderName}: ${payload.preview}`;
      toast.message(payload.groupName, { description: text, id: `wa-group-${payload.conversationId}` });
      notifyDesktop(payload.groupName, text, `wa-group-${payload.conversationId}`);
    };
    const onGroupsUpdated = () => queryClient.invalidateQueries({ queryKey: ["groups"] });
    // A participant reacted: only the open group's messages change.
    const onGroupReaction = (payload: { conversationId: string }) => queryClient.invalidateQueries({ queryKey: ["group-messages", payload.conversationId] });
    const onTyping = (payload: { conversationId: string; typing: boolean; kind?: "typing" | "recording"; participant?: string; name?: string }) =>
      useTypingStore.getState().setTyping(payload.conversationId, payload.typing, payload.kind, payload.participant, payload.name);
    const onAgentExtras = () => queryClient.invalidateQueries({ queryKey: ["agent-extras"] });
    const onAbandoned = () => queryClient.invalidateQueries({ queryKey: ["abandoned"] });
    const onReminderDue = (reminder: ConversationReminderDTO & { contactName: string }) => {
      showReminderToast(reminder, (conversationId) => navigate(`/atendimento?open=${conversationId}`));
      notifyDesktop(`Hora de retornar para ${reminder.contactName}`, reminder.note ?? "Lembrete de retorno", `wa-reminder-${reminder.id}`);
    };

    socket.on("queue:updated", onQueueUpdated);
    socket.on("contact:tags", onContactTags);
    socket.on("queue:new-conversation", onNewQueueConversation);
    socket.on("queue:reminder", onQueueReminder);
    socket.on("conversation:no-reply-reminder", onNoReplyReminder);
    socket.on("conversation:assigned", onAssigned);
    socket.on("conversation:removed", onRemoved);
    socket.on("conversation:transferred-in", onTransferredIn);
    socket.on("message:new", onMessageNew);
    socket.on("message:inbound-notification", onInboundNotification);
    socket.on("message:status", onMessageStatus);
    socket.on("conversation:read", onConversationRead);
    socket.on("goals:changed", onGoalsChanged);
    socket.on("internal-chat:message", onInternalChatMessage);
    socket.on("internal-chat:read", onInternalChatRead);
    socket.on("internal-chat:typing", onInternalChatTyping);
    socket.on("internal-chat:rooms", onInternalChatRooms);
    socket.on("internal-chat:nudge", onInternalChatNudge);
    socket.on("data-source:status", onDataSourceStatus);
    socket.on("oversight:updated", onOversightUpdated);
    socket.on("conversation:intervention", onIntervention);
    socket.on("conversation:notes", onNotes);
    socket.on("whatsapp:status", onWhatsappStatus);
    socket.on("presence:self", onPresenceSelf);
    socket.on("notification:new", onNotificationNew);
    socket.on("group:message", onGroupMessage);
    socket.on("group:reaction", onGroupReaction);
    socket.on("group:read", onGroupsUpdated);
    socket.on("groups:updated", onGroupsUpdated);
    socket.on("conversation:typing", onTyping);
    socket.on("agent:extras", onAgentExtras);
    socket.on("abandoned:updated", onAbandoned);
    socket.on("reminder:due", onReminderDue);
    socket.on("branding:updated", onBrandingUpdated);

    return () => {
      socket.off("queue:updated", onQueueUpdated);
      socket.off("contact:tags", onContactTags);
      socket.off("queue:new-conversation", onNewQueueConversation);
      socket.off("queue:reminder", onQueueReminder);
      socket.off("conversation:no-reply-reminder", onNoReplyReminder);
      socket.off("conversation:assigned", onAssigned);
      socket.off("conversation:removed", onRemoved);
      socket.off("conversation:transferred-in", onTransferredIn);
      socket.off("message:new", onMessageNew);
      socket.off("message:inbound-notification", onInboundNotification);
      socket.off("message:status", onMessageStatus);
      socket.off("conversation:read", onConversationRead);
      socket.off("goals:changed", onGoalsChanged);
      socket.off("internal-chat:message", onInternalChatMessage);
      socket.off("internal-chat:read", onInternalChatRead);
      socket.off("internal-chat:typing", onInternalChatTyping);
      socket.off("internal-chat:rooms", onInternalChatRooms);
      socket.off("internal-chat:nudge", onInternalChatNudge);
      socket.off("data-source:status", onDataSourceStatus);
      socket.off("oversight:updated", onOversightUpdated);
      socket.off("conversation:intervention", onIntervention);
      socket.off("conversation:notes", onNotes);
      socket.off("whatsapp:status", onWhatsappStatus);
      socket.off("presence:self", onPresenceSelf);
      socket.off("branding:updated", onBrandingUpdated);
      socket.off("notification:new", onNotificationNew);
      socket.off("group:message", onGroupMessage);
      socket.off("group:reaction", onGroupReaction);
      socket.off("group:read", onGroupsUpdated);
      socket.off("groups:updated", onGroupsUpdated);
      socket.off("conversation:typing", onTyping);
      socket.off("agent:extras", onAgentExtras);
      socket.off("abandoned:updated", onAbandoned);
      socket.off("reminder:due", onReminderDue);
    };
  }, [queryClient, activeConversationId, accessToken, navigate]);

  useEffect(() => {
    const socket = getSocket();
    if (!socket || !activeConversationId) return;
    const join = () => socket.emit("conversation:join", activeConversationId);
    join();
    // A dropped/restored connection (network blip, API redeploy) gets a
    // brand-new socket.io session server-side — unlike the user/queue/
    // oversight rooms (rejoined automatically server-side on every
    // "connection" event, see socket-server.ts), this conversation's room
    // was only ever joined via this explicit emit, so it does not survive
    // a reconnect on its own. Without rejoining here, a chat left open
    // across a reconnect silently stops getting message/status updates —
    // looking like realtime is broken — until the page is reloaded.
    socket.on("connect", join);
    return () => {
      socket.off("connect", join);
      socket.emit("conversation:leave", activeConversationId);
    };
  }, [activeConversationId]);
}
