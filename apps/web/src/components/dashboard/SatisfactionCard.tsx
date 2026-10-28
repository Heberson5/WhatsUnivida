import type { SatisfactionOverviewDTO } from "@whatsatendende/types";
import { CHART_CARD_SHADOW } from "../../lib/chart-theme";
import { renderWhatsAppFormatting } from "../../lib/whatsappFormatting";
import { npsDelta, npsZone } from "../../lib/dashboardMetrics";

const formatAverage = (average: number) => average.toLocaleString("pt-BR", { minimumFractionDigits: 1, maximumFractionDigits: 1 });
const percent = (part: number, whole: number) => (whole ? Math.round((part / whole) * 100) : 0);
const ZONE_TEXT = { success: "text-success", primary: "text-primary", warning: "text-warning", danger: "text-danger" } as const;
const DELTA_TONE = { up: "text-success", down: "text-danger", same: "text-muted" } as const;

/** Promoters / passives / detractors as one stacked bar — the counts are spelled out under it, color is never the only cue. */
function NpsBreakdown({ promoters, passives, detractors, answered }: { promoters: number; passives: number; detractors: number; answered: number }) {
  const parts = [
    { label: "Promotores (9–10)", count: promoters, color: "bg-success" },
    { label: "Neutros (7–8)", count: passives, color: "bg-warning" },
    { label: "Detratores (0–6)", count: detractors, color: "bg-danger" },
  ];
  return (
    <div className="mt-3">
      <div className="flex h-2 overflow-hidden rounded-full bg-surface-alt" role="img" aria-label={parts.map((p) => `${p.label}: ${p.count}`).join(", ")}>
        {parts.map((p) => (
          <span key={p.label} className={`block h-full ${p.color}`} style={{ width: `${percent(p.count, answered)}%` }} />
        ))}
      </div>
      <ul className="mt-2 grid grid-cols-3 gap-2 text-xs">
        {parts.map((p) => (
          <li key={p.label}>
            <span className="flex items-center gap-1 text-muted">
              <span className={`h-2 w-2 shrink-0 rounded-full ${p.color}`} aria-hidden />
              <span className="truncate" title={p.label}>
                {p.label}
              </span>
            </span>
            <span className="font-semibold tabular-nums">{p.count}</span>
            <span className="text-muted tabular-nums"> · {percent(p.count, answered)}%</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * Pesquisa de satisfação no período: the same numbers as Relatórios › Pesquisa de satisfação (every 0–10 survey),
 * NPS from 0 to 100 with its zone, the change against the period before and the goal — and the question being
 * asked now, as the customer gets it on WhatsApp (*negrito*, _itálico_, emojis and line breaks).
 */
export function SatisfactionCard({ overview, isLoading }: { overview: SatisfactionOverviewDTO | undefined; isLoading: boolean }) {
  const totals = overview?.totals;
  const zone = totals?.nps == null ? null : npsZone(totals.nps);
  const delta = overview ? npsDelta(overview.totals.nps, overview.previous.nps) : null;
  const goal = overview?.settings.npsGoal ?? null;

  return (
    <div className={`flex h-full flex-col rounded-card border border-border bg-surface p-4 ${CHART_CARD_SHADOW}`}>
      <p className="mb-2 text-xs font-medium text-muted">Pesquisa de satisfação (NPS)</p>
      {isLoading ? (
        <p className="py-8 text-center text-sm text-muted">Carregando...</p>
      ) : !overview || !totals || totals.sent === 0 ? (
        <p className="py-8 text-center text-sm text-muted">Nenhuma pesquisa enviada no período. Ela pode ser ligada em Respostas › Pesquisa.</p>
      ) : (
        <>
          {overview.currentQuestion && (
            <div className="rounded-card bg-surface-alt px-3 py-2">
              <p className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-muted">Pergunta em uso</p>
              <p className="whitespace-pre-wrap break-words text-sm">{renderWhatsAppFormatting(overview.currentQuestion)}</p>
            </div>
          )}
          <div className="mt-3 flex items-end gap-3">
            <p
              className={`text-4xl font-semibold tabular-nums ${zone ? ZONE_TEXT[zone.tone] : ""}`}
              title="NPS de 0 a 100: 0 quando todos são detratores, 50 quando promotores e detratores empatam, 100 quando todos são promotores"
            >
              {totals.nps ?? "–"}
            </p>
            <div className="pb-1 text-xs text-muted">
              <p className="font-medium">NPS (0 a 100){zone ? ` · ${zone.label}` : ""}</p>
              <p className="flex flex-wrap gap-x-2">
                {delta && (
                  <span className={`font-semibold ${DELTA_TONE[delta.tone]}`} title={`Período anterior: ${overview.previous.nps}`}>
                    {delta.text} vs. período anterior
                  </span>
                )}
                {goal !== null && totals.nps !== null && (
                  <span className={totals.nps >= goal ? "text-success" : "text-danger"}>
                    {totals.nps >= goal ? "acima" : "abaixo"} da meta ({goal})
                  </span>
                )}
              </p>
              <p className="tabular-nums">
                {totals.answered} de {totals.sent} responderam ({totals.responseRate ?? 0}%)
                {totals.average !== null && ` · média ${formatAverage(totals.average)}`}
              </p>
              <p className="tabular-nums">
                <span className={totals.unanswered > 0 ? "font-semibold text-warning" : undefined}>{totals.unanswered} não responderam</span>
                {totals.awaiting > 0 && ` · ${totals.awaiting} ainda no prazo`}
              </p>
            </div>
          </div>
          {totals.answered > 0 && <NpsBreakdown promoters={totals.promoters} passives={totals.passives} detractors={totals.detractors} answered={totals.answered} />}
        </>
      )}
    </div>
  );
}
