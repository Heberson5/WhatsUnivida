import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import clsx from "clsx";
import { toast } from "sonner";
import { NPS_SMALL_SAMPLE, type ConversationListItemDTO, type SatisfactionCategory, type SatisfactionOverviewDTO, type SatisfactionResponseDTO } from "@whatsatendende/types";
import { api, getApiErrorMessage } from "../../lib/api";
import { CHART_CARD_SHADOW } from "../../lib/chart-theme";
import { npsDelta, npsZone } from "../../lib/dashboardMetrics";
import { formatPhone } from "../../lib/format-phone";
import { ReadOnlyConversationDrawer } from "../gestao/ReadOnlyConversationDrawer";

const ZONE_BAR = { success: "bg-success", primary: "bg-primary", warning: "bg-warning", danger: "bg-danger" } as const;
const ZONE_TEXT = { success: "text-success", primary: "text-primary", warning: "text-warning", danger: "text-danger" } as const;
const DELTA_TONE = { up: "text-success", down: "text-danger", same: "text-muted" } as const;

const GROUPS: { key: SatisfactionCategory; title: string; range: string; dot: string; chip: string }[] = [
  { key: "detractor", title: "Detratores", range: "notas 0 a 6", dot: "bg-danger", chip: "bg-danger-soft text-danger" },
  { key: "passive", title: "Neutros", range: "notas 7 e 8", dot: "bg-warning", chip: "bg-warning-soft text-warning" },
  { key: "promoter", title: "Promotores", range: "notas 9 e 10", dot: "bg-success", chip: "bg-success-soft text-success" },
];

const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }) : "–");

/**
 * Dashboard, for Gestor and Administrador: each attendant's NPS (0 a 100, with the change against the period
 * before) and the latest 5 detractors, 5 passives and 5 promoters — each opens the conversation that was rated.
 */
export function SatisfactionDetailSection({ overview }: { overview: SatisfactionOverviewDTO }) {
  const [open, setOpen] = useState<ConversationListItemDTO | null>(null);
  const openMutation = useMutation({
    mutationFn: async (conversationId: string) => (await api.get<ConversationListItemDTO>(`/conversations/${conversationId}`)).data,
    onSuccess: setOpen,
    onError: (err) => toast.error(getApiErrorMessage(err)),
  });
  const agents = (overview.byAgent ?? []).filter((a) => a.answered > 0);
  const goal = overview.settings.npsGoal;
  if (!overview.byAgent || !overview.latest) return null;

  return (
    <section className="grid gap-4 lg:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]" aria-label="Satisfação por atendente e últimas avaliações">
      <div className={clsx("rounded-card border border-border bg-surface p-4", CHART_CARD_SHADOW)}>
        <div className="mb-3 flex items-baseline justify-between gap-2">
          <h3 className="text-sm font-semibold">NPS por atendente</h3>
          <span className="text-xs text-muted">0 a 100{goal !== null ? ` · meta ${goal}` : ""}</span>
        </div>
        {agents.length === 0 ? (
          <p className="py-6 text-center text-sm text-muted">Nenhuma resposta no período.</p>
        ) : (
          <ul className="space-y-3">
            {agents.map((a) => {
              const tone = a.nps === null ? null : npsZone(a.nps).tone;
              const delta = npsDelta(a.nps, a.previousNps);
              return (
                <li key={a.agentId ?? "none"}>
                  <div className="flex items-baseline justify-between gap-2 text-sm">
                    <span className="min-w-0 truncate font-medium">
                      {a.agentName}
                      {a.answered < NPS_SMALL_SAMPLE && (
                        <span className="ml-1.5 whitespace-nowrap rounded bg-surface-alt px-1 text-[10px] font-normal text-muted" title="Com poucas respostas, uma nota muda muito o NPS">
                          amostra pequena
                        </span>
                      )}
                    </span>
                    <span className="shrink-0 text-xs text-muted">
                      <span className={clsx("mr-1.5 text-base font-semibold tabular-nums", tone ? ZONE_TEXT[tone] : "")}>{a.nps ?? "–"}</span>
                      {delta && <span className={clsx("mr-1.5 font-semibold", DELTA_TONE[delta.tone])}>{delta.text}</span>}
                      {a.answered} {a.answered === 1 ? "resposta" : "respostas"}
                    </span>
                  </div>
                  <div className="relative mt-1 h-2 rounded-full bg-surface-alt" role="img" aria-label={`${a.agentName}: NPS ${a.nps ?? "sem respostas"}`}>
                    {a.nps !== null && tone && <span className={clsx("block h-full rounded-full", ZONE_BAR[tone])} style={{ width: `${Math.max(a.nps, 2)}%` }} />}
                    {goal !== null && <span className="absolute -top-0.5 h-3 w-0.5 bg-[var(--color-text)]/60" style={{ left: `${goal}%` }} title={`Meta ${goal}`} />}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      <div className={clsx("rounded-card border border-border bg-surface p-4", CHART_CARD_SHADOW)}>
        <div className="mb-3 flex items-baseline justify-between gap-2">
          <h3 className="text-sm font-semibold">Últimas avaliações</h3>
          <span className="text-xs text-muted">clique para ver a conversa avaliada</span>
        </div>
        <div className="grid gap-3 md:grid-cols-3">
          {GROUPS.map((g) => {
            const items = overview.latest![g.key];
            return (
              <div key={g.key} className="min-w-0">
                <p className="mb-1.5 flex items-center gap-1.5 text-xs font-semibold">
                  <span className={clsx("h-2 w-2 rounded-full", g.dot)} aria-hidden />
                  {g.title} <span className="font-normal text-muted">· {g.range}</span>
                </p>
                {items.length === 0 ? (
                  <p className="rounded-card bg-surface-alt px-2 py-3 text-center text-xs text-muted">Nenhuma no período</p>
                ) : (
                  <ul className="divide-y divide-border rounded-card border border-border">
                    {items.map((r) => (
                      <EvaluationRow
                        key={r.surveyId}
                        response={r}
                        chip={g.chip}
                        opening={openMutation.isPending && openMutation.variables === r.conversationId}
                        onOpen={() => openMutation.mutate(r.conversationId)}
                      />
                    ))}
                  </ul>
                )}
              </div>
            );
          })}
        </div>
      </div>

      {open && <ReadOnlyConversationDrawer key={open.id} conversation={open} onClose={() => setOpen(null)} />}
    </section>
  );
}

function EvaluationRow({ response: r, chip, opening, onOpen }: { response: SatisfactionResponseDTO; chip: string; opening: boolean; onOpen: () => void }) {
  const customer = r.contactName ?? (r.contactPhone ? formatPhone(r.contactPhone) : "Cliente");
  return (
    <li>
      <button
        onClick={onOpen}
        disabled={opening}
        aria-label={`Ver a conversa avaliada de ${customer}, nota ${r.score}`}
        className="focus-ring flex w-full items-center gap-2 px-2 py-1.5 text-left hover:bg-surface-alt disabled:opacity-60"
      >
        <span className={clsx("flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-xs font-bold tabular-nums", chip)}>{r.score}</span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-xs font-medium">{customer}</span>
          <span className="block truncate text-[11px] text-muted">
            {r.agentName ?? "–"} · {when(r.answeredAt)}
          </span>
        </span>
      </button>
    </li>
  );
}
