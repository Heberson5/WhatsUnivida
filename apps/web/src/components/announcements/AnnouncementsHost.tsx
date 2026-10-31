import { useEffect, useMemo, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import type { AnnouncementDTO } from "@whatsatendende/types";
import { api } from "../../lib/api";
import { announcementTz, useBoardName, usePendingAnnouncements } from "../../hooks/useAnnouncements";
import { Overlay, StoryCard, reducedMotion, useStoryProgress } from "./announcement-ui";

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
 * The notices due after login, and live while logged in, as "stories" — the urgent ones first. Each one that needs a
 * "ciente" holds the pop-up open until it is confirmed, even if the notice ends meanwhile.
 */
export function AnnouncementsHost() {
  const { data: pending } = usePendingAnnouncements();
  const boardName = useBoardName();
  const queryClient = useQueryClient();
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

  // Each opening counts as one showing, and as read.
  useEffect(() => {
    if (!open || !ids) return;
    api.post("/announcements/shown", { ids: ids.split(","), tz: announcementTz() }).catch(() => undefined);
  }, [open, ids]);

  if (!open) return null;

  const finish = () => {
    setQueue([]);
    queryClient.invalidateQueries({ queryKey: ["announcements", "board"] });
  };

  return <Stories items={queue} boardName={boardName} onDone={finish} />;
}

function Stories({ items, boardName, onDone }: { items: AnnouncementDTO[]; boardName: string; onDone: () => void }) {
  const [index, setIndex] = useState(0);
  const [hover, setHover] = useState(false);
  const [acked, setAcked] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const item = items[Math.min(index, items.length - 1)];
  const owesAck = (a: AnnouncementDTO) => a.requireAck && !acked.has(a.id) && !a.ackAt;
  const needsAck = owesAck(item);
  const canClose = !items.some(owesAck);
  // A notice that needs a "ciente" never runs out by itself; with reduced motion nothing advances on its own.
  const paused = hover || needsAck || reducedMotion();
  const next = () => (index < items.length - 1 ? setIndex(index + 1) : onDone());
  const progress = useStoryProgress(STORY_MS, paused, `${index}-${item.id}`, next);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "ArrowRight" && !needsAck) next();
      if (e.key === "ArrowLeft") setIndex((i) => Math.max(0, i - 1));
      if (e.key === "Escape" && canClose) onDone();
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
          onClose={canClose ? onDone : undefined}
          onPrev={index > 0 ? () => setIndex(index - 1) : undefined}
          onNext={!needsAck && index < items.length - 1 ? next : undefined}
        />
      </div>
    </Overlay>
  );
}
