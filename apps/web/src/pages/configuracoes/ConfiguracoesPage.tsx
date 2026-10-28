import { useState } from "react";
import { WhatsAppConnectionPanel } from "./WhatsAppConnectionPanel";
import { BrandingPanel } from "./BrandingPanel";
import { AppInstallPanel } from "./AppInstallPanel";
import { FeriadosPanel } from "./FeriadosPanel";
import { EmailSettingsPanel } from "./EmailSettingsPanel";
import { EmailTemplatesPanel } from "./EmailTemplatesPanel";
import { PermissionsPanel } from "./PermissionsPanel";
import { SecuritySettingsPanel } from "./SecuritySettingsPanel";
import { useAuthStore } from "../../store/auth-store";

type Tab = "whatsapp" | "branding" | "email" | "email-templates" | "feriados" | "seguranca" | "permissoes";

const TABS: { key: Tab; label: string }[] = [
  { key: "whatsapp", label: "WhatsApp" },
  { key: "branding", label: "Identidade visual" },
  { key: "email", label: "E-mail" },
  { key: "email-templates", label: "Modelos de e-mail" },
  { key: "feriados", label: "Feriados" },
  { key: "seguranca", label: "Segurança" },
  { key: "permissoes", label: "Permissões" },
];

export default function ConfiguracoesPage() {
  const [tab, setTab] = useState<Tab>("whatsapp");
  const role = useAuthStore((s) => s.user?.role);
  // Configurações itself can be reached by a MANAGER granted the
  // "configuracoes.gerenciar" permission, but the permissions matrix and
  // session/security settings are always ADMIN-only — hiding these tabs for
  // anyone else keeps the UI honest about what they can do. (The permissions
  // matrix is enforced ADMIN-only on the backend too, see
  // permissions.routes.ts; PATCH /settings/business is enforced only by the
  // configuracoes.gerenciar permission, same as the other Configurações
  // tabs — this is a UI-only restriction, not a backend one.)
  const visibleTabs = TABS.filter((t) => (t.key !== "permissoes" && t.key !== "seguranca") || role === "ADMIN");

  return (
    <div className="h-full overflow-auto p-3 sm:p-6">
      <div className="shadow-soft mb-6 flex w-fit gap-1 rounded-card border border-border bg-surface p-1">
        {visibleTabs.map((t) => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            className={`rounded-card px-4 py-2 text-sm font-medium ${tab === t.key ? "bg-primary text-primary-fg" : "text-muted hover:bg-surface-alt"}`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {tab === "whatsapp" && <WhatsAppConnectionPanel />}
      {tab === "branding" && (
        <div className="space-y-6">
          <BrandingPanel />
          <AppInstallPanel />
        </div>
      )}
      {tab === "email" && <EmailSettingsPanel />}
      {tab === "email-templates" && <EmailTemplatesPanel />}
      {tab === "feriados" && <FeriadosPanel />}
      {tab === "seguranca" && role === "ADMIN" && <SecuritySettingsPanel />}
      {tab === "permissoes" && role === "ADMIN" && <PermissionsPanel />}
    </div>
  );
}
