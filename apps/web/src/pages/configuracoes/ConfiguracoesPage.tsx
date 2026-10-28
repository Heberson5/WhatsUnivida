import { useSearchParams } from "react-router-dom";
import clsx from "clsx";
import { Clock3, Columns3, DatabaseBackup, FileDown, KeyRound, Mail, MailPlus, Palette, Phone, ShieldCheck, CalendarDays, Sparkles, type LucideIcon } from "lucide-react";
import { PERMISSION, type Permission } from "@whatsatendende/types";
import { BrandingPanel } from "./BrandingPanel";
import { AppInstallPanel } from "./AppInstallPanel";
import { ExportacoesPanel } from "./ExportacoesPanel";
import { FeriadosPanel } from "./FeriadosPanel";
import { FilaSettingsPanel } from "./FilaSettingsPanel";
import { NumerosTelefonePanel } from "./NumerosTelefonePanel";
import { EmailSettingsPanel } from "./EmailSettingsPanel";
import { EmailTemplatesPanel } from "./EmailTemplatesPanel";
import { NotasDeVersaoAdminPanel } from "./NotasDeVersaoAdminPanel";
import { PermissionsPanel } from "./PermissionsPanel";
import { SecuritySettingsPanel } from "./SecuritySettingsPanel";
import { VisoesColunasPanel } from "./VisoesColunasPanel";
import { BackupPanel } from "./BackupPanel";
import { useAuthStore } from "../../store/auth-store";

type Tab = "branding" | "exportacoes" | "email" | "email-templates" | "feriados" | "fila" | "telefone" | "seguranca" | "permissoes" | "notas-de-versao" | "visoes" | "backup";

// Grouped by subject in the left-hand section menu.
const TABS: { key: Tab; label: string; group: string; icon: LucideIcon }[] = [
  { key: "fila", label: "Fila", group: "Atendimento", icon: Clock3 },
  { key: "feriados", label: "Feriados", group: "Atendimento", icon: CalendarDays },
  { key: "telefone", label: "Números de telefone", group: "Atendimento", icon: Phone },
  { key: "branding", label: "Identidade visual", group: "Aparência", icon: Palette },
  { key: "exportacoes", label: "Exportações", group: "Aparência", icon: FileDown },
  { key: "visoes", label: "Visões de colunas", group: "Aparência", icon: Columns3 },
  { key: "email", label: "E-mail", group: "E-mail", icon: Mail },
  { key: "email-templates", label: "Modelos de e-mail", group: "E-mail", icon: MailPlus },
  { key: "seguranca", label: "Segurança", group: "Segurança", icon: ShieldCheck },
  { key: "permissoes", label: "Permissões", group: "Segurança", icon: KeyRound },
  { key: "notas-de-versao", label: "Notas de versão", group: "Sistema", icon: Sparkles },
  { key: "backup", label: "Backup", group: "Sistema", icon: DatabaseBackup },
];

// Each sits behind its own finer permission on top of the CONFIGURACOES_GERENCIAR
// umbrella already required to reach /configuracoes at all (see Sidebar's
// MENU_ITEMS) — see PROMPT: "Mapeie todos os menus e o que tem dentro dos
// menus e inclua nas permissões". seguranca/permissoes have no entry — they
// stay ADMIN-only, checked separately below, same as before this feature.
const TAB_PERMISSION: Partial<Record<Tab, Permission>> = {
  branding: PERMISSION.CONFIGURACOES_IDENTIDADE_VISUALIZAR,
  // Its own logo/cor/nome (independent from Identidade visual) — sits
  // behind the same identity-flavored permission rather than a new one.
  exportacoes: PERMISSION.CONFIGURACOES_IDENTIDADE_VISUALIZAR,
  email: PERMISSION.CONFIGURACOES_EMAIL_VISUALIZAR,
  "email-templates": PERMISSION.CONFIGURACOES_EMAIL_MODELOS_VISUALIZAR,
  feriados: PERMISSION.CONFIGURACOES_FERIADOS_VISUALIZAR,
  fila: PERMISSION.CONFIGURACOES_FILA_VISUALIZAR,
  telefone: PERMISSION.CONFIGURACOES_TELEFONE_VISUALIZAR,
  visoes: PERMISSION.CONFIGURACOES_VISOES_VISUALIZAR,
};

export default function ConfiguracoesPage() {
  // Kept in the URL (?secao=) so a reload or a shared link opens the same section.
  const [searchParams, setSearchParams] = useSearchParams();
  const tab = (searchParams.get("secao") as Tab | null) ?? "branding";
  const setTab = (next: Tab) =>
    setSearchParams(
      (prev) => {
        const params = new URLSearchParams(prev);
        params.set("secao", next);
        return params;
      },
      { replace: true }
    );
  const role = useAuthStore((s) => s.user?.role);
  const permissions = useAuthStore((s) => s.permissions);
  // Configurações itself can be reached by a MANAGER granted the
  // "configuracoes.gerenciar" permission, but the permissions matrix and
  // session/security settings are always ADMIN-only — hiding these tabs for
  // anyone else keeps the UI honest about what they can do. (The permissions
  // matrix is enforced ADMIN-only on the backend too, see
  // permissions.routes.ts; PATCH /settings/business is enforced only by the
  // configuracoes.gerenciar permission, same as the other Configurações
  // tabs — this is a UI-only restriction, not a backend one.)
  const visibleTabs = TABS.filter((t) => {
    // Notas de versão is edited by administrators only (enforced by the API too — release-notes.routes.ts).
    if (t.key === "permissoes" || t.key === "seguranca" || t.key === "notas-de-versao" || t.key === "backup") return role === "ADMIN";
    const permission = TAB_PERMISSION[t.key];
    return !permission || permissions?.[permission];
  });
  // The default/last-selected tab can be one a role no longer sees (e.g. an
  // admin restricted a tab for this manager specifically) — fall back to the
  // first tab that's actually visible instead of rendering nothing.
  const activeTab = visibleTabs.some((t) => t.key === tab) ? tab : visibleTabs[0]?.key;

  const groups = Array.from(new Set(visibleTabs.map((t) => t.group)));

  return (
    <div className="flex h-full flex-col overflow-hidden md:flex-row">
      <nav
        aria-label="Seções de configurações"
        className="flex shrink-0 gap-1 overflow-x-auto border-b border-border bg-surface p-2 md:w-56 md:flex-col md:overflow-y-auto md:border-b-0 md:border-r md:p-3"
      >
        {groups.map((group) => (
          <div key={group} className="flex shrink-0 gap-1 md:block md:space-y-0.5">
            <p className="hidden px-2.5 pb-1 pt-3 text-[10px] font-semibold uppercase tracking-[0.08em] text-muted first:pt-1 md:block">{group}</p>
            {visibleTabs
              .filter((t) => t.group === group)
              .map((t) => (
                <button
                  key={t.key}
                  onClick={() => setTab(t.key)}
                  aria-current={activeTab === t.key ? "page" : undefined}
                  className={clsx(
                    "focus-ring flex shrink-0 items-center gap-2.5 whitespace-nowrap rounded-lg px-2.5 py-2 text-[13px] md:w-full",
                    activeTab === t.key ? "bg-primary/10 font-semibold text-primary" : "text-[var(--color-text)] hover:bg-surface-alt"
                  )}
                >
                  <t.icon className="h-4 w-4 shrink-0" />
                  {t.label}
                </button>
              ))}
          </div>
        ))}
      </nav>

      <div className="min-w-0 flex-1 overflow-auto bg-[var(--color-bg)] p-3 sm:p-6">
        {activeTab === "branding" && (
          <div className="space-y-6">
            <BrandingPanel />
            <AppInstallPanel />
          </div>
        )}
        {activeTab === "exportacoes" && <ExportacoesPanel />}
        {activeTab === "email" && <EmailSettingsPanel />}
        {activeTab === "email-templates" && <EmailTemplatesPanel />}
        {activeTab === "feriados" && <FeriadosPanel />}
        {activeTab === "fila" && <FilaSettingsPanel />}
        {activeTab === "telefone" && <NumerosTelefonePanel />}
        {activeTab === "visoes" && <VisoesColunasPanel />}
        {activeTab === "seguranca" && role === "ADMIN" && <SecuritySettingsPanel />}
        {activeTab === "permissoes" && role === "ADMIN" && <PermissionsPanel />}
        {activeTab === "notas-de-versao" && role === "ADMIN" && <NotasDeVersaoAdminPanel />}
        {activeTab === "backup" && role === "ADMIN" && <BackupPanel />}
      </div>
    </div>
  );
}
