import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { Bell, BellOff, Check, MessageSquare, ArrowRightLeft, Users } from "lucide-react";
import { toast } from "sonner";
import { formatDistanceToNow } from "date-fns";
import { ptBR } from "date-fns/locale";
import type { NotificationDTO } from "@whatsatendende/types";
import { api } from "../../lib/api";
import { useNotificationPermission } from "../../hooks/useDesktopNotifications";

export interface NotificationsResponse {
  items: NotificationDTO[];
  unreadCount: number;
}

const TYPE_ICON: Record<string, typeof MessageSquare> = { MESSAGE: MessageSquare, TRANSFER: ArrowRightLeft, GROUP_MESSAGE: Users };

/** Where clicking a notification goes — see PROMPT: "ao clicar em cima de alguma, será direcionado para o local". Only Conversation-linked ones exist today (new message, transfer received) — both always land the agent's own "Ativos". */
function entityPath(notification: NotificationDTO): string | null {
  if (notification.entityType === "Conversation" && notification.entityId) return `/atendimento?open=${notification.entityId}`;
  if (notification.entityType === "Group" && notification.entityId) return `/atendimento?grupo=${notification.entityId}`;
  return null;
}

export function NotificationBell() {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { permission: notificationPermission, requestPermission: requestNotificationPermission } = useNotificationPermission();

  // Live updates (a new notification prepended, the badge bumped) come from
  // useSocketEvents' own "notification:new" listener writing straight into
  // this same query-cache key — not a socket subscription here. AppLayout
  // mounts useSocketEvents at a spot in the tree, and with a hook-ordering
  // guarantee (see its own comment), that's already correct relative to
  // connectSocket(); this component is nested deeper (AppLayout > Topbar >
  // NotificationBell) where that ordering guarantee doesn't hold, so a
  // socket listener declared here could silently attach to nothing on the
  // very first mount of a session. See PROMPT: "marcando as notificações
  // perdidas".
  const { data } = useQuery({
    queryKey: ["notifications"],
    queryFn: async () => (await api.get<NotificationsResponse>("/notifications")).data,
  });

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  const markReadMutation = useMutation({
    mutationFn: (id: string) => api.post(`/notifications/${id}/read`),
    onSuccess: (_res, id) => {
      queryClient.setQueryData<NotificationsResponse | undefined>(["notifications"], (prev) => {
        if (!prev) return prev;
        const target = prev.items.find((n) => n.id === id);
        if (!target || target.readAt) return prev;
        return {
          items: prev.items.map((n) => (n.id === id ? { ...n, readAt: new Date().toISOString() } : n)),
          unreadCount: Math.max(0, prev.unreadCount - 1),
        };
      });
    },
  });

  const markAllReadMutation = useMutation({
    mutationFn: () => api.post("/notifications/read-all"),
    onSuccess: () => {
      queryClient.setQueryData<NotificationsResponse | undefined>(["notifications"], (prev) =>
        prev ? { items: prev.items.map((n) => ({ ...n, readAt: n.readAt ?? new Date().toISOString() })), unreadCount: 0 } : prev
      );
    },
  });

  function handleNotificationClick(notification: NotificationDTO) {
    if (!notification.readAt) markReadMutation.mutate(notification.id);
    setOpen(false);
    const path = entityPath(notification);
    if (path) navigate(path);
  }

  async function handleRequestNotificationPermission() {
    if (notificationPermission !== "default") return;
    const result = await requestNotificationPermission();
    if (result === "granted") toast.success("Notificações do Windows ativadas.");
    else if (result === "denied") {
      toast.error("Notificações bloqueadas. Para ativar, permita notificações para este site nas configurações do navegador.");
    }
  }

  const unreadCount = data?.unreadCount ?? 0;

  return (
    <div className="relative" ref={rootRef}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="focus-ring relative rounded-full p-1.5 text-muted hover:bg-surface-alt"
        aria-label={unreadCount > 0 ? `Notificações — ${unreadCount} não lida(s)` : "Notificações"}
        title="Notificações"
      >
        <Bell className="h-4 w-4" />
        {unreadCount > 0 && (
          <span className="absolute -right-0.5 -top-0.5 flex h-4 min-w-[16px] items-center justify-center rounded-full bg-red-500 px-1 text-[10px] font-bold text-white">
            {unreadCount > 9 ? "9+" : unreadCount}
          </span>
        )}
      </button>

      {open && (
        <div
          className={
            // Fixed to the viewport with side gutters on mobile — anchoring
            // this to the bell's own position (like the md:+ behavior below)
            // let a 320px-wide panel run off the left edge of a narrow
            // phone screen, clipping the notification text. See PROMPT:
            // "ao clicar no sininho... está cortada a tela das notificações".
            "shadow-lg fixed inset-x-3 top-16 z-20 flex max-h-[28rem] flex-col rounded-card border border-border bg-surface " +
            "md:absolute md:inset-x-auto md:right-0 md:top-12 md:w-80"
          }
        >
          <div className="flex items-center justify-between border-b border-border px-3 py-2.5">
            <span className="text-sm font-semibold">Notificações</span>
            {unreadCount > 0 && (
              <button
                onClick={() => markAllReadMutation.mutate()}
                className="focus-ring flex items-center gap-1 text-xs font-medium text-primary hover:underline"
              >
                <Check className="h-3 w-3" /> Marcar todas como lidas
              </button>
            )}
          </div>

          <div className="flex-1 overflow-y-auto">
            {!data?.items.length && <p className="px-3 py-8 text-center text-sm text-muted">Nenhuma notificação ainda.</p>}
            {data?.items.map((n) => {
              const Icon = TYPE_ICON[n.type] ?? MessageSquare;
              const clickable = entityPath(n) !== null;
              return (
                <button
                  key={n.id}
                  onClick={() => handleNotificationClick(n)}
                  disabled={!clickable}
                  className={`flex w-full items-start gap-2.5 border-b border-border px-3 py-2.5 text-left last:border-b-0 hover:bg-surface-alt disabled:cursor-default disabled:hover:bg-transparent ${
                    !n.readAt ? "bg-primary/5" : ""
                  }`}
                >
                  <Icon className="mt-0.5 h-4 w-4 shrink-0 text-muted" />
                  <div className="min-w-0 flex-1">
                    <p className={`truncate text-sm ${!n.readAt ? "font-semibold" : "font-medium"}`}>{n.title}</p>
                    {n.body && <p className="truncate text-xs text-muted">{n.body}</p>}
                    <p className="mt-0.5 text-[11px] text-muted">{formatDistanceToNow(new Date(n.createdAt), { locale: ptBR, addSuffix: true })}</p>
                  </div>
                  {!n.readAt && <span className="mt-1.5 h-2 w-2 shrink-0 rounded-full bg-primary" />}
                </button>
              );
            })}
          </div>

          {notificationPermission === "default" && (
            <button
              onClick={handleRequestNotificationPermission}
              className="focus-ring flex items-center gap-2 border-t border-border px-3 py-2.5 text-left text-xs text-muted hover:bg-surface-alt"
            >
              <Bell className="h-3.5 w-3.5 shrink-0" /> Ativar notificações do Windows nesta aba
            </button>
          )}
          {notificationPermission === "denied" && (
            <p className="flex items-center gap-2 border-t border-border px-3 py-2.5 text-xs text-red-600">
              <BellOff className="h-3.5 w-3.5 shrink-0" /> Notificações do Windows bloqueadas nas configurações do navegador.
            </p>
          )}
        </div>
      )}
    </div>
  );
}
