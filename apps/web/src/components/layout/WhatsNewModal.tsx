import { useLocation, useNavigate } from "react-router-dom";
import { Sparkles, X } from "lucide-react";
import { RELEASE_NOTE_TYPE_LABEL } from "@whatsatendende/types";
import { useReleaseNotes } from "../../hooks/useReleaseNotes";
import { useEscapeKey } from "../../hooks/useEscapeKey";
import { useAuthStore } from "../../store/auth-store";

// How many highlights the popup lists before pointing to the full page.
const HIGHLIGHT_COUNT = 5;

/**
 * One-time "O que há de novo" after an update: what changed in every release since this user's last visit (only notes
 * for areas they can access), newest first. Closing it, or opening the full notes, marks them as seen.
 *
 * An attendant gets a small notice in the corner instead of a window over the queue, so an update never stands between
 * them and a waiting customer. Gestor and administrador still get the full window. Both close with Esc.
 */
export function WhatsNewModal() {
  const { latest, unseen, hasUnseen, markSeen } = useReleaseNotes();
  const role = useAuthStore((s) => s.user?.role);
  const location = useLocation();
  const navigate = useNavigate();
  const visible = Boolean(latest && hasUnseen && location.pathname !== "/notas-de-versao");
  // Only the window takes Esc: the attendant's corner notice doesn't block anything, and Esc in Atendimento closes the chat.
  useEscapeKey(markSeen, visible && role !== "AGENT");

  if (!visible || !latest) return null;

  const several = unseen.length > 1;
  const notes = unseen.flatMap((release) => release.notes.map((note) => ({ note, version: release.version })));
  const openAll = () => navigate("/notas-de-versao");

  if (role === "AGENT") {
    const count = notes.length;
    return (
      <div
        role="status"
        aria-labelledby="whats-new-title"
        className="fixed bottom-4 right-4 z-50 w-[min(22rem,calc(100vw-2rem))] rounded-card border border-border bg-surface p-3.5 shadow-elevated max-md:bottom-[calc(4.5rem+env(safe-area-inset-bottom,0px))]"
      >
        <div className="flex items-start gap-3">
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-[10px] bg-primary/10 text-primary">
            <Sparkles className="h-[18px] w-[18px]" />
          </span>
          <div className="min-w-0 flex-1">
            <p id="whats-new-title" className="text-[13.5px] font-semibold">
              {several || count > 1 ? `${count} ${count === 1 ? "novidade" : "novidades"} desde a sua última visita` : `Novidade: ${latest.name}`}
            </p>
            <p className="mt-0.5 line-clamp-2 text-xs text-muted">{several ? notes.slice(0, 2).map(({ note }) => note.title).join(", ") + (count > 2 ? " e mais." : ".") : latest.summary}</p>
            <div className="mt-2.5 flex gap-2">
              <button type="button" onClick={openAll} className="focus-ring rounded-lg bg-primary px-3 py-1.5 text-xs font-semibold text-primary-fg hover:opacity-90">
                Ver novidades
              </button>
              <button type="button" onClick={markSeen} className="focus-ring rounded-lg border border-border px-3 py-1.5 text-xs font-medium hover:bg-surface-alt">
                Depois
              </button>
            </div>
          </div>
          <button type="button" onClick={markSeen} className="focus-ring rounded-lg p-1 text-muted hover:bg-surface-alt" aria-label="Fechar">
            <X className="h-4 w-4" />
          </button>
        </div>
      </div>
    );
  }

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
          <button type="button" onClick={openAll} className="focus-ring rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-primary-fg hover:opacity-90">
            Ver todas as novidades
          </button>
        </div>
      </div>
    </div>
  );
}
