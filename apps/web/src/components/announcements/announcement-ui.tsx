import { useEffect, useRef, useState, type ReactNode } from "react";
import clsx from "clsx";
import { AlertTriangle, ExternalLink, FileText, Info, Megaphone, PartyPopper, Sparkles, Speaker, X, type LucideIcon } from "lucide-react";
import { ANNOUNCEMENT_KIND_LABEL, type AnnouncementDTO, type AnnouncementKind } from "@whatsatendende/types";
import { renderWhatsAppFormatting } from "../../lib/whatsappFormatting";

/** Each kind's color (the story's background) and the lighter tint of the board's cards. */
export const KIND_STYLE: Record<AnnouncementKind, { solid: string; tint: string; ink: string; icon: LucideIcon }> = {
  INFO: { solid: "#185FA5", tint: "#E6F1FB", ink: "#0C447C", icon: Info },
  IMPORTANT: { solid: "#0F6E56", tint: "#E1F5EE", ink: "#085041", icon: Megaphone },
  URGENT: { solid: "#A32D2D", tint: "#FCEBEB", ink: "#791F1F", icon: AlertTriangle },
  CELEBRATION: { solid: "#993C1D", tint: "#FAECE7", ink: "#712B13", icon: PartyPopper },
  NEWS: { solid: "#3C3489", tint: "#EEEDFE", ink: "#26215C", icon: Sparkles },
};

export function KindBadge({ kind, className }: { kind: AnnouncementKind; className?: string }) {
  const style = KIND_STYLE[kind];
  return (
    <span className={clsx("inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-[11px] font-semibold", className)} style={{ background: style.tint, color: style.ink }}>
      <style.icon className="h-3 w-3" /> {ANNOUNCEMENT_KIND_LABEL[kind]}
    </span>
  );
}

/** The notice's text with WhatsApp-style formatting (*negrito*, _itálico_, ~riscado~), one paragraph per blank line. */
export function AnnouncementBody({ text, className }: { text: string; className?: string }) {
  const paragraphs = text.split(/\n\s*\n/).filter((p) => p.trim());
  return (
    <div className={clsx("space-y-2 whitespace-pre-line", className)}>
      {paragraphs.map((p, i) => (
        <p key={i}>{renderWhatsAppFormatting(p.trim())}</p>
      ))}
    </div>
  );
}

const CONFETTI = ["#ffe450", "#ff8fab", "#7dd3fc", "#a7f3d0", "#c4b5fd", "#fdba74"];

export function reducedMotion(): boolean {
  return typeof window !== "undefined" && Boolean(window.matchMedia?.("(prefers-reduced-motion: reduce)").matches);
}

/**
 * One notice as a "story": the kind's color, the cover image (COVER), the image as a poster (POSTER) or an icon (TEXT),
 * the title and text, and the buttons. Used by the pop-up and as the live preview while writing a notice.
 */
export function StoryCard({
  item,
  boardName,
  index,
  total,
  progress,
  primaryLabel,
  onPrimary,
  onClose,
  onPrev,
  onNext,
  busy,
}: {
  item: Pick<AnnouncementDTO, "kind" | "layout" | "title" | "body" | "images" | "attachments" | "linkUrl" | "linkLabel" | "requireAck">;
  boardName: string;
  index: number;
  total: number;
  /** Fill of each bar: done = 1, the current one 0..1, the rest 0. */
  progress: number;
  primaryLabel: string;
  onPrimary?: () => void;
  onClose?: () => void;
  onPrev?: () => void;
  onNext?: () => void;
  busy?: boolean;
}) {
  const style = KIND_STYLE[item.kind];
  const cover = item.images[0];
  const poster = item.layout === "POSTER" && cover;
  const pdf = item.attachments[0];

  return (
    <div className="relative flex h-full min-h-[460px] w-full flex-col overflow-hidden rounded-[22px] text-white" style={{ background: style.solid, transition: "background 0.5s" }}>
      {poster && (
        <>
          <img src={cover.url} alt="" className="absolute inset-0 h-full w-full object-cover" />
          <div className="absolute inset-0" style={{ background: "linear-gradient(180deg, rgba(0,0,0,0.45) 0%, rgba(0,0,0,0.05) 35%, rgba(0,0,0,0.75) 100%)" }} />
        </>
      )}
      {item.kind === "CELEBRATION" && (
        <div className="bday-confetti pointer-events-none absolute inset-0 z-[1]" aria-hidden>
          {CONFETTI.concat(CONFETTI).map((color, i) => (
            <i key={i} style={{ left: `${6 + i * 8}%`, background: color, animationDelay: `${(i % 6) * 0.35}s` }} />
          ))}
        </div>
      )}

      <div className="relative z-[2] flex flex-1 flex-col px-5 pb-5 pt-3.5">
        <div className="mb-3 flex gap-1" aria-hidden>
          {Array.from({ length: total }).map((_, i) => (
            <div key={i} className="h-[3px] flex-1 overflow-hidden rounded bg-white/35">
              <div className="h-full bg-white" style={{ width: `${(i < index ? 1 : i === index ? progress : 0) * 100}%` }} />
            </div>
          ))}
        </div>
        <div className="flex items-center gap-2">
          <span className="flex h-8 w-8 items-center justify-center rounded-full bg-white/20">
            <Speaker className="h-4 w-4" />
          </span>
          <div className="text-xs leading-tight">
            <p className="font-semibold">{boardName}</p>
            <p className="opacity-80">
              {ANNOUNCEMENT_KIND_LABEL[item.kind]}
              {total > 1 ? ` · ${index + 1} de ${total}` : ""}
            </p>
          </div>
          {onClose && (
            <button onClick={onClose} className="focus-ring ml-auto rounded-full p-1.5 hover:bg-white/15" aria-label="Fechar">
              <X className="h-5 w-5" />
            </button>
          )}
        </div>

        {!poster && cover && item.layout === "COVER" && (
          <div className="mt-4 overflow-hidden rounded-2xl bg-white/10">
            <img src={cover.url} alt="" className="aspect-[16/10] w-full object-cover" />
          </div>
        )}

        {/* With a cover the text follows the image; otherwise it sits low, like a story. */}
        <div key={`${index}-${item.title}`} className={clsx("story-fade flex flex-1 flex-col", item.layout === "COVER" && cover ? "pt-4" : "justify-end pt-5")}>
          {(item.layout === "TEXT" || !cover) && (
            <span className="mb-4 flex h-[52px] w-[52px] items-center justify-center rounded-2xl bg-white/20">
              <style.icon className="h-6 w-6" />
            </span>
          )}
          <h2 className="text-[22px] font-semibold leading-tight tracking-[-0.3px]">{item.title || "Título do aviso"}</h2>
          {item.body && <AnnouncementBody text={item.body} className="mt-2 max-h-[30vh] overflow-y-auto text-[14px] leading-relaxed opacity-90" />}
          <div className={clsx("space-y-2", item.layout === "COVER" && cover ? "mt-auto pt-5" : "mt-5")}>
            {onPrimary !== undefined && (
              <button
                onClick={onPrimary}
                disabled={busy}
                className="focus-ring w-full rounded-full bg-white px-4 py-2.5 text-sm font-semibold disabled:opacity-70"
                style={{ color: style.solid }}
              >
                {primaryLabel}
              </button>
            )}
            {(item.linkUrl || pdf) && (
              <div className="flex flex-wrap justify-center gap-2">
                {item.linkUrl && (
                  <a href={item.linkUrl} target="_blank" rel="noreferrer" className="focus-ring inline-flex items-center gap-1.5 rounded-full border border-white/50 px-3 py-1.5 text-xs font-semibold hover:bg-white/10">
                    <ExternalLink className="h-3.5 w-3.5" /> {item.linkLabel || "Abrir link"}
                  </a>
                )}
                {pdf && (
                  <a href={pdf.url} target="_blank" rel="noreferrer" className="focus-ring inline-flex items-center gap-1.5 rounded-full border border-white/50 px-3 py-1.5 text-xs font-semibold hover:bg-white/10">
                    <FileText className="h-3.5 w-3.5" /> {pdf.fileName}
                  </a>
                )}
              </div>
            )}
          </div>
        </div>
      </div>

      {(onPrev || onNext) && (
        <>
          {onPrev && <button onClick={onPrev} className="absolute bottom-40 left-0 top-20 z-[3] w-1/4 cursor-w-resize" aria-label="Aviso anterior" />}
          {onNext && <button onClick={onNext} className="absolute bottom-40 right-0 top-20 z-[3] w-1/4 cursor-e-resize" aria-label="Próximo aviso" />}
        </>
      )}
    </div>
  );
}

/** Advances 0 → 1 over `durationMs`, paused while `paused`; restarts whenever `resetKey` changes. */
export function useStoryProgress(durationMs: number, paused: boolean, resetKey: unknown, onDone: () => void): number {
  const [progress, setProgress] = useState(0);
  const elapsed = useRef(0);
  const done = useRef(onDone);
  done.current = onDone;
  useEffect(() => {
    elapsed.current = 0;
    setProgress(0);
  }, [resetKey]);
  useEffect(() => {
    if (paused) return;
    let last = performance.now();
    let frame = 0;
    const tick = (now: number) => {
      elapsed.current += now - last;
      last = now;
      const p = Math.min(1, elapsed.current / durationMs);
      setProgress(p);
      if (p >= 1) {
        done.current();
        return;
      }
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [paused, durationMs, resetKey]);
  return progress;
}

export function Overlay({ children, onClose }: { children: ReactNode; onClose?: () => void }) {
  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/55 p-4 backdrop-blur-sm" onClick={onClose}>
      <div className="story-in w-full" onClick={(e) => e.stopPropagation()}>
        {children}
      </div>
    </div>
  );
}
