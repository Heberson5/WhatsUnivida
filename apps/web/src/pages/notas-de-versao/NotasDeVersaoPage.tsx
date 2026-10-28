import { useEffect } from "react";
import { useSearchParams } from "react-router-dom";
import clsx from "clsx";
import { useReleaseNotes } from "../../hooks/useReleaseNotes";
import { ReleaseView } from "../../components/release-notes/ReleaseView";

/**
 * Notas de versão: what changed in each release, limited to the areas this
 * user can open (the server filters them — see release-notes.service.ts).
 * Opening it marks the newest release as seen, clearing the sidebar's "Novo" badge.
 */
export default function NotasDeVersaoPage() {
  const { releases, markSeen, isLoading } = useReleaseNotes();
  const [searchParams, setSearchParams] = useSearchParams();

  useEffect(() => {
    markSeen();
  }, [markSeen]);

  const release = releases.find((r) => r.version === searchParams.get("versao")) ?? releases[0];
  if (!release) {
    return <p className="p-6 text-sm text-muted">{isLoading ? "Carregando as notas de versão..." : "Nenhuma nota de versão por aqui ainda."}</p>;
  }

  function selectVersion(version: string) {
    setSearchParams({ versao: version }, { replace: true });
  }

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto grid max-w-6xl gap-6 p-4 sm:p-6 lg:grid-cols-[210px_minmax(0,1fr)]">
        <nav aria-label="Versões" className="flex gap-1 overflow-x-auto pb-1 lg:sticky lg:top-0 lg:flex-col lg:self-start lg:overflow-visible lg:pb-0">
          <p className="hidden px-1 pb-1 text-[10px] font-semibold uppercase tracking-[0.08em] text-muted lg:block">Versões</p>
          {releases.map((r, i) => (
            <button
              key={r.version}
              type="button"
              onClick={() => selectVersion(r.version)}
              aria-current={r.version === release.version ? "true" : undefined}
              className={clsx(
                "focus-ring grid shrink-0 grid-cols-[1fr_auto] gap-x-2 rounded-lg border px-2.5 py-2 text-left",
                r.version === release.version ? "border-border bg-surface-alt" : "border-transparent hover:bg-surface-alt"
              )}
            >
              <span className="font-mono text-[12.5px] font-semibold">
                {r.version}
                {i === 0 && <span className="ms-1.5 rounded-full bg-primary/10 px-1.5 py-px align-[1px] font-sans text-[9.5px] font-bold uppercase text-primary">Atual</span>}
              </span>
              <span className="col-start-2 row-span-2 row-start-1 self-center text-[11px] font-semibold tabular-nums text-muted">{r.notes.length}</span>
              <span className="col-start-1 text-[11.5px] text-muted">
                {r.date} · {r.name}
              </span>
            </button>
          ))}
        </nav>

        <ReleaseView release={release} />
      </div>
    </div>
  );
}
