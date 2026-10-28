import { Outlet, useLocation, useNavigate } from "react-router-dom";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Sidebar } from "./Sidebar";
import { Topbar } from "./Topbar";
import { BottomNav } from "./BottomNav";
import { useAuthStore } from "../../store/auth-store";
import { useActiveConversationStore } from "../../store/active-conversation-store";
import { connectSocket, disconnectSocket, getSocket } from "../../lib/socket";
import { useDesktopNotificationPermission } from "../../hooks/useDesktopNotifications";
import { useIdleLogout } from "../../hooks/useIdleLogout";
import { useAccessWindow } from "../../hooks/useAccessWindow";
import { useSocketEvents } from "../../hooks/useSocketEvents";

const TITLES: Record<string, string> = {
  "/atendimento": "Atendimento",
  "/gestao": "Gestão",
  "/dashboard": "Dashboard",
  "/relatorios": "Relatórios",
  "/usuarios": "Usuários",
  "/configuracoes": "Configurações",
  "/auditoria": "Auditoria",
  "/perfil": "Meu Perfil",
};

export function AppLayout() {
  const location = useLocation();
  const navigate = useNavigate();
  const accessToken = useAuthStore((s) => s.accessToken);
  const clearSession = useAuthStore((s) => s.clearSession);
  const activeConversationId = useActiveConversationStore((s) => s.activeConversationId);
  const [mobileNavOpen, setMobileNavOpen] = useState(false);

  useDesktopNotificationPermission();
  useIdleLogout();
  useAccessWindow();

  // Declared BEFORE useSocketEvents below (not after): React fires a
  // component's effects in the order they're declared during render, and
  // useSocketEvents' own effect calls getSocket() synchronously — if this
  // ran second, the very first mount would find no socket yet (still null,
  // created only once this effect runs), silently attach zero listeners,
  // and never retry until activeConversationId happened to change for some
  // unrelated reason. That race is exactly why a one-time event like
  // presence:self (emitted right when the socket connects, before the user
  // has opened any conversation) was never seen — see PROMPT: "não está
  // aparecendo Online" — and could just as easily eat the very first
  // queue:updated/whatsapp:status of a session.
  useEffect(() => {
    if (accessToken) connectSocket(accessToken);
    return () => disconnectSocket();
  }, [accessToken]);

  // Mounted here (not inside AtendimentoPage) so new-queue-conversation and
  // new-message toasts/desktop notifications keep firing while the agent is
  // on any other screen (Dashboard, Gestão, Usuários...) — previously this
  // only ran while the Atendimento page itself was open, so navigating away
  // silently stopped every notification. See PROMPT: "não estou recebendo
  // notificação de novas conversas na fila e nem de novas mensagens".
  useSocketEvents(activeConversationId);

  // Either an admin disconnected this account from Usuários, or this same
  // account just logged in somewhere else (only one active session is
  // allowed — see auth.service.ts's login) — the server already killed the
  // live socket in both cases; this just gets the UI itself out of the
  // now-dead session before the still-valid-for-a-few-more-minutes access
  // token lets any stale screen keep looking usable.
  useEffect(() => {
    const socket = getSocket();
    if (!socket) return;
    const handler = (payload?: { reason?: "ADMIN" | "NEW_LOGIN" | "SCHEDULE" }) => {
      toast.error(
        payload?.reason === "NEW_LOGIN"
          ? "Sua conta foi acessada em outro local. Esta sessão foi encerrada."
          : payload?.reason === "SCHEDULE"
            ? "Sua sessão foi encerrada: fora do horário de acesso permitido ou feriado."
            : "Sua sessão foi encerrada por um administrador."
      );
      clearSession();
      navigate("/login");
    };
    socket.on("user:force-logout", handler);
    return () => {
      socket.off("user:force-logout", handler);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accessToken]);

  // A route change from tapping a NavLink already closes the drawer (see
  // Sidebar's onClick), but this also covers programmatic navigation.
  useEffect(() => {
    setMobileNavOpen(false);
  }, [location.pathname]);

  const title = TITLES[location.pathname] ?? "WhatsUnivida";

  return (
    <div className="flex h-screen gap-2 overflow-hidden bg-[var(--color-bg)] p-2 sm:gap-3 sm:p-3">
      <Sidebar mobileOpen={mobileNavOpen} onMobileClose={() => setMobileNavOpen(false)} />
      <div className="flex min-w-0 flex-1 flex-col overflow-hidden rounded-card border border-border bg-surface shadow-soft">
        <Topbar title={title} onMenuClick={() => setMobileNavOpen(true)} />
        <main className="flex-1 overflow-hidden">
          <Outlet />
        </main>
        {/* Hidden while a conversation is open on mobile (Atendimento swaps
            its list for the chat panel in place, not a route change) — the
            chat's own composer already anchors the bottom there, and the
            tab bar would otherwise eat into that screen's scarce height for
            no benefit once you're already inside a conversation. See
            PROMPT: "abrir em layout de aplicativo... facilitando a
            navegação". */}
        {!activeConversationId && <BottomNav onMoreClick={() => setMobileNavOpen(true)} />}
      </div>
    </div>
  );
}
