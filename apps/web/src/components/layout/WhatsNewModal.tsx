import { useLocation, useNavigate } from "react-router-dom";
import { Sparkles, X } from "lucide-react";
import { RELEASE_NOTE_TYPE_LABEL } from "@whatsatendende/types";
import { useReleaseNotes } from "../../hooks/useReleaseNotes";

// How many highlights the popup lists before pointing to the full page.
const HIGHLIGHT_COUNT = 5;

/**
 * One-time "O que há de novo" popup after an update: what changed in every
 * release since this user's last visit (only notes for areas they can access),
 * newest first. Closing it, or opening the full notes, marks them as seen.
 */
export function WhatsNewModal() {
  const { latest, unseen, hasUnseen, markSeen } = useReleaseNotes();
  const location = useLocation();
  const navigate = useNavigate();

  if (!latest || !hasUnseen || location.pathname === "/notas-de-versao") return null;

  const several = unseen.length > 1;
  const notes = unseen.flatMap((release) => release.notes.map((note) => ({ note, version: release.version })));
  const highlights = [...notes.filter(({ note }) => note.type === "novo"), ...notes.filter(({ note }) => note.type !== "novo")].slice(0, HIGHLIGHT_COUNT);
  const remaining = notes.length - highlights.length;
  const oldest = unseen[unseen.length - 1];

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-4" onClick={markSeen}>
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="whats-new-title"
        className="flex max-h-[85vh] w-full max-w-lg flex-col overflow-hidden rounded-card border border-border bg-surface shadow-elevated"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start gap-3 border-b border-border p-5">
          <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary">
            <Sparkles className="h-5 w-5" />
          </span>
          <div className="min-w-0 flex-1">
            <p className="font-mono text-xs text-muted">{several ? `Versões ${oldest.version} a ${latest.version}` : `Versão ${latest.version}`}</p>
            <h2 id="whats-new-title" className="text-lg font-semibold">
              {several ? "O que há de novo desde a sua última visita" : `O que há de novo: ${latest.name}`}
            </h2>
            <p className="mt-0.5 text-[13px] text-muted">
              {several ? `${unseen.length} versões, com ${notes.length} ${notes.length === 1 ? "novidade" : "novidades"} nas telas que você usa.` : latest.summary}
            </p>
          </div>
          <button type="button" onClick={markSeen} className="focus-ring rounded-lg p-1.5 text-muted hover:bg-surface-alt" aria-label="Fechar">
            <X className="h-4 w-4" />
          </button>
        </div>
        <ul className="flex-1 space-y-3 overflow-y-auto p-5">
          {highlights.map(({ note, version }) => (
            <li key={`${version}-${note.title}`} className="flex gap-2.5">
              <span className="mt-0.5 h-fit shrink-0 rounded-md bg-primary/10 px-1.5 py-px text-[10.5px] font-bold text-primary">{RELEASE_NOTE_TYPE_LABEL[note.type]}</span>
              <div className="min-w-0">
                <p className="text-sm font-semibold">
                  {note.title}
                  {several && <span className="ml-1.5 font-mono text-[11px] font-normal text-muted">{version}</span>}
                </p>
                <p className="line-clamp-2 text-[13px] text-muted">{note.text ?? note.after}</p>
              </div>
            </li>
          ))}
          {remaining > 0 && <li className="text-[13px] text-muted">E mais {remaining} {remaining === 1 ? "novidade" : "novidades"} nas telas que você usa.</li>}
        </ul>
        <div className="flex flex-col-reverse gap-2 border-t border-border p-4 sm:flex-row sm:justify-end">
          <button type="button" onClick={markSeen} className="focus-ring rounded-lg border border-border px-4 py-2 text-sm font-medium hover:bg-surface-alt">
            Fechar
          </button>
          <button
            type="button"
            onClick={() => navigate("/notas-de-versao")}
            className="focus-ring rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-primary-fg hover:opacity-90"
          >
            Ver todas as novidades
          </button>
        </div>
      </div>
    </div>
  );
}
