import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { ArrowRight, CheckCircle2, Newspaper, ShieldCheck, X } from "lucide-react";
import { ANNOUNCEMENT_POPUP_LIMIT, type AnnouncementDTO } from "@whatsatendende/types";
import { api } from "../../lib/api";
import { announcementTz, useBoardName, usePendingAnnouncements } from "../../hooks/useAnnouncements";
import { KIND_STYLE, KindBadge, Overlay, StoryCard, reducedMotion, useStoryProgress } from "./announcement-ui";

const STORY_MS = 6000;
// Typing in a conversation in the last few seconds: a notice that arrives live waits (with a discreet toast) instead of
// covering the message being written — an urgent one opens at once.
const TYPING_GRACE_MS = 4000;

let lastTypingAt = 0;
if (typeof window !== "undefined") {
  window.addEventListener(
    "keydown",
    (e) => {
      const el = e.target as HTMLElement | null;
      if (el && (el.tagName === "TEXTAREA" || el.tagName === "INPUT" || el.isContentEditable)) lastTypingAt = Date.now();
    },
    true
  );
}

/**
 * The notices due after login, and live while logged in: up to ANNOUNCEMENT_POPUP_LIMIT as "stories" (advance by
 * themselves, pause on hover, click the sides to go back and forth), more than that grouped into one "Você tem N
 * novidades" that leads to Comunicados — the urgent ones and those that need a "ciente" always on top.
 */
export function AnnouncementsHost() {
  const { data: pending } = usePendingAnnouncements();
  const boardName = useBoardName();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [queue, setQueue] = useState<AnnouncementDTO[]>([]);
  const [deferred, setDeferred] = useState(false);
  const seen = useRef(new Set<string>());
  const queued = useRef<string[]>([]);
  queued.current = queue.map((a) => a.id);

  // New arrivals join the queue once — the server already counts the day's showings and leaves out what this login
  // session has seen. One that drops out of the server's list is forgotten here, so a "Lembrar pendentes" brings it back.
  useEffect(() => {
    if (!pending) return;
    const pendingIds = new Set(pending.map((a) => a.id));
    for (const id of [...seen.current]) if (!pendingIds.has(id) && !queued.current.includes(id)) seen.current.delete(id);
    const fresh = pending.filter((a) => !seen.current.has(a.id));
    if (fresh.length === 0) return;
    fresh.forEach((a) => seen.current.add(a.id));
    const urgent = fresh.some((a) => a.kind === "URGENT");
    const typing = Date.now() - lastTypingAt < TYPING_GRACE_MS;
    setQueue((q) => [...q, ...fresh]);
    if (typing && !urgent) {
      setDeferred(true);
      toast(`Novo aviso: ${fresh[0].title}`, {
        description: fresh.length > 1 ? `e mais ${fresh.length - 1}` : boardName,
        action: { label: "Ver", onClick: () => setDeferred(false) },
        duration: 8000,
      });
    }
  }, [pending, boardName]);

  // Waiting for the typing to stop.
  useEffect(() => {
    if (!deferred) return;
    const timer = setInterval(() => {
      if (Date.now() - lastTypingAt >= TYPING_GRACE_MS) setDeferred(false);
    }, 1000);
    return () => clearInterval(timer);
  }, [deferred]);

  const open = queue.length > 0 && !deferred;
  const ids = useMemo(() => queue.map((a) => a.id).join(","), [queue]);

  // Each opening counts as one of the day's (at most 2) showings, and as read.
  useEffect(() => {
    if (!open || !ids) return;
    api.post("/announcements/shown", { ids: ids.split(","), tz: announcementTz() }).catch(() => undefined);
  }, [open, ids]);

  if (!open) return null;

  const finish = () => {
    setQueue([]);
    queryClient.invalidateQueries({ queryKey: ["announcements", "board"] });
  };

  return queue.length <= ANNOUNCEMENT_POPUP_LIMIT ? (
    <Stories items={queue} boardName={boardName} onDone={finish} />
  ) : (
    <Summary
      items={queue}
      boardName={boardName}
      onClose={finish}
      onOpenBoard={() => {
        finish();
        navigate("/comunicados");
      }}
    />
  );
}

function Stories({ items, boardName, onDone }: { items: AnnouncementDTO[]; boardName: string; onDone: () => void }) {
  const [index, setIndex] = useState(0);
  const [hover, setHover] = useState(false);
  const [acked, setAcked] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const item = items[Math.min(index, items.length - 1)];
  const needsAck = item.requireAck && !acked.has(item.id) && !item.ackAt;
  // A notice that needs a "ciente" never runs out by itself; with reduced motion nothing advances on its own.
  const paused = hover || needsAck || reducedMotion();
  const next = () => (index < items.length - 1 ? setIndex(index + 1) : onDone());
  const progress = useStoryProgress(STORY_MS, paused, `${index}-${item.id}`, next);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "ArrowRight") next();
      if (e.key === "ArrowLeft") setIndex((i) => Math.max(0, i - 1));
      if (e.key === "Escape") onDone();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  async function primary() {
    if (needsAck) {
      setBusy(true);
      try {
        await api.post(`/announcements/${item.id}/ack`);
        setAcked((s) => new Set(s).add(item.id));
        toast.success("Leitura confirmada.");
      } catch {
        toast.error("Não foi possível confirmar agora. Tente de novo.");
        return;
      } finally {
        setBusy(false);
      }
    }
    next();
  }

  const label = needsAck ? "Li e estou ciente" : index < items.length - 1 ? "Entendi, próximo" : "Entendi";
  return (
    <Overlay>
      <div className="mx-auto h-[min(640px,88vh)] w-full max-w-[380px]" onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)} role="dialog" aria-modal="true" aria-label={item.title}>
        <StoryCard
          item={item}
          boardName={boardName}
          index={index}
          total={items.length}
          progress={needsAck ? 0 : progress}
          primaryLabel={label}
          onPrimary={primary}
          busy={busy}
          onClose={onDone}
          onPrev={index > 0 ? () => setIndex(index - 1) : undefined}
          onNext={!needsAck && index < items.length - 1 ? next : undefined}
        />
      </div>
    </Overlay>
  );
}

function Summary({ items, boardName, onClose, onOpenBoard }: { items: AnnouncementDTO[]; boardName: string; onClose: () => void; onOpenBoard: () => void }) {
  const [acked, setAcked] = useState<Set<string>>(new Set());
  const top = items.filter((a) => a.kind === "URGENT" || a.requireAck);
  const rest = items.filter((a) => !top.includes(a));

  async function ack(id: string) {
    try {
      await api.post(`/announcements/${id}/ack`);
      setAcked((s) => new Set(s).add(id));
    } catch {
      toast.error("Não foi possível confirmar agora. Tente de novo.");
    }
  }

  return (
    <Overlay onClose={onClose}>
      <div role="dialog" aria-modal="true" aria-labelledby="news-title" className="mx-auto w-full max-w-[460px] overflow-hidden rounded-[22px] border border-border bg-surface shadow-elevated">
        <div className="flex items-center gap-3 border-b border-border px-5 py-4">
          <span className="flex h-10 w-10 items-center justify-center rounded-full bg-primary/10 text-primary">
            <Newspaper className="h-5 w-5" />
          </span>
          <div className="min-w-0 flex-1">
            <h2 id="news-title" className="text-lg font-semibold">
              Você tem {items.length} novidades
            </h2>
            <p className="text-xs text-muted">{boardName}</p>
          </div>
          <button onClick={onClose} className="focus-ring rounded-lg p-1.5 text-muted hover:bg-surface-alt" aria-label="Fechar">
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="max-h-[60vh] overflow-y-auto">
          {top.map((a) => {
            const style = KIND_STYLE[a.kind];
            const done = acked.has(a.id) || Boolean(a.ackAt);
            return (
              <div key={a.id} className="border-b border-border px-5 py-3" style={{ background: style.tint, color: style.ink }}>
                <div className="flex items-start gap-2.5">
                  <style.icon className="mt-0.5 h-[18px] w-[18px] shrink-0" />
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-semibold">{a.title}</p>
                    {a.body && <p className="mt-0.5 line-clamp-2 text-xs opacity-90">{a.body.replace(/[*_~]/g, "")}</p>}
                    {a.requireAck &&
                      (done ? (
                        <p className="mt-2 flex items-center gap-1 text-xs font-semibold">
                          <CheckCircle2 className="h-3.5 w-3.5" /> Confirmado
                        </p>
                      ) : (
                        <button onClick={() => ack(a.id)} className="focus-ring mt-2 flex items-center gap-1 rounded-full bg-white/80 px-3 py-1 text-xs font-semibold hover:bg-white">
                          <ShieldCheck className="h-3.5 w-3.5" /> Li e estou ciente
                        </button>
                      ))}
                  </div>
                </div>
              </div>
            );
          })}
          <ul className="px-5 py-2">
            {rest.map((a) => {
              const style = KIND_STYLE[a.kind];
              return (
                <li key={a.id} className="flex items-center gap-3 border-b border-border py-2.5 last:border-0">
                  <style.icon className="h-[18px] w-[18px] shrink-0" style={{ color: style.solid }} />
                  <span className="min-w-0 flex-1 truncate text-sm">{a.title}</span>
                  <KindBadge kind={a.kind} />
                </li>
              );
            })}
          </ul>
        </div>
        <div className="flex justify-end gap-2 border-t border-border px-5 py-3">
          <button onClick={onClose} className="focus-ring rounded-card border border-border px-4 py-2 text-sm font-medium hover:bg-surface-alt">
            Ver depois
          </button>
          <button onClick={onOpenBoard} className="focus-ring flex items-center gap-1.5 rounded-card bg-primary px-4 py-2 text-sm font-semibold text-primary-fg">
            Abrir {boardName} <ArrowRight className="h-4 w-4" />
          </button>
        </div>
      </div>
    </Overlay>
  );
}
