import { useState } from "react";
import { Cake, Megaphone, Trash2 } from "lucide-react";
import { PERMISSION, type Permission } from "@whatsatendende/types";
import { useAuthStore } from "../../store/auth-store";
import { AniversariosTab } from "./AniversariosTab";
import { AvisosTab } from "./AvisosTab";
import { LixeiraTab } from "./LixeiraTab";

type Tab = "aniversarios" | "avisos" | "lixeira";

// Reaching /popup already requires POPUP_ACESSAR (see Sidebar's MENU_ITEMS); each tab has its own permission on top.
const TAB_PERMISSION: Record<Tab, Permission> = {
  aniversarios: PERMISSION.RESPOSTAS_ANIVERSARIO_VISUALIZAR,
  avisos: PERMISSION.POPUP_AVISOS_VISUALIZAR,
  lixeira: PERMISSION.POPUP_LIXEIRA_GERENCIAR,
};

const TABS: { key: Tab; label: string; icon: typeof Cake }[] = [
  { key: "avisos", label: "Avisos", icon: Megaphone },
  { key: "aniversarios", label: "Aniversários", icon: Cake },
  { key: "lixeira", label: "Lixeira", icon: Trash2 },
];

/** Automação › Pop Up: what pops up on screen — the birthday notice in a conversation and the notices after login. */
export default function PopUpPage() {
  const permissions = useAuthStore((s) => s.permissions);
  const visibleTabs = TABS.filter((t) => permissions?.[TAB_PERMISSION[t.key]]);
  const [picked, setPicked] = useState<Tab | null>(null);
  const tab = picked && visibleTabs.some((t) => t.key === picked) ? picked : visibleTabs[0]?.key;

  return (
    <div className="flex h-full flex-col overflow-hidden p-3 sm:p-6">
      <div className="mb-4 flex overflow-x-auto border-b border-border">
        {visibleTabs.map((t) => (
          <button
            key={t.key}
            onClick={() => setPicked(t.key)}
            className={`flex flex-1 shrink-0 items-center justify-center gap-1.5 whitespace-nowrap px-4 py-3 text-sm font-medium sm:flex-none sm:px-6 ${
              tab === t.key ? "border-b-2 border-primary text-primary" : "text-muted"
            }`}
          >
            <t.icon className="h-4 w-4 shrink-0" /> {t.label}
          </button>
        ))}
      </div>

      <div className="flex-1 overflow-hidden">
        {tab === "aniversarios" && <AniversariosTab />}
        {tab === "avisos" && <AvisosTab />}
        {tab === "lixeira" && <LixeiraTab />}
        {!tab && <p className="text-sm text-muted">Você não tem acesso a nenhuma aba do Pop Up.</p>}
      </div>
    </div>
  );
}
