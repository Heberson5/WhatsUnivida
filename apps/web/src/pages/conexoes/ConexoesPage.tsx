import { useState } from "react";
import { Globe } from "lucide-react";
import { PERMISSION, type Permission } from "@whatsatendende/types";
import { WhatsAppConnectionPanel } from "./WhatsAppConnectionPanel";
import { WhatsAppOfficialConnectionPanel } from "./WhatsAppOfficialConnectionPanel";
import { MetaConnectionPanel } from "./MetaConnectionPanel";
import { ChannelComingSoonPanel } from "./ChannelComingSoonPanel";
import { useAuthStore } from "../../store/auth-store";

type Tab = "whatsapp" | "whatsapp-oficial" | "instagram" | "facebook" | "site";

const TABS: { key: Tab; label: string }[] = [
  { key: "whatsapp", label: "WhatsApp" },
  { key: "whatsapp-oficial", label: "WhatsApp Oficial" },
  { key: "instagram", label: "Instagram" },
  { key: "facebook", label: "Facebook" },
  { key: "site", label: "Site" },
];

// Same umbrella + per-tab pattern as Configurações — see PROMPT: "crie um
// novo menu chamado Conexões, onde terá a aba WhatsApp, Instagram, Facebook
// e Site". CONEXOES_GERENCIAR (required to reach /conexoes at all) is
// enforced by the route itself; these gate which tab shows. WhatsApp
// Oficial reuses the same CONEXOES_WHATSAPP_* permissions as the QR tab —
// see PROMPT: "inclua uma nova aba chamada WhatsApp Oficial" — both are the
// same WhatsAppConnection resource, just a different linking method.
const TAB_PERMISSION: Record<Tab, Permission> = {
  whatsapp: PERMISSION.CONEXOES_WHATSAPP_VISUALIZAR,
  "whatsapp-oficial": PERMISSION.CONEXOES_WHATSAPP_VISUALIZAR,
  instagram: PERMISSION.CONEXOES_INSTAGRAM_GERENCIAR,
  facebook: PERMISSION.CONEXOES_FACEBOOK_GERENCIAR,
  site: PERMISSION.CONEXOES_SITE_GERENCIAR,
};

export default function ConexoesPage() {
  const [tab, setTab] = useState<Tab>("whatsapp");
  const permissions = useAuthStore((s) => s.permissions);
  const visibleTabs = TABS.filter((t) => permissions?.[TAB_PERMISSION[t.key]]);
  // The default/last-selected tab can be one a role no longer sees — fall
  // back to the first tab that's actually visible instead of rendering
  // nothing (same fallback used in ConfiguracoesPage.tsx).
  const activeTab = visibleTabs.some((t) => t.key === tab) ? tab : visibleTabs[0]?.key;

  return (
    <div className="h-full overflow-auto p-3 sm:p-6">
      <div className="shadow-soft mb-6 flex flex-wrap gap-1 rounded-card border border-border bg-surface p-1">
        {visibleTabs.map((t) => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            className={`rounded-card px-4 py-2 text-sm font-medium ${activeTab === t.key ? "bg-primary text-primary-fg" : "text-muted hover:bg-surface-alt"}`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {activeTab === "whatsapp" && <WhatsAppConnectionPanel />}
      {activeTab === "whatsapp-oficial" && <WhatsAppOfficialConnectionPanel />}
      {activeTab === "instagram" && <MetaConnectionPanel channel="INSTAGRAM" />}
      {activeTab === "facebook" && <MetaConnectionPanel channel="MESSENGER" />}
      {activeTab === "site" && (
        <ChannelComingSoonPanel
          icon={Globe}
          title="Site ainda não conectado"
          description="O widget de chat para o site do cliente está planejado, mas ainda não foi implementado."
        />
      )}
    </div>
  );
}
