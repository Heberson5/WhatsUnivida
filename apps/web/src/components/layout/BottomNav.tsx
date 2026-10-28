import { NavLink } from "react-router-dom";
import clsx from "clsx";
import { MoreHorizontal } from "lucide-react";
import { useVisibleMenuItems } from "./Sidebar";

// A native-app-style bottom tab bar, mobile/tablet only (md:hidden — the
// Sidebar takes over as a regular in-flow column from md up). See PROMPT:
// "abrir em layout de aplicativo... facilitando a navegação e acessos".
// Only the first few permission-visible sections get their own tab (more
// than ~4 doesn't fit readably); everything else — plus any section beyond
// that cutoff — stays one tap away behind "Mais", which opens the same
// drawer the topbar's hamburger button already does.
const MAX_TABS = 4;

export function BottomNav({ onMoreClick }: { onMoreClick: () => void }) {
  const items = useVisibleMenuItems();
  if (items.length === 0) return null;

  const hasOverflow = items.length > MAX_TABS;
  const tabs = hasOverflow ? items.slice(0, MAX_TABS - 1) : items;

  return (
    <nav
      className="flex min-h-[64px] shrink-0 items-stretch border-t border-border bg-surface md:hidden"
      style={{ paddingBottom: "env(safe-area-inset-bottom)" }}
      aria-label="Navegação principal"
    >
      {tabs.map((item) => (
        <NavLink
          key={item.to}
          to={item.to}
          className={({ isActive }) =>
            clsx(
              "focus-ring flex flex-1 flex-col items-center justify-center gap-1 py-2.5 text-xs font-medium",
              isActive ? "text-primary" : "text-muted"
            )
          }
        >
          {({ isActive }) => (
            <>
              <item.icon className="h-6 w-6 shrink-0" strokeWidth={isActive ? 2.5 : 2} aria-hidden />
              <span className="max-w-full truncate px-1 leading-tight">{item.label}</span>
            </>
          )}
        </NavLink>
      ))}
      {hasOverflow && (
        <button
          type="button"
          onClick={onMoreClick}
          className="focus-ring flex flex-1 flex-col items-center justify-center gap-1 py-2.5 text-xs font-medium text-muted"
        >
          <MoreHorizontal className="h-6 w-6 shrink-0" aria-hidden />
          <span className="leading-tight">Mais</span>
        </button>
      )}
    </nav>
  );
}
