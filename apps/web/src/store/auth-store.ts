import { create } from "zustand";
import { clearTemporaryColumnViews } from "../lib/temporaryColumnViews";
import type { AgentPresence, PermissionMap, UserDTO, WhatsAppConnectionStatus } from "@whatsatendende/types";

interface AuthState {
  accessToken: string | null;
  user: UserDTO | null;
  // What the current user's role can do, resolved server-side (Configurações
  // > Permissões) — null only until the first login/refresh response lands.
  permissions: PermissionMap | null;
  hydrated: boolean;
  // permissions is optional so callers that reuse an existing session (e.g.
  // MeuPerfilPage updating a photo) don't have to refetch or clobber it.
  setSession: (accessToken: string, user: UserDTO, permissions?: PermissionMap) => void;
  clearSession: () => void;
  setHydrated: () => void;
  // Live-patches the current user's own connection status from the
  // "whatsapp:status" socket event (see useSocketEvents) — powers the
  // AGENT "sua conexão está desconectada" banner in Atendimento without
  // waiting for the next login/refresh. No-op if the event isn't for this
  // user's own connection (AGENT only ever has one; MANAGER/ADMIN have
  // none, so this never matches for them).
  updateOwnConnectionStatus: (connectionId: string, status: WhatsAppConnectionStatus) => void;
  // Live-patches the current user's own presence — login/refresh returns
  // whatever presence was last persisted (typically OFFLINE, from the
  // previous session ending), and the server only actually flips it to
  // ONLINE once the socket connects a moment *after* that response lands
  // (see presence-tracker.ts registerConnection). Without this, the topbar
  // kept showing the stale pre-login value forever — see PROMPT: "não está
  // aparecendo Online" — since nothing ever told the client the flip
  // happened. Patched from the "presence:self" socket event.
  updateOwnPresence: (presence: AgentPresence) => void;
  // Patches the current user's own pause state after POST /profile/pause
  // or /resume — those return the full updated UserDTO, but presence
  // itself is already kept live by updateOwnPresence (driven by the
  // "presence:self" socket event, which fires from the same request); this
  // just carries the reason along so the profile menu can show "Pausado —
  // <motivo>" immediately, without waiting on anything else.
  updateOwnPauseState: (pauseReasonId: string | null, pauseReasonName: string | null) => void;
  // Patches the saved default hour range for the Dashboard's "Presença ao
  // longo do dia" chart after PATCH /settings/presence-chart-hours — so a
  // later remount of the Dashboard in this same session picks it up without
  // a refetch of the whole profile.
  updatePresenceChartHours: (startHour: number | null, endHour: number | null) => void;
  // Same, for "Conversas que chegam ao longo do dia".
  updateArrivalsChartHours: (startHour: number | null, endHour: number | null) => void;
  // Patches the newest Notas de versão release the user has seen, right
  // after PATCH /profile/release-notes-seen, so the sidebar badge and the
  // "O que há de novo" popup clear immediately.
  updateReleaseNotesSeen: (version: string | null) => void;
}

export const useAuthStore = create<AuthState>((set) => ({
  accessToken: null,
  user: null,
  permissions: null,
  hydrated: false,
  setSession: (accessToken, user, permissions) =>
    set((state) => ({ accessToken, user, permissions: permissions ?? state.permissions })),
  clearSession: () => {
    clearTemporaryColumnViews();
    set({ accessToken: null, user: null, permissions: null });
  },
  setHydrated: () => set({ hydrated: true }),
  updateOwnConnectionStatus: (connectionId, status) =>
    set((state) => {
      if (!state.user || state.user.whatsappConnectionId !== connectionId) return state;
      return { user: { ...state.user, whatsappConnectionStatus: status } };
    }),
  updateOwnPresence: (presence) =>
    set((state) => (state.user ? { user: { ...state.user, presence } } : state)),
  updateOwnPauseState: (pauseReasonId, pauseReasonName) =>
    set((state) => (state.user ? { user: { ...state.user, pauseReasonId, pauseReasonName } } : state)),
  updatePresenceChartHours: (presenceChartStartHour, presenceChartEndHour) =>
    set((state) => (state.user ? { user: { ...state.user, presenceChartStartHour, presenceChartEndHour } } : state)),
  updateArrivalsChartHours: (arrivalsChartStartHour, arrivalsChartEndHour) =>
    set((state) => (state.user ? { user: { ...state.user, arrivalsChartStartHour, arrivalsChartEndHour } } : state)),
  updateReleaseNotesSeen: (releaseNotesSeenVersion) =>
    set((state) => (state.user ? { user: { ...state.user, releaseNotesSeenVersion } } : state)),
}));
