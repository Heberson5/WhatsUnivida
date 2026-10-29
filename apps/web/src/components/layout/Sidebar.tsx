import { NavLink } from "react-router-dom";
import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import clsx from "clsx";
import {
  MessageCircle,
  MessagesSquare,
  Eye,
  LayoutDashboard,
  FileBarChart,
  Users,
  Settings,
  ScrollText,
  ChevronLeft,
  ChevronRight,
  X,
  Slash,
  MonitorSmartphone,
  Plug,
  Workflow,
  Sparkles,
  Contact,
  Tag,
  Database,
  Megaphone,
} from "lucide-react";
import { PERMISSION, type ConversationListItemDTO, type GroupsSummaryDTO, type Permission, type WhatsAppConnectionStatus } from "@whatsatendende/types";
import { api } from "../../lib/api";
import { useAuthStore } from "../../store/auth-store";
import { useBranding } from "../../hooks/useBranding";
import { useLandingPageSettings } from "../../hooks/useLandingPageSettings";
import { ICON_LIBRARY } from "../../lib/icon-library";
import { useReleaseNotes } from "../../hooks/useReleaseNotes";

export type MenuGroup = "Operação" | "Análise" | "Automação" | "Administração";
const GROUP_ORDER: MenuGroup[] = ["Operação", "Análise", "Automação", "Administração"];
const UNLINKED_STATES: WhatsAppConnectionStatus[] = ["DISCONNECTED", "QR_PENDING", "CODE_PENDING"];

export interface MenuItem {
  to: string;
  label: string;
  icon: typeof MessagesSquare;
  permission: Permission;
  group: MenuGroup;
}

// What's shown here is governed by Configurações > Permissões, not a fixed
// role list — an ADMIN always sees everything (their permissions are always
// all-true), while AGENT/MANAGER visibility follows whatever's configured.
// Exported so BottomNav can build its own (permission-filtered, same order)
// mobile tab bar from the exact same list instead of duplicating it.
export const MENU_ITEMS: MenuItem[] = [
  { to: "/atendimento", label: "Atendimento", icon: MessagesSquare, permission: PERMISSION.ATENDIMENTO_ACESSAR, group: "Operação" },
  { to: "/gestao", label: "Gestão", icon: Eye, permission: PERMISSION.GESTAO_ACESSAR, group: "Operação" },
  { to: "/acompanhar-chat", label: "Chat interno", icon: MessageCircle, permission: PERMISSION.CHAT_INTERNO_ACOMPANHAR, group: "Operação" },
  { to: "/contatos", label: "Contatos", icon: Contact, permission: PERMISSION.CONTATOS_ACESSAR, group: "Operação" },
  { to: "/dashboard", label: "Dashboard", icon: LayoutDashboard, permission: PERMISSION.DASHBOARD_ACESSAR, group: "Análise" },
  { to: "/relatorios", label: "Relatórios", icon: FileBarChart, permission: PERMISSION.RELATORIOS_ACESSAR, group: "Análise" },
  { to: "/respostas", label: "Respostas", icon: Slash, permission: PERMISSION.RESPOSTAS_RAPIDAS_GERENCIAR, group: "Automação" },
  { to: "/popup", label: "Pop Up", icon: Megaphone, permission: PERMISSION.POPUP_ACESSAR, group: "Automação" },
  { to: "/fluxo", label: "Fluxo", icon: Workflow, permission: PERMISSION.FLUXO_VISUALIZAR, group: "Automação" },
  { to: "/etiquetas", label: "Etiquetas", icon: Tag, permission: PERMISSION.ETIQUETAS_VISUALIZAR, group: "Automação" },
  { to: "/dados", label: "Dados", icon: Database, permission: PERMISSION.FONTES_DADOS_VER, group: "Automação" },
  { to: "/usuarios", label: "Usuários", icon: Users, permission: PERMISSION.USUARIOS_VISUALIZAR, group: "Administração" },
  { to: "/conexoes", label: "Conexões", icon: Plug, permission: PERMISSION.CONEXOES_GERENCIAR, group: "Administração" },
  { to: "/configuracoes", label: "Configurações", icon: Settings, permission: PERMISSION.CONFIGURACOES_GERENCIAR, group: "Administração" },
  { to: "/landing-page", label: "Landing Page", icon: MonitorSmartphone, permission: PERMISSION.LANDING_PAGE_VISUALIZAR, group: "Administração" },
  { to: "/auditoria", label: "Auditoria", icon: ScrollText, permission: PERMISSION.AUDITORIA_ACESSAR, group: "Administração" },
];

/**
 * Same permission filter (and now label/icon/order customization) Sidebar
 * and BottomNav both need, kept in one place so they can never drift apart.
 * Order/label/icon come from the Landing Page settings — see
 * LandingPagePage.tsx's "Menu principal" section. The custom order applies
 * within each group; the groups themselves always keep GROUP_ORDER.
 */
export function useVisibleMenuItems(): MenuItem[] {
  const user = useAuthStore((s) => s.user);
  const permissions = useAuthStore((s) => s.permissions);
  const { data: landingPage } = useLandingPageSettings();

  const visible = MENU_ITEMS.filter((item) => user && permissions?.[item.permission]).map((item) => {
    const override = landingPage?.menuItems[item.to];
    const icon = (override?.icon && ICON_LIBRARY[override.icon]) || item.icon;
    return { ...item, label: override?.label || item.label, icon };
  });

  const order = landingPage?.menuOrder ?? [];
  // Items not in `order` keep MAX_SAFE_INTEGER, so they stay in their natural
  // relative order, after the ones explicitly ordered.
  const indexOf = (to: string) => {
    const i = order.indexOf(to);
    return i === -1 ? Number.MAX_SAFE_INTEGER : i;
  };
  return [...visible].sort(
    (a, b) => GROUP_ORDER.indexOf(a.group) - GROUP_ORDER.indexOf(b.group) || indexOf(a.to) - indexOf(b.to)
  );
}

interface MenuBadge {
  count: number;
  tone: "queue" | "alert";
  label: string;
}

/** Counters next to menu items: conversations waiting in the queue, and QR Code connections that dropped. */
export function useMenuBadges(): Record<string, MenuBadge | undefined> {
  const permissions = useAuthStore((s) => s.permissions);
  const canAttend = Boolean(permissions?.[PERMISSION.ATENDIMENTO_ACESSAR]);
  const canSeeConnections = Boolean(permissions?.[PERMISSION.CONEXOES_GERENCIAR]);

  // Shares the "queue" prefix with AtendimentoPage's own query, so every
  // place that invalidates ["queue"] (socket events, accept) refreshes this too.
  const { data: queue } = useQuery({
    queryKey: ["queue", "menu-badge"],
    queryFn: async () => (await api.get<ConversationListItemDTO[]>("/conversations/queue")).data,
    enabled: canAttend,
    refetchInterval: 30_000,
  });
  const { data: connections } = useQuery({
    queryKey: ["whatsapp-connections"],
    queryFn: async () =>
      (await api.get<{ id: string; state: WhatsAppConnectionStatus; connectionMode: "QRCODE" | "OFFICIAL_API" }[]>("/whatsapp/connections")).data,
    enabled: canSeeConnections,
    refetchInterval: 60_000,
  });

  const canSeeGroups = Boolean(permissions?.[PERMISSION.ATENDIMENTO_GRUPOS_VISUALIZAR]);
  // Shares the "groups" prefix with Atendimento's list, so the same socket events refresh it.
  const { data: groupsSummary } = useQuery({
    queryKey: ["groups", "summary"],
    queryFn: async () => (await api.get<GroupsSummaryDTO>("/groups/summary")).data,
    enabled: canAttend && canSeeGroups,
    refetchInterval: 60_000,
  });

  const queueCount = queue?.length ?? 0;
  const groupsUnread = groupsSummary?.groupsWithUnread ?? 0;
  const attendCount = queueCount + groupsUnread;
  const attendLabel = [
    queueCount ? `${queueCount} na fila` : null,
    groupsUnread ? `${groupsUnread} ${groupsUnread === 1 ? "grupo com mensagens não lidas" : "grupos com mensagens não lidas"}` : null,
  ]
    .filter(Boolean)
    .join(" · ");
  // Not linked: dropped, or asking for a new QR Code / code (a session WhatsApp logged out lands here too).
  const droppedCount = connections?.filter((c) => c.connectionMode === "QRCODE" && UNLINKED_STATES.includes(c.state)).length ?? 0;
  return {
    "/atendimento": attendCount ? { count: attendCount, tone: "queue", label: attendLabel } : undefined,
    "/conexoes": droppedCount
      ? { count: droppedCount, tone: "alert", label: `${droppedCount} ${droppedCount === 1 ? "conexão desconectada" : "conexões desconectadas"}` }
      : undefined,
  };
}

function navItemClass(isActive: boolean, isCollapsed: boolean) {
  return clsx(
    "focus-ring relative flex items-center rounded-lg text-[13px] font-medium transition-colors",
    isCollapsed ? "justify-center p-2.5" : "gap-3 px-2.5 py-2",
    isActive ? "bg-primary/15 text-side-strong shadow-[inset_2px_0_0_var(--color-primary)]" : "text-side-text hover:bg-side-hover hover:text-side-strong"
  );
}

const COLLAPSED_KEY = "sidebar-collapsed";

function readCollapsed() {
  try {
    return localStorage.getItem(COLLAPSED_KEY) === "1";
  } catch {
    return false;
  }
}

export function Sidebar({ mobileOpen = false, onMobileClose }: { mobileOpen?: boolean; onMobileClose?: () => void }) {
  // Remembered per browser, so each agent's choice survives reloads.
  const [collapsed, setCollapsed] = useState(readCollapsed);
  useEffect(() => {
    try {
      localStorage.setItem(COLLAPSED_KEY, collapsed ? "1" : "0");
    } catch {
      // storage blocked: the choice just won't persist
    }
  }, [collapsed]);
  // Fixed-position tooltip for the icon-only menu: the nav scrolls, so an
  // absolutely-positioned child would be clipped by it.
  const [tooltip, setTooltip] = useState<{ text: string; top: number; left: number } | null>(null);
  const { data: branding } = useBranding();
  const visibleItems = useVisibleMenuItems();
  const badges = useMenuBadges();
  const { hasUnseen: hasUnseenReleaseNotes } = useReleaseNotes();
  const releaseNotesLabel = hasUnseenReleaseNotes ? "Notas de versão · novidades" : "Notas de versão";
  // The off-canvas drawer on mobile is always shown expanded.
  const isCollapsed = collapsed && !mobileOpen;

  const groups = GROUP_ORDER.map((group) => ({ group, items: visibleItems.filter((i) => i.group === group) })).filter(
    (g) => g.items.length > 0
  );

  function showTooltip(e: React.MouseEvent | React.FocusEvent, text: string) {
    if (!isCollapsed) return;
    const rect = e.currentTarget.getBoundingClientRect();
    setTooltip({ text, top: rect.top + rect.height / 2, left: rect.right + 10 });
  }

  return (
    <>
      {/* Backdrop: only ever rendered (and interactive) on mobile, where the
          sidebar becomes an off-canvas overlay instead of sitting in flow. */}
      {mobileOpen && <div className="fixed inset-0 z-30 bg-black/40 md:hidden" onClick={onMobileClose} aria-hidden />}
      <div className="md:relative md:h-full md:shrink-0">
      <aside
        className={clsx(
          "shadow-soft fixed inset-y-0 left-0 z-40 flex h-dvh w-64 flex-col overflow-hidden rounded-r-card bg-side text-side-text transition-transform duration-200 md:relative md:inset-auto md:z-10 md:h-full md:translate-x-0 md:rounded-card md:transition-all",
          mobileOpen ? "translate-x-0" : "-translate-x-full",
          isCollapsed ? "md:w-[68px]" : "md:w-60"
        )}
      >
        <div className={clsx("flex h-16 shrink-0 items-center", isCollapsed ? "justify-center px-3" : "gap-2.5 px-4")}>
          {/* The App icon (Identidade visual) — the same square the phone shows — and the logo when there's no icon. */}
          {branding?.appIconUrl ? (
            <img src={branding.appIconUrl} alt={branding.appName ?? branding.companyName} className="h-8 w-8 shrink-0 rounded-lg object-cover shadow-sm" />
          ) : branding?.logoUrl ? (
            <img src={branding.logoUrl} alt={branding.companyName} className="h-8 w-8 shrink-0 rounded-lg bg-white object-contain ring-1 ring-side-border p-0.5" />
          ) : (
            <div
              className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-primary text-sm font-bold text-primary-fg"
              style={{ backgroundImage: "linear-gradient(145deg, rgba(255,255,255,0.28), rgba(255,255,255,0) 60%)" }}
            >
              {(branding?.companyName ?? "WA").slice(0, 2).toUpperCase()}
            </div>
          )}
          {!isCollapsed && <span className="flex-1 truncate text-sm font-semibold text-side-strong">{branding?.companyName ?? "WhatsAtendende"}</span>}
          <button
            type="button"
            onClick={onMobileClose}
            className="focus-ring flex h-7 w-7 shrink-0 items-center justify-center rounded-lg border border-side-border text-side-muted hover:text-side-strong md:hidden"
            aria-label="Fechar menu"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <nav
          className={clsx("flex-1 overflow-y-auto overflow-x-hidden pb-3", isCollapsed ? "px-2.5" : "px-3")}
          aria-label="Menu principal"
          onScroll={() => setTooltip(null)}
        >
          {groups.map(({ group, items }, groupIndex) => (
            <div key={group} role="group" aria-label={group}>
              {isCollapsed ? (
                groupIndex > 0 && <div className="mx-auto my-2 h-px w-6 bg-side-border" aria-hidden />
              ) : (
                <p
                  className={clsx(
                    "px-2.5 pb-1 text-[10px] font-semibold uppercase tracking-[0.08em] text-side-muted",
                    groupIndex === 0 ? "pt-1" : "pt-4"
                  )}
                >
                  {group}
                </p>
              )}
              <div className="space-y-0.5">
                {items.map((item) => {
                  const badge = badges[item.to];
                  const tooltipText = badge ? `${item.label} · ${badge.label}` : item.label;
                  return (
                    <NavLink
                      key={item.to}
                      to={item.to}
                      onClick={() => {
                        setTooltip(null);
                        onMobileClose?.();
                      }}
                      onMouseEnter={(e) => showTooltip(e, tooltipText)}
                      onMouseLeave={() => setTooltip(null)}
                      onFocus={(e) => showTooltip(e, tooltipText)}
                      onBlur={() => setTooltip(null)}
                      className={({ isActive }) => navItemClass(isActive, isCollapsed)}
                      aria-label={isCollapsed || badge ? tooltipText : undefined}
                    >
                      <item.icon className="h-[18px] w-[18px] shrink-0" aria-hidden />
                      {!isCollapsed && <span className="flex-1 truncate">{item.label}</span>}
                      {badge && (
                        <span
                          className={clsx(
                            "flex items-center justify-center rounded-full font-bold",
                            badge.tone === "queue" ? "bg-secondary text-secondary-fg" : "bg-danger text-white",
                            isCollapsed
                              ? "absolute right-0.5 top-0.5 h-4 min-w-[16px] px-1 text-[9px]"
                              : "h-[18px] min-w-[18px] px-1.5 text-[10.5px]"
                          )}
                          aria-hidden
                        >
                          {badge.count}
                        </span>
                      )}
                    </NavLink>
                  );
                })}
              </div>
            </div>
          ))}
        </nav>

        <div className={clsx("shrink-0 border-t border-side-border py-2", isCollapsed ? "px-2.5" : "px-3")}>
          <NavLink
            to="/notas-de-versao"
            onClick={() => {
              setTooltip(null);
              onMobileClose?.();
            }}
            onMouseEnter={(e) => showTooltip(e, releaseNotesLabel)}
            onMouseLeave={() => setTooltip(null)}
            onFocus={(e) => showTooltip(e, releaseNotesLabel)}
            onBlur={() => setTooltip(null)}
            className={({ isActive }) => navItemClass(isActive, isCollapsed)}
            aria-label={isCollapsed || hasUnseenReleaseNotes ? releaseNotesLabel : undefined}
          >
            <Sparkles className="h-[18px] w-[18px] shrink-0" aria-hidden />
            {!isCollapsed && <span className="flex-1 truncate">Notas de versão</span>}
            {hasUnseenReleaseNotes &&
              (isCollapsed ? (
                <span className="absolute right-1.5 top-1.5 h-2 w-2 rounded-full bg-secondary ring-2 ring-side" aria-hidden />
              ) : (
                <span className="rounded-full bg-secondary px-1.5 py-px text-[10px] font-bold text-secondary-fg" aria-hidden>
                  Novo
                </span>
              ))}
          </NavLink>
        </div>

        {!isCollapsed &&
          branding?.appVersion && (
            <NavLink
              to="/notas-de-versao"
              onClick={onMobileClose}
              className="focus-ring shrink-0 px-4 pb-2 text-xs text-side-muted hover:text-side-strong"
              title="Ver as notas de versão"
            >
              Versão {branding.appVersion}
            </NavLink>
          )}
      </aside>
      {/* Discreet arrow on the sidebar's top edge — collapses or expands it (desktop only; on mobile the sidebar is an overlay). */}
      <button
        type="button"
        onClick={() => setCollapsed((c) => !c)}
        className="focus-ring absolute -right-3 top-5 z-20 hidden h-6 w-6 items-center justify-center rounded-full border border-border bg-surface text-muted shadow-sm transition-colors hover:border-primary/40 hover:text-primary md:flex"
        aria-label={isCollapsed ? "Expandir menu" : "Recolher menu"}
        title={isCollapsed ? "Expandir menu" : "Recolher menu"}
      >
        {isCollapsed ? <ChevronRight className="h-3.5 w-3.5" /> : <ChevronLeft className="h-3.5 w-3.5" />}
      </button>
      </div>
      {tooltip && isCollapsed && (
        <div
          role="tooltip"
          className="pointer-events-none fixed z-50 -translate-y-1/2 whitespace-nowrap rounded-md border border-border bg-surface px-2 py-1 text-xs font-semibold text-[var(--color-text)] shadow-elevated"
          style={{ top: tooltip.top, left: tooltip.left }}
        >
          {tooltip.text}
        </div>
      )}
    </>
  );
}
