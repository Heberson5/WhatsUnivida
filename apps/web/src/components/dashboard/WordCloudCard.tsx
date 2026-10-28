import { CHART_CARD_SHADOW } from "../../lib/chart-theme";

interface WordCount {
  word: string;
  count: number;
}

const COLORS = ["var(--color-primary)", "var(--color-secondary)", "var(--color-muted)"];

/**
 * The most-used words customers wrote in the selected period — see PROMPT:
 * "nuvem das palavras ou frases que os clientes mais escreveram". A simple
 * flex-wrap tag cloud (font size scaled by frequency) rather than a
 * randomized-layout word cloud — no extra charting library needed, and the
 * ranking is just as readable this way.
 */
export function WordCloudCard({ words, isLoading }: { words: WordCount[] | undefined; isLoading: boolean }) {
  const max = words?.length ? Math.max(...words.map((w) => w.count)) : 0;
  const min = words?.length ? Math.min(...words.map((w) => w.count)) : 0;
  const range = max - min || 1;

  return (
    <div className={`rounded-card border border-border bg-surface p-4 ${CHART_CARD_SHADOW}`}>
      <p className="mb-2 text-xs font-medium text-muted">Palavras mais usadas pelos clientes</p>
      {isLoading ? (
        <p className="py-8 text-center text-sm text-muted">Carregando...</p>
      ) : !words?.length ? (
        <p className="py-8 text-center text-sm text-muted">Sem mensagens de clientes no período selecionado.</p>
      ) : (
        <div className="flex min-h-[180px] flex-wrap items-baseline justify-center gap-x-3 gap-y-2 px-2 py-4">
          {words.map((w, i) => {
            const t = (w.count - min) / range;
            const color = COLORS[i % COLORS.length];
            return (
              <span
                key={w.word}
                title={`${w.count} ${w.count === 1 ? "menção" : "menções"}`}
                className="inline-flex items-baseline gap-1"
                style={{
                  fontSize: `${14 + t * 28}px`,
                  fontWeight: t > 0.5 ? 700 : 500,
                  color,
                  opacity: 0.55 + t * 0.45,
                  lineHeight: 1,
                }}
              >
                {w.word}
                <span
                  className="rounded-full px-1.5 py-0.5 text-[0.55em] font-bold tabular-nums"
                  style={{ backgroundColor: color, color: "var(--color-surface)" }}
                >
                  {w.count}
                </span>
              </span>
            );
          })}
        </div>
      )}
    </div>
  );
}
