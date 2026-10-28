import { useState } from "react";
import { ListChecks, X } from "lucide-react";
import type { MessageAttachmentDTO } from "@whatsatendende/types";

/**
 * A group poll as WhatsApp Web shows it: each option with its bar, share and number of votes, and "Ver votos" with who
 * picked what. Read-only — voting stays on the phone. A poll from before the platform kept its key shows no votes.
 */
export function PollCard({ att }: { att: MessageAttachmentDTO }) {
  const [showVotes, setShowVotes] = useState(false);
  const results = att.pollResults;
  const options = results?.options ?? (att.pollOptions ?? []).map((option) => ({ option, count: 0, voters: [] }));
  const voters = results?.voters ?? 0;
  const max = Math.max(1, ...options.map((o) => o.count));

  return (
    <div className="min-w-[240px] rounded border border-black/10 bg-black/5 px-3 py-2.5">
      <div className="mb-1 flex items-center gap-1.5 text-xs font-medium opacity-75">
        <ListChecks className="h-3.5 w-3.5" /> Enquete
      </div>
      <p className="text-sm font-medium">{att.pollQuestion}</p>
      <p className="mb-2 text-[11px] opacity-70">{att.pollMultiple ? "Selecione uma ou mais opções" : "Selecione uma opção"}</p>
      <div className="space-y-2">
        {options.map((o) => {
          const share = voters ? Math.round((o.count / voters) * 100) : 0;
          return (
            <div key={o.option} className="text-xs">
              <div className="flex items-center justify-between gap-2">
                <span className="flex min-w-0 items-center gap-1.5">
                  <span className={`h-3 w-3 shrink-0 border border-current opacity-50 ${att.pollMultiple ? "rounded-sm" : "rounded-full"}`} />
                  <span className="truncate">{o.option}</span>
                </span>
                <span className="shrink-0 tabular-nums opacity-80">{results?.readable ? o.count : ""}</span>
              </div>
              {results?.readable && (
                <div className="mt-1 h-1.5 rounded-full bg-black/10" title={`${share}%`}>
                  <div className={`h-1.5 rounded-full ${o.count === max && o.count > 0 ? "bg-primary" : "bg-primary/60"}`} style={{ width: `${share}%` }} />
                </div>
              )}
            </div>
          );
        })}
      </div>
      <div className="mt-2 border-t border-black/10 pt-1.5 text-center text-xs">
        {!results?.readable ? (
          <span className="opacity-70">Votos não disponíveis: a chave desta enquete não chegou ao sistema (enquete antiga).</span>
        ) : voters === 0 ? (
          <span className="opacity-70">Nenhum voto ainda</span>
        ) : (
          <button type="button" onClick={() => setShowVotes(true)} className="focus-ring rounded px-2 py-0.5 font-medium text-primary hover:underline">
            Ver votos ({voters})
          </button>
        )}
      </div>

      {showVotes && results && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-4" role="dialog" aria-modal="true" aria-label="Votos da enquete" onClick={() => setShowVotes(false)}>
          <div className="max-h-[80vh] w-full max-w-sm overflow-y-auto rounded-card border border-border bg-surface p-4 text-[var(--color-text)] shadow-elevated" onClick={(e) => e.stopPropagation()}>
            <div className="mb-2 flex items-start justify-between gap-2">
              <div>
                <p className="text-sm font-semibold">Votos da enquete</p>
                <p className="text-xs text-muted">{att.pollQuestion}</p>
              </div>
              <button type="button" onClick={() => setShowVotes(false)} className="focus-ring rounded-full p-1 text-muted hover:bg-surface-alt" aria-label="Fechar">
                <X className="h-4 w-4" />
              </button>
            </div>
            {results.options.map((o) => (
              <div key={o.option} className="border-t border-border py-2">
                <p className="flex justify-between text-sm font-medium">
                  <span>{o.option}</span>
                  <span className="text-muted">
                    {o.count} {o.count === 1 ? "voto" : "votos"}
                  </span>
                </p>
                {o.voters.length > 0 ? (
                  <ul className="mt-1 space-y-0.5 text-xs text-muted">
                    {o.voters.map((v, i) => (
                      <li key={`${v.name}-${i}`}>{v.name}</li>
                    ))}
                  </ul>
                ) : (
                  <p className="mt-1 text-xs text-muted">Ninguém</p>
                )}
              </div>
            ))}
            <p className="mt-2 text-[11px] text-muted">Só leitura: para votar, use o WhatsApp no celular.</p>
          </div>
        </div>
      )}
    </div>
  );
}
