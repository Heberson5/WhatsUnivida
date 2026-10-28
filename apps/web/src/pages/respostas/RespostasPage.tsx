import { useState } from "react";
import { Slash, LogOut, ArrowRightLeft, UserCheck, PauseCircle, FileText, Star, Clock, Hourglass, Cake } from "lucide-react";
import { PERMISSION, type Permission } from "@whatsatendende/types";
import { useAuthStore } from "../../store/auth-store";
import { RespostasRapidasTab } from "./RespostasRapidasTab";
import { EncerramentoTab } from "./EncerramentoTab";
import { AutoMessageTab } from "./AutoMessageTab";
import { MotivoPausaTab } from "./MotivoPausaTab";
import { TemplatesTab } from "./TemplatesTab";
import { PesquisaTab } from "./PesquisaTab";
import { ExpedienteTab } from "./ExpedienteTab";
import { EsperaFilaTab } from "./EsperaFilaTab";
import { AniversariosTab } from "./AniversariosTab";

type Tab = "rapidas" | "encerramento" | "transferencia" | "aceite" | "motivo-pausa" | "templates" | "pesquisa" | "expediente" | "espera" | "aniversarios";

// Reaching /respostas at all already requires the RESPOSTAS_RAPIDAS_GERENCIAR
// umbrella (see Sidebar's MENU_ITEMS) — each tab below additionally sits
// behind its own visualizar/adicionar/editar/excluir granular set on top of
// that umbrella. See PROMPT: "na me referi em apenas as pausas, mas sim tudo
// que é evitável, cadastravel e visualizarem".
const TAB_PERMISSION: Partial<Record<Tab, Permission>> = {
  rapidas: PERMISSION.RESPOSTAS_RAPIDAS_VISUALIZAR,
  encerramento: PERMISSION.RESPOSTAS_ENCERRAMENTO_VISUALIZAR,
  transferencia: PERMISSION.RESPOSTAS_TRANSFERENCIA_VISUALIZAR,
  aceite: PERMISSION.RESPOSTAS_ACEITE_VISUALIZAR,
  "motivo-pausa": PERMISSION.RESPOSTAS_MOTIVO_PAUSA_VISUALIZAR,
  templates: PERMISSION.RESPOSTAS_TEMPLATES_VISUALIZAR,
  pesquisa: PERMISSION.RESPOSTAS_PESQUISA_VISUALIZAR,
  expediente: PERMISSION.RESPOSTAS_EXPEDIENTE_VISUALIZAR,
  espera: PERMISSION.RESPOSTAS_ESPERA_VISUALIZAR,
  aniversarios: PERMISSION.RESPOSTAS_ANIVERSARIO_VISUALIZAR,
};

const TABS: { key: Tab; label: string; icon: typeof Slash }[] = [
  { key: "rapidas", label: "Respostas rápidas", icon: Slash },
  { key: "encerramento", label: "Encerramento", icon: LogOut },
  { key: "transferencia", label: "Transferência", icon: ArrowRightLeft },
  { key: "aceite", label: "Aceite", icon: UserCheck },
  { key: "motivo-pausa", label: "Motivo de Pausa", icon: PauseCircle },
  { key: "templates", label: "Templates", icon: FileText },
  { key: "pesquisa", label: "Pesquisa", icon: Star },
  { key: "expediente", label: "Horário de expediente", icon: Clock },
  { key: "espera", label: "Espera na fila", icon: Hourglass },
  { key: "aniversarios", label: "Aniversários", icon: Cake },
];

export default function RespostasPage() {
  const [tab, setTab] = useState<Tab>("rapidas");
  const permissions = useAuthStore((s) => s.permissions);
  const visibleTabs = TABS.filter((t) => {
    const permission = TAB_PERMISSION[t.key];
    return !permission || permissions?.[permission];
  });

  return (
    <div className="flex h-full flex-col overflow-hidden p-3 sm:p-6">
      <div className="mb-4 flex overflow-x-auto border-b border-border">
        {visibleTabs.map((t) => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            className={`flex flex-1 shrink-0 items-center justify-center gap-1.5 whitespace-nowrap px-4 py-3 text-sm font-medium sm:flex-none sm:px-6 ${
              tab === t.key ? "border-b-2 border-primary text-primary" : "text-muted"
            }`}
          >
            <t.icon className="h-4 w-4 shrink-0" /> {t.label}
          </button>
        ))}
      </div>

      <div className="flex-1 overflow-hidden">
        {tab === "rapidas" && <RespostasRapidasTab />}
        {tab === "encerramento" && <EncerramentoTab />}
        {tab === "transferencia" && (
          <AutoMessageTab
            trigger="TRANSFER"
            description="Mensagem enviada automaticamente pelo sistema ao cliente quando a conversa é transferida para outro atendente."
            emptyMessage="Nenhuma mensagem de transferência cadastrada ainda."
          />
        )}
        {tab === "aceite" && (
          <AutoMessageTab
            trigger="ACCEPT"
            description="Mensagem enviada automaticamente pelo sistema ao cliente quando um atendente aceita a conversa."
            emptyMessage="Nenhuma mensagem de aceite cadastrada ainda."
          />
        )}
        {tab === "motivo-pausa" && <MotivoPausaTab />}
        {tab === "templates" && <TemplatesTab />}
        {tab === "pesquisa" && <PesquisaTab />}
        {tab === "expediente" && <ExpedienteTab />}
        {tab === "espera" && <EsperaFilaTab />}
        {tab === "aniversarios" && <AniversariosTab />}
      </div>
    </div>
  );
}
