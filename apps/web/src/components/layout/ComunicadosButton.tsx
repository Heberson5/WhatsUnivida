import { NavLink } from "react-router-dom";
import { Newspaper } from "lucide-react";
import { PERMISSION } from "@whatsatendende/types";
import { useAuthStore } from "../../store/auth-store";
import { useAnnouncementBoard, useBoardName } from "../../hooks/useAnnouncements";

/** The newspaper in the top bar: opens Comunicados, with how many of today's notices are still unread. */
export function ComunicadosButton({ variant = "button", onDone }: { variant?: "button" | "menuitem"; onDone?: () => void } = {}) {
  const canReceive = useAuthStore((s) => Boolean(s.permissions?.[PERMISSION.COMUNICADOS_VER]));
  const { data } = useAnnouncementBoard();
  const name = useBoardName();
  if (!canReceive) return null;
  const unread = data?.unread ?? 0;
  if (variant === "menuitem") {
    return (
      <NavLink role="menuitem" to="/comunicados" onClick={onDone} className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-sm hover:bg-surface-alt">
        <Newspaper className="h-4 w-4" /> <span className="flex-1">{name}</span>
        {unread > 0 && <span className="rounded-full bg-primary px-1.5 text-[11px] font-bold text-primary-fg">{unread > 9 ? "9+" : unread}</span>}
      </NavLink>
    );
  }
  return (
    <NavLink
      to="/comunicados"
      className={({ isActive }) => `focus-ring relative rounded-full p-1.5 hover:bg-surface-alt ${isActive ? "text-primary" : "text-muted hover:text-[var(--color-text)]"}`}
      title={unread ? `${name}: ${unread} ${unread === 1 ? "novo" : "novos"}` : name}
      aria-label={unread ? `${name}, ${unread} não lidos` : name}
    >
      <Newspaper className="h-4 w-4" />
      {unread > 0 && (
        <span className="absolute -right-0.5 -top-0.5 flex h-4 min-w-[16px] items-center justify-center rounded-full bg-primary px-1 text-[10px] font-bold text-primary-fg">{unread > 9 ? "9+" : unread}</span>
      )}
    </NavLink>
  );
}
