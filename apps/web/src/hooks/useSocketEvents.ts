import { useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import type { AgentPresence, WhatsAppConnectionStatus } from "@whatsunivida/types";
import { getSocket } from "../lib/socket";
import { notifyDesktop } from "./useDesktopNotifications";
import { useAuthStore } from "../store/auth-store";

/** Subscribes to server-pushed realtime events and invalidates the affected React Query caches — no polling. */
export function useSocketEvents(activeConversationId: string | null) {
  const queryClient = useQueryClient();
  // A token refresh makes AppLayout call connectSocket() again, which
  // creates a brand-new socket object (see lib/socket.ts) and discards the
  // old one — without this dependency, this effect would never re-run to
  // move its listeners onto the new socket, silently going deaf for the
  // rest of the session after the first refresh.
  const accessToken = useAuthStore((s) => s.accessToken);

  useEffect(() => {
    const socket = getSocket();
    if (!socket) return;

    const onQueueUpdated = () => queryClient.invalidateQueries({ queryKey: ["queue"] });
    const onNewQueueConversation = (payload: { conversationId: string; contactName: string }) => {
      queryClient.invalidateQueries({ queryKey: ["queue"] });
      toast.info(`Nova conversa na fila: ${payload.contactName}`);
      notifyDesktop("Nova conversa na fila", payload.contactName, `wa-queue-${payload.conversationId}`);
    };
    const onAssigned = () => {
      queryClient.invalidateQueries({ queryKey: ["mine"] });
      queryClient.invalidateQueries({ queryKey: ["queue"] });
      toast.success("Nova conversa aceita.");
    };
    const onRemoved = () => queryClient.invalidateQueries({ queryKey: ["mine"] });
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
    const onOversightUpdated = () => queryClient.invalidateQueries({ queryKey: ["oversight"] });
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

    socket.on("queue:updated", onQueueUpdated);
    socket.on("queue:new-conversation", onNewQueueConversation);
    socket.on("conversation:assigned", onAssigned);
    socket.on("conversation:removed", onRemoved);
    socket.on("conversation:transferred-in", onTransferredIn);
    socket.on("message:new", onMessageNew);
    socket.on("message:inbound-notification", onInboundNotification);
    socket.on("message:status", onMessageStatus);
    socket.on("conversation:read", onConversationRead);
    socket.on("oversight:updated", onOversightUpdated);
    socket.on("whatsapp:status", onWhatsappStatus);
    socket.on("presence:self", onPresenceSelf);

    return () => {
      socket.off("queue:updated", onQueueUpdated);
      socket.off("queue:new-conversation", onNewQueueConversation);
      socket.off("conversation:assigned", onAssigned);
      socket.off("conversation:removed", onRemoved);
      socket.off("conversation:transferred-in", onTransferredIn);
      socket.off("message:new", onMessageNew);
      socket.off("message:inbound-notification", onInboundNotification);
      socket.off("message:status", onMessageStatus);
      socket.off("conversation:read", onConversationRead);
      socket.off("oversight:updated", onOversightUpdated);
      socket.off("whatsapp:status", onWhatsappStatus);
      socket.off("presence:self", onPresenceSelf);
    };
  }, [queryClient, activeConversationId, accessToken]);

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
