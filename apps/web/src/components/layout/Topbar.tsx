import { useState } from "react";
import { LogOut, Moon, Sun, Monitor, UserCircle, Menu } from "lucide-react";
import { useNavigate } from "react-router-dom";
import { api } from "../../lib/api";
import { useAuthStore } from "../../store/auth-store";
import { useTheme } from "../../hooks/useTheme";
import { disconnectSocket } from "../../lib/socket";
import { InstallAppButton } from "./InstallAppButton";

const PRESENCE_LABEL: Record<string, string> = { ONLINE: "Online", AWAY: "Ausente", OFFLINE: "Offline" };

export function Topbar({ title, onMenuClick }: { title: string; onMenuClick?: () => void }) {
  const user = useAuthStore((s) => s.user);
  const clearSession = useAuthStore((s) => s.clearSession);
  const navigate = useNavigate();
  const { preference, setTheme } = useTheme();
  const [menuOpen, setMenuOpen] = useState(false);

  async function handleLogout() {
    await api.post("/auth/logout").catch(() => undefined);
    disconnectSocket();
    clearSession();
    navigate("/login");
  }

  return (
    <header className="shadow-soft relative z-10 flex h-16 items-center justify-between gap-2 border-b border-border bg-surface px-3 sm:px-6">
      <div className="flex min-w-0 items-center gap-2">
        <button
          type="button"
          onClick={onMenuClick}
          className="focus-ring shrink-0 rounded-card p-1.5 text-muted hover:bg-surface-alt md:hidden"
          aria-label="Abrir menu"
        >
          <Menu className="h-5 w-5" />
        </button>
        <h1 className="truncate text-lg font-semibold">{title}</h1>
      </div>
      <div className="flex shrink-0 items-center gap-2 sm:gap-4">
        <InstallAppButton />
        <div className="flex items-center gap-0.5 rounded-full border border-border p-1 sm:gap-1">
          <button
            className={`focus-ring rounded-full p-1.5 ${preference === "LIGHT" ? "bg-secondary text-secondary-fg" : "text-muted"}`}
            onClick={() => setTheme("LIGHT")}
            aria-label="Tema claro"
          >
            <Sun className="h-4 w-4" />
          </button>
          <button
            className={`focus-ring rounded-full p-1.5 ${preference === "DARK" ? "bg-secondary text-secondary-fg" : "text-muted"}`}
            onClick={() => setTheme("DARK")}
            aria-label="Tema escuro"
          >
            <Moon className="h-4 w-4" />
          </button>
          <button
            className={`focus-ring rounded-full p-1.5 ${preference === "AUTO" ? "bg-secondary text-secondary-fg" : "text-muted"}`}
            onClick={() => setTheme("AUTO")}
            aria-label="Tema automático"
          >
            <Monitor className="h-4 w-4" />
          </button>
        </div>

        <div className="relative">
          <button
            className="focus-ring flex items-center gap-2 rounded-card px-1.5 py-1.5 hover:bg-surface-alt sm:px-2"
            onClick={() => setMenuOpen((o) => !o)}
          >
            <div className="h-8 w-8 shrink-0 overflow-hidden rounded-full bg-primary text-sm font-semibold text-primary-fg">
              {user?.photoUrl ? (
                <img src={user.photoUrl} alt={user.displayName} className="h-full w-full object-cover" />
              ) : (
                <div className="flex h-full w-full items-center justify-center">{user?.displayName.slice(0, 1).toUpperCase()}</div>
              )}
            </div>
            <div className="hidden text-left text-sm sm:block">
              <div className="font-medium">{user?.displayName}</div>
              <div className="text-xs text-muted">{user ? PRESENCE_LABEL[user.presence] : ""}</div>
            </div>
          </button>
          {menuOpen && (
            <div className="absolute right-0 top-12 z-20 w-44 rounded-card border border-border bg-surface py-1 shadow-lg">
              <button
                onClick={() => {
                  setMenuOpen(false);
                  navigate("/perfil");
                }}
                className="flex w-full items-center gap-2 px-3 py-2 text-sm hover:bg-surface-alt"
              >
                <UserCircle className="h-4 w-4" /> Meu Perfil
              </button>
              <button
                onClick={handleLogout}
                className="flex w-full items-center gap-2 px-3 py-2 text-sm text-red-600 hover:bg-surface-alt"
              >
                <LogOut className="h-4 w-4" /> Sair
              </button>
            </div>
          )}
        </div>
      </div>
    </header>
  );
}
