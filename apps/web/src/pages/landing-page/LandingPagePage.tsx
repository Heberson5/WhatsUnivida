import { useRef, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { ChevronDown, ChevronUp, MonitorSmartphone, Rows3, Type } from "lucide-react";
import { PERMISSION } from "@whatsatendende/types";
import { useAuthStore } from "../../store/auth-store";
import { api, getApiErrorMessage } from "../../lib/api";
import { useBranding } from "../../hooks/useBranding";
import { useLandingPageSettings } from "../../hooks/useLandingPageSettings";
import { MENU_ITEMS, type MenuItem } from "../../components/layout/Sidebar";
import { TITLES } from "../../components/layout/AppLayout";
import { ICON_LIBRARY } from "../../lib/icon-library";

interface MenuRow {
  to: string;
  defaultLabel: string;
  defaultIcon: MenuItem["icon"];
  label: string;
  iconKey?: string;
}

function seedMenuRows(order: string[], menuItems: Record<string, { label?: string; icon?: string }>): MenuRow[] {
  const orderedTos = order.length > 0 ? [...order, ...MENU_ITEMS.map((i) => i.to).filter((to) => !order.includes(to))] : MENU_ITEMS.map((i) => i.to);
  return orderedTos
    .map((to) => MENU_ITEMS.find((i) => i.to === to))
    .filter((i): i is MenuItem => Boolean(i))
    .map((item) => ({
      to: item.to,
      defaultLabel: item.label,
      defaultIcon: item.icon,
      label: menuItems[item.to]?.label ?? "",
      iconKey: menuItems[item.to]?.icon,
    }));
}

/**
 * Standalone top-level menu (not a Configurações tab) for customizing the
 * login screen, the main menu (shared by Sidebar/BottomNav) and each page's
 * header title — see PROMPT: "planeje um novo menu chamado landing page".
 */
export default function LandingPagePage() {
  const { data: branding } = useBranding();
  const { data: landingPage } = useLandingPageSettings();
  const queryClient = useQueryClient();
  const canEditar = useAuthStore((s) => s.permissions?.[PERMISSION.LANDING_PAGE_EDITAR]);

  // ---- Tela de login ----
  const [logoSize, setLogoSize] = useState(80);
  const [logoAlign, setLogoAlign] = useState<"center" | "left">("center");
  const [subtitle, setSubtitle] = useState("");
  const loginInitialized = useRef(false);
  if (landingPage && !loginInitialized.current) {
    loginInitialized.current = true;
    setLogoSize(landingPage.loginLogoSizePx);
    setLogoAlign(landingPage.loginLogoAlign);
    setSubtitle(landingPage.loginSubtitle ?? "");
  }

  const loginMutation = useMutation({
    mutationFn: () =>
      api.patch("/settings/landing-page", { loginLogoSizePx: logoSize, loginLogoAlign: logoAlign, loginSubtitle: subtitle.trim() || null }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["landing-page"] });
      toast.success("Tela de login atualizada.");
    },
    onError: (err) => toast.error(getApiErrorMessage(err)),
  });

  // ---- Menu principal ----
  const [menuRows, setMenuRows] = useState<MenuRow[]>([]);
  const [openPickerFor, setOpenPickerFor] = useState<string | null>(null);
  const menuInitialized = useRef(false);
  if (landingPage && !menuInitialized.current) {
    menuInitialized.current = true;
    setMenuRows(seedMenuRows(landingPage.menuOrder, landingPage.menuItems));
  }

  function moveRow(index: number, dir: -1 | 1) {
    setMenuRows((rows) => {
      const target = index + dir;
      if (target < 0 || target >= rows.length) return rows;
      const next = [...rows];
      [next[index], next[target]] = [next[target], next[index]];
      return next;
    });
  }

  function updateRow(to: string, patch: Partial<Pick<MenuRow, "label" | "iconKey">>) {
    setMenuRows((rows) => rows.map((r) => (r.to === to ? { ...r, ...patch } : r)));
  }

  const menuMutation = useMutation({
    mutationFn: () => {
      const menuOrder = menuRows.map((r) => r.to);
      const menuItems: Record<string, { label?: string; icon?: string }> = {};
      for (const row of menuRows) {
        const overrides: { label?: string; icon?: string } = {};
        if (row.label.trim()) overrides.label = row.label.trim();
        if (row.iconKey) overrides.icon = row.iconKey;
        if (Object.keys(overrides).length > 0) menuItems[row.to] = overrides;
      }
      return api.patch("/settings/landing-page", { menuOrder, menuItems });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["landing-page"] });
      toast.success("Menu principal atualizado.");
    },
    onError: (err) => toast.error(getApiErrorMessage(err)),
  });

  // ---- Títulos das páginas ----
  const [titles, setTitles] = useState<Record<string, string>>({});
  const titlesInitialized = useRef(false);
  if (landingPage && !titlesInitialized.current) {
    titlesInitialized.current = true;
    const seeded: Record<string, string> = {};
    for (const path of Object.keys(TITLES)) seeded[path] = landingPage.pageTitles[path] ?? "";
    setTitles(seeded);
  }

  const titlesMutation = useMutation({
    mutationFn: () => {
      const pageTitles: Record<string, string> = {};
      for (const [path, value] of Object.entries(titles)) if (value.trim()) pageTitles[path] = value.trim();
      return api.patch("/settings/landing-page", { pageTitles });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["landing-page"] });
      toast.success("Títulos das páginas atualizados.");
    },
    onError: (err) => toast.error(getApiErrorMessage(err)),
  });

  return (
    <div className="h-full overflow-auto p-3 sm:p-6">
      <h1 className="mb-6 text-xl font-semibold">Landing Page</h1>

      <fieldset disabled={!canEditar} className="m-0 max-w-4xl space-y-6 border-0 p-0">
        {/* ---- Tela de login ---- */}
        <div className="shadow-soft rounded-card border border-border bg-surface p-5">
          <div className="mb-1 flex items-center gap-2">
            <MonitorSmartphone className="h-4.5 w-4.5 text-primary" />
            <h2 className="text-base font-semibold">Tela de login</h2>
          </div>
          <p className="mb-4 text-xs text-muted">Tamanho e alinhamento da logo, e o subtítulo mostrado abaixo do nome da empresa.</p>

          <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
            <div className="space-y-4">
              <label className="block">
                <span className="mb-1 block text-sm font-medium">Tamanho da logo ({logoSize}px)</span>
                <input
                  type="range"
                  min={32}
                  max={200}
                  value={logoSize}
                  onChange={(e) => setLogoSize(Number(e.target.value))}
                  className="w-full accent-primary"
                />
              </label>

              <div>
                <span className="mb-1 block text-sm font-medium">Alinhamento</span>
                <div className="flex gap-1 rounded-card border border-border p-1">
                  {(["center", "left"] as const).map((align) => (
                    <button
                      key={align}
                      type="button"
                      onClick={() => setLogoAlign(align)}
                      className={`flex-1 rounded-card px-3 py-1.5 text-sm font-medium ${
                        logoAlign === align ? "bg-primary text-primary-fg" : "text-muted hover:bg-surface-alt"
                      }`}
                    >
                      {align === "center" ? "Centralizado" : "Esquerda"}
                    </button>
                  ))}
                </div>
              </div>

              <label className="block">
                <span className="mb-1 block text-sm font-medium">Subtítulo</span>
                <input
                  value={subtitle}
                  onChange={(e) => setSubtitle(e.target.value)}
                  maxLength={120}
                  placeholder="Plataforma de atendimento via WhatsApp"
                  className="focus-ring w-full rounded-card border border-border bg-transparent px-3 py-2 text-sm"
                />
              </label>

              <button
                onClick={() => loginMutation.mutate()}
                disabled={loginMutation.isPending}
                className="focus-ring rounded-card bg-primary px-4 py-2 text-sm font-semibold text-primary-fg disabled:opacity-60"
              >
                {loginMutation.isPending ? "Salvando..." : "Salvar"}
              </button>
            </div>

            <div>
              <p className="mb-2 text-xs font-medium text-muted">Prévia</p>
              <div className="flex aspect-video w-full items-center justify-center overflow-hidden rounded-lg border border-border bg-[var(--color-bg)] p-6 shadow-inner">
                <div className={`flex flex-col gap-2 ${logoAlign === "left" ? "items-start text-left" : "items-center text-center"}`}>
                  {branding?.logoUrl ? (
                    <img src={branding.logoUrl} alt="" style={{ width: logoSize, height: logoSize }} className="object-contain" />
                  ) : (
                    <div
                      className="flex items-center justify-center rounded-2xl bg-primary font-bold text-primary-fg"
                      style={{ width: logoSize, height: logoSize }}
                    >
                      {(branding?.companyName ?? "WA").slice(0, 2).toUpperCase()}
                    </div>
                  )}
                  <div>
                    <p className="font-semibold">{branding?.companyName ?? "WhatsAtendende"}</p>
                    <p className="text-xs text-muted">{subtitle || "Plataforma de atendimento via WhatsApp"}</p>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* ---- Menu principal ---- */}
        <div className="shadow-soft rounded-card border border-border bg-surface p-5">
          <div className="mb-1 flex items-center gap-2">
            <Rows3 className="h-4.5 w-4.5 text-primary" />
            <h2 className="text-base font-semibold">Menu principal</h2>
          </div>
          <p className="mb-4 text-xs text-muted">Reordene, renomeie e troque o ícone dos itens do menu (barra lateral e barra inferior).</p>

          <div className="space-y-1.5">
            {menuRows.map((row, index) => {
              const Icon = (row.iconKey && ICON_LIBRARY[row.iconKey]) || row.defaultIcon;
              return (
                <div key={row.to} className="flex items-center gap-2 rounded-card border border-border p-2">
                  <div className="flex flex-col">
                    <button
                      type="button"
                      onClick={() => moveRow(index, -1)}
                      disabled={index === 0}
                      className="focus-ring rounded p-0.5 text-muted hover:bg-surface-alt disabled:opacity-30"
                      aria-label="Mover para cima"
                    >
                      <ChevronUp className="h-3.5 w-3.5" />
                    </button>
                    <button
                      type="button"
                      onClick={() => moveRow(index, 1)}
                      disabled={index === menuRows.length - 1}
                      className="focus-ring rounded p-0.5 text-muted hover:bg-surface-alt disabled:opacity-30"
                      aria-label="Mover para baixo"
                    >
                      <ChevronDown className="h-3.5 w-3.5" />
                    </button>
                  </div>

                  <div className="relative shrink-0">
                    <button
                      type="button"
                      onClick={() => setOpenPickerFor(openPickerFor === row.to ? null : row.to)}
                      title="Trocar ícone"
                      className="focus-ring flex h-9 w-9 items-center justify-center rounded-card border border-border hover:bg-surface-alt"
                    >
                      <Icon className="h-4.5 w-4.5" />
                    </button>
                    {openPickerFor === row.to && (
                      <>
                        <button className="fixed inset-0 z-10 cursor-default" onClick={() => setOpenPickerFor(null)} aria-label="Fechar seletor de ícone" />
                        <div className="shadow-soft absolute left-0 top-full z-20 mt-1 grid w-56 grid-cols-6 gap-1 rounded-card border border-border bg-surface p-2">
                          {Object.entries(ICON_LIBRARY).map(([key, LibIcon]) => (
                            <button
                              key={key}
                              type="button"
                              onClick={() => {
                                updateRow(row.to, { iconKey: key });
                                setOpenPickerFor(null);
                              }}
                              className={`focus-ring flex h-8 w-8 items-center justify-center rounded ${
                                row.iconKey === key ? "bg-primary text-primary-fg" : "hover:bg-surface-alt"
                              }`}
                            >
                              <LibIcon className="h-4 w-4" />
                            </button>
                          ))}
                        </div>
                      </>
                    )}
                  </div>

                  <input
                    value={row.label}
                    onChange={(e) => updateRow(row.to, { label: e.target.value })}
                    placeholder={row.defaultLabel}
                    maxLength={30}
                    className="focus-ring min-w-0 flex-1 rounded-card border border-border bg-transparent px-3 py-1.5 text-sm"
                  />
                </div>
              );
            })}
          </div>

          <button
            onClick={() => menuMutation.mutate()}
            disabled={menuMutation.isPending}
            className="focus-ring mt-4 rounded-card bg-primary px-4 py-2 text-sm font-semibold text-primary-fg disabled:opacity-60"
          >
            {menuMutation.isPending ? "Salvando..." : "Salvar"}
          </button>
        </div>

        {/* ---- Títulos das páginas ---- */}
        <div className="shadow-soft rounded-card border border-border bg-surface p-5">
          <div className="mb-1 flex items-center gap-2">
            <Type className="h-4.5 w-4.5 text-primary" />
            <h2 className="text-base font-semibold">Títulos das páginas</h2>
          </div>
          <p className="mb-4 text-xs text-muted">O texto mostrado no topo de cada tela.</p>

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            {Object.entries(TITLES).map(([path, defaultTitle]) => (
              <label key={path} className="block">
                <span className="mb-1 block text-sm font-medium">{defaultTitle}</span>
                <input
                  value={titles[path] ?? ""}
                  onChange={(e) => setTitles((t) => ({ ...t, [path]: e.target.value }))}
                  placeholder={defaultTitle}
                  maxLength={40}
                  className="focus-ring w-full rounded-card border border-border bg-transparent px-3 py-2 text-sm"
                />
              </label>
            ))}
          </div>

          <button
            onClick={() => titlesMutation.mutate()}
            disabled={titlesMutation.isPending}
            className="focus-ring mt-4 rounded-card bg-primary px-4 py-2 text-sm font-semibold text-primary-fg disabled:opacity-60"
          >
            {titlesMutation.isPending ? "Salvando..." : "Salvar"}
          </button>
        </div>
      </fieldset>
    </div>
  );
}
