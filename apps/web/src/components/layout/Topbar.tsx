import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { LogOut, Moon, Sun, Monitor, UserCircle, Menu, PauseCircle, Search, ChevronDown } from "lucide-react";
import { useNavigate } from "react-router-dom";
import clsx from "clsx";
import type { PauseReasonDTO } from "@whatsatendende/types";
import { api } from "../../lib/api";
import { useAuthStore } from "../../store/auth-store";
import { useCommandPaletteStore } from "../../store/command-palette-store";
import { useTheme } from "../../hooks/useTheme";
import { usePauseActions } from "../../hooks/usePauseActions";
import { disconnectSocket } from "../../lib/socket";
import { InstallAppButton } from "./InstallAppButton";
import { InternalChatButton } from "../internal-chat/InternalChatButton";
import { NotificationBell } from "./NotificationBell";

const PRESENCE_LABEL: Record<string, string> = { ONLINE: "Online", AWAY: "Ausente", OFFLINE: "Offline" };
const PRESENCE_DOT: Record<string, string> = { ONLINE: "bg-green-500", AWAY: "bg-amber-500", OFFLINE: "bg-gray-400" };
const IS_MAC = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);

/** Closes a popover when clicking anywhere outside `ref`. */
function useClickOutside(ref: React.RefObject<HTMLElement | null>, open: boolean, onClose: () => void) {
  useEffect(() => {
    if (!open) return;
    function handle(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    }
    document.addEventListener("mousedown", handle);
    return () => document.removeEventListener("mousedown", handle);
  }, [ref, open, onClose]);
}

export function Topbar({ title, onMenuClick }: { title: string; onMenuClick?: () => void }) {
  const user = useAuthStore((s) => s.user);
  // The shortcut search lists screens and actions an attendant can't use — managers and administrators only.
  const canSearch = user?.role === "MANAGER" || user?.role === "ADMIN";
  const clearSession = useAuthStore((s) => s.clearSession);
  const openPalette = useCommandPaletteStore((s) => s.setOpen);
  const navigate = useNavigate();
  const { preference, setTheme } = useTheme();
  const [menuOpen, setMenuOpen] = useState(false);
  const [pausePickerOpen, setPausePickerOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const pauseRef = useRef<HTMLDivElement>(null);
  useClickOutside(menuRef, menuOpen, () => setMenuOpen(false));
  useClickOutside(pauseRef, pausePickerOpen, () => setPausePickerOpen(false));
  const { pause, resume } = usePauseActions(() => {
    setPausePickerOpen(false);
    setMenuOpen(false);
  });
  const paused = user?.presence === "AWAY";

  const { data: pauseReasons } = useQuery({
    queryKey: ["pause-reasons-active"],
    queryFn: async () => (await api.get<PauseReasonDTO[]>("/pause-reasons/active")).data,
    enabled: pausePickerOpen,
  });

  async function handleLogout() {
    await api.post("/auth/logout").catch(() => undefined);
    disconnectSocket();
    clearSession();
    navigate("/login");
  }

  return (
    <header className="relative z-10 flex h-16 shrink-0 items-center justify-between gap-2 border-b border-border bg-surface px-3 sm:px-5">
      <div className="flex min-w-0 flex-1 items-center gap-2 sm:gap-4">
        <button
          type="button"
          onClick={onMenuClick}
          className="focus-ring shrink-0 rounded-card p-1.5 text-muted hover:bg-surface-alt md:hidden"
          aria-label="Abrir menu"
        >
          <Menu className="h-5 w-5" />
        </button>
        <h1 className="truncate text-base font-semibold tracking-tight sm:text-lg">{title}</h1>
        {canSearch && (
        <button
          type="button"
          onClick={() => openPalette(true)}
          className="focus-ring hidden h-9 w-full max-w-xs items-center gap-2 rounded-lg border border-border bg-surface-alt px-3 text-sm text-muted transition-colors hover:border-primary/40 lg:flex"
        >
          <Search className="h-4 w-4 shrink-0" />
          <span className="flex-1 truncate text-left">Buscar contato, tela ou ação…</span>
          <kbd className="rounded border border-border bg-surface px-1.5 font-mono text-[10px] text-muted">{IS_MAC ? "⌘K" : "Ctrl K"}</kbd>
        </button>
        )}
      </div>
      <div className="flex shrink-0 items-center gap-1.5 sm:gap-3">
        {canSearch && (
          <button
            type="button"
            onClick={() => openPalette(true)}
            className="focus-ring rounded-full p-2 text-muted hover:bg-surface-alt lg:hidden"
            aria-label="Buscar"
          >
            <Search className="h-5 w-5" />
          </button>
        )}
        <div className="relative" ref={pauseRef}>
          <button
            className={clsx(
              "focus-ring flex items-center gap-1.5 rounded-full border px-2.5 py-1.5 text-xs font-semibold sm:px-3 sm:text-sm",
              paused ? "border-warning/40 bg-warning-soft text-warning" : "border-border text-muted hover:bg-surface-alt"
            )}
            onClick={() => {
              if (paused) {
                resume.mutate();
                return;
              }
              setPausePickerOpen((o) => !o);
              setMenuOpen(false);
            }}
            disabled={resume.isPending}
            title={paused ? "Clique para retomar o atendimento" : "Pausar atendimento"}
          >
            {paused ? (
              <>
                <span className="h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-amber-500" />
                <span className="hidden sm:inline">{resume.isPending ? "Retomando..." : `Pausado${user.pauseReasonName ? ` — ${user.pauseReasonName}` : ""}`}</span>
              </>
            ) : (
              <>
                <PauseCircle className="h-4 w-4 shrink-0" />
                <span className="hidden sm:inline">Pausar</span>
              </>
            )}
          </button>
          {pausePickerOpen && !paused && (
            <div className="absolute right-0 top-11 z-20 w-52 rounded-card border border-border bg-surface p-2 shadow-elevated sm:left-0 sm:right-auto">
              <p className="mb-1.5 px-1 text-xs font-medium text-muted">Motivo da pausa</p>
              {pauseReasons?.length === 0 && <p className="px-1 text-xs text-muted">Nenhum motivo cadastrado.</p>}
              <div className="max-h-52 space-y-0.5 overflow-y-auto">
                {pauseReasons?.map((reason) => (
                  <button
                    key={reason.id}
                    onClick={() => pause.mutate(reason.id)}
                    disabled={pause.isPending}
                    className="focus-ring block w-full rounded-lg px-2 py-1.5 text-left text-sm hover:bg-surface-alt disabled:opacity-60"
                  >
                    {reason.name}
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
        <InternalChatButton />
        <NotificationBell />
        <InstallAppButton />
        <div className="hidden items-center gap-0.5 rounded-full border border-border p-1 sm:flex">
          {(
            [
              { value: "LIGHT", icon: Sun, label: "Tema claro" },
              { value: "DARK", icon: Moon, label: "Tema escuro" },
              { value: "AUTO", icon: Monitor, label: "Tema automático" },
            ] as const
          ).map((opt) => (
            <button
              key={opt.value}
              className={clsx("focus-ring rounded-full p-1.5", preference === opt.value ? "bg-secondary text-secondary-fg" : "text-muted hover:text-[var(--color-text)]")}
              onClick={() => setTheme(opt.value)}
              aria-label={opt.label}
              title={opt.label}
            >
              <opt.icon className="h-4 w-4" />
            </button>
          ))}
        </div>

        <div className="relative" ref={menuRef}>
          <button
            className={clsx("focus-ring flex items-center gap-2 rounded-lg px-1 py-1 hover:bg-surface-alt sm:px-1.5", menuOpen && "bg-surface-alt")}
            onClick={() => {
              setMenuOpen((o) => !o);
              setPausePickerOpen(false);
            }}
            aria-haspopup="menu"
            aria-expanded={menuOpen}
          >
            <span className="relative">
              <span className="block h-8 w-8 shrink-0 overflow-hidden rounded-full bg-primary text-sm font-semibold text-primary-fg">
                {user?.photoUrl ? (
                  <img src={user.photoUrl} alt={user.fullName} className="h-full w-full object-cover" />
                ) : (
                  <span className="flex h-full w-full items-center justify-center">{user?.fullName.slice(0, 1).toUpperCase()}</span>
                )}
              </span>
              {user && <span className={clsx("absolute -bottom-0.5 -right-0.5 h-3 w-3 rounded-full border-2 border-surface", PRESENCE_DOT[user.presence])} />}
            </span>
            <span className="hidden text-left leading-tight sm:block">
              {/* The person's own name (Nome completo), not the Nome de exibição customers see on messages. */}
              <span className="block max-w-[140px] truncate text-sm font-medium" title={user?.fullName}>
                {user?.fullName}
              </span>
              <span className={clsx("block max-w-[140px] truncate text-xs", paused ? "text-warning" : "text-muted")}>
                {paused && user.pauseReasonName ? `Pausado — ${user.pauseReasonName}` : user ? PRESENCE_LABEL[user.presence] : ""}
              </span>
            </span>
            <ChevronDown className={clsx("hidden h-3.5 w-3.5 text-muted transition-transform sm:block", menuOpen && "rotate-180")} />
          </button>
          {menuOpen && (
            <div role="menu" className="absolute right-0 top-12 z-20 w-60 rounded-card border border-border bg-surface p-1.5 shadow-elevated">
              <div className="mb-1 border-b border-border px-2.5 pb-2.5 pt-1.5">
                <p className="truncate text-sm font-semibold">{user?.fullName}</p>
                <p className="truncate text-xs text-muted">{user?.email}</p>
              </div>
              <button
                role="menuitem"
                onClick={() => {
                  setMenuOpen(false);
                  navigate("/perfil");
                }}
                className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-sm hover:bg-surface-alt"
              >
                <UserCircle className="h-4 w-4" /> Meu Perfil
              </button>
              <button role="menuitem" onClick={handleLogout} className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-sm text-danger hover:bg-surface-alt">
                <LogOut className="h-4 w-4" /> Sair
              </button>
            </div>
          )}
        </div>
      </div>
    </header>
  );
}
