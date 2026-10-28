import { useSearchParams } from "react-router-dom";
import clsx from "clsx";
import { BadgeCheck, Database, FileText, LayoutTemplate, MessageSquareText, type LucideIcon } from "lucide-react";
import { BoletoInstructionsPanel } from "./BoletoInstructionsPanel";
import { BoletoLayoutsPanel } from "./BoletoLayoutsPanel";
import { BoletoSendMessagePanel } from "./BoletoSendMessagePanel";
import { BoletoValidationSection } from "./BoletoValidationSection";
import { DataSourcesPanel } from "./DataSourcesPanel";

type Tab = "fontes" | "validacao" | "layouts" | "mensagens" | "envio";

// Grouped by subject in the left-hand section menu, like Configurações.
const TABS: { key: Tab; label: string; group: string; icon: LucideIcon }[] = [
  { key: "fontes", label: "Fontes de dados", group: "Dados", icon: Database },
  { key: "validacao", label: "Validação de boletos", group: "Dados", icon: BadgeCheck },
  { key: "layouts", label: "Layouts de boleto", group: "Boletos", icon: LayoutTemplate },
  { key: "mensagens", label: "Mensagens do boleto", group: "Boletos", icon: FileText },
  { key: "envio", label: "Mensagem de envio", group: "Boletos", icon: MessageSquareText },
];
const GROUPS = [...new Set(TABS.map((t) => t.group))];

/** Dados: where the client data comes from and how its boletos look and go out. */
export default function DadosPage() {
  // Kept in the URL (?secao=) so a reload or a shared link opens the same section.
  const [searchParams, setSearchParams] = useSearchParams();
  const tab = TABS.some((t) => t.key === searchParams.get("secao")) ? (searchParams.get("secao") as Tab) : "fontes";
  const setTab = (next: Tab) =>
    setSearchParams(
      (prev) => {
        const params = new URLSearchParams(prev);
        params.set("secao", next);
        return params;
      },
      { replace: true }
    );

  return (
    <div className="flex h-full flex-col overflow-hidden md:flex-row">
      <nav
        aria-label="Seções de dados"
        className="flex shrink-0 gap-1 overflow-x-auto border-b border-border bg-surface p-2 md:w-56 md:flex-col md:overflow-y-auto md:border-b-0 md:border-r md:p-3"
      >
        {GROUPS.map((group) => (
          <div key={group} className="flex shrink-0 gap-1 md:block md:space-y-0.5">
            <p className="hidden px-2.5 pb-1 pt-3 text-[10px] font-semibold uppercase tracking-[0.08em] text-muted first:pt-1 md:block">{group}</p>
            {TABS.filter((t) => t.group === group).map((t) => (
              <button
                key={t.key}
                onClick={() => setTab(t.key)}
                aria-current={tab === t.key ? "page" : undefined}
                className={clsx(
                  "focus-ring flex shrink-0 items-center gap-2.5 whitespace-nowrap rounded-lg px-2.5 py-2 text-[13px] md:w-full",
                  tab === t.key ? "bg-primary/10 font-semibold text-primary" : "text-[var(--color-text)] hover:bg-surface-alt"
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
        {tab === "fontes" && <DataSourcesPanel />}
        {tab === "validacao" && <BoletoValidationSection />}
        {tab === "layouts" && <BoletoLayoutsPanel />}
        {tab === "mensagens" && <BoletoInstructionsPanel />}
        {tab === "envio" && <BoletoSendMessagePanel />}
      </div>
    </div>
  );
}
