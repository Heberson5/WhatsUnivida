import { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import clsx from "clsx";
import { toast } from "sonner";
import { ArrowRight, CheckCircle2, ExternalLink, FileText, Pin, Search, ShieldCheck, X, Zap } from "lucide-react";
import { ANNOUNCEMENT_KIND_LABEL, type AnnouncementDTO } from "@whatsatendende/types";
import { api } from "../../lib/api";
import { useAnnouncementBoard, type BoardResponse } from "../../hooks/useAnnouncements";
import { AnnouncementBody, KIND_STYLE, KindBadge, reducedMotion, announcementUntil } from "../../components/announcements/announcement-ui";

const HERO_MS = 5000;

/** The day the notice started showing (YYYY-MM-DD), as "hoje", "ontem" or "12 out". */
function shortDate(day: string): string {
  const d = new Date(`${day}T12:00`);
  const today = new Date();
  const yesterday = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1);
  if (d.toDateString() === today.toDateString()) return "hoje";
  if (d.toDateString() === yesterday.toDateString()) return "ontem";
  return d.toLocaleDateString("pt-BR", { day: "2-digit", month: "short" });
}

const plain = (text: string) => text.replace(/[*_~]/g, "");

/**
 * Comunicados: every notice meant for the person — the urgent ones running in a strip at the top, the highlights in a
 * carousel, their own reading on the side, the rest in cards that filter by category, and the ones that ended below.
 */
export default function ComunicadosPage() {
  const { data } = useAnnouncementBoard();
  const [params, setParams] = useSearchParams();
  const [category, setCategory] = useState<string>("all");
  const [query, setQuery] = useState("");
  const openId = params.get("aviso");
  const items = data?.items ?? [];
  const open = items.find((a) => a.id === openId) ?? null;
  const setOpen = (id: string | null) =>
    setParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        if (id) next.set("aviso", id);
        else next.delete("aviso");
        return next;
      },
      { replace: true }
    );

  const current = items.filter((a) => a.showsToday);
  const previous = items.filter((a) => !a.showsToday);
  const urgent = current.filter((a) => a.kind === "URGENT");
  const categories = [...new Set(items.map((a) => a.category).filter((c): c is string => Boolean(c)))].sort((a, b) => a.localeCompare(b, "pt-BR"));

  const matches = (a: AnnouncementDTO) =>
    (category === "all" || (category === "unread" ? !a.readAt : a.category === category)) &&
    (!query.trim() || `${a.title} ${a.body} ${a.category ?? ""}`.toLowerCase().includes(query.trim().toLowerCase()));

  const heroes = useMemo(() => {
    const picked = current.filter((a) => a.pinned || a.kind === "IMPORTANT" || a.kind === "NEWS" || a.kind === "CELEBRATION");
    return (picked.length ? picked : current).slice(0, 4);
  }, [current]);
  const heroIds = new Set(heroes.map((h) => h.id));
  const cards = current.filter((a) => !heroIds.has(a.id) && matches(a));
  const awaitingAck = current.filter((a) => a.requireAck && !a.ackAt);
  const readShare = current.length ? Math.round((current.filter((a) => a.readAt).length / current.length) * 100) : 100;

  const name = data?.settings.name ?? "Comunicados";
  const todayText = new Date().toLocaleDateString("pt-BR", { weekday: "long", day: "numeric", month: "long" });
  const today = todayText.charAt(0).toUpperCase() + todayText.slice(1);

  return (
    <div className="h-full overflow-y-auto p-3 sm:p-6">
      {urgent.length > 0 && (
        <div className="mb-4 flex items-center gap-3 overflow-hidden rounded-full bg-danger-soft py-1.5 pl-3 pr-1.5">
          <span className="flex shrink-0 items-center gap-1 text-[11px] font-bold uppercase tracking-wide text-danger">
            <Zap className="h-3.5 w-3.5" /> Urgente
          </span>
          <div className="min-w-0 flex-1 overflow-hidden">
            <div className="ticker-track flex w-max gap-12 whitespace-nowrap text-[13px] text-danger">
              {[...urgent, ...urgent].map((a, i) => (
                <button key={`${a.id}-${i}`} onClick={() => setOpen(a.id)} className="hover:underline">
                  {a.title}
                </button>
              ))}
            </div>
          </div>
        </div>
      )}

      <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-[28px] font-semibold leading-none tracking-[-0.5px]">{name}</h1>
          <p className="mt-1.5 text-xs text-muted">
            <span>{today}</span>
            {data && data.unread > 0 && <span className="text-primary"> · {data.unread === 1 ? "1 novo para você" : `${data.unread} novos para você`}</span>}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          {[{ key: "all", label: "Todos" }, { key: "unread", label: "Não lidos" }, ...categories.map((c) => ({ key: c, label: c }))].map((c) => (
            <button
              key={c.key}
              onClick={() => setCategory(c.key)}
              className={clsx(
                "focus-ring rounded-full border px-3 py-1 text-xs font-medium transition-colors",
                category === c.key ? "border-transparent bg-[var(--color-text)] text-[var(--color-surface)]" : "border-border hover:bg-surface-alt"
              )}
            >
              {c.label}
            </button>
          ))}
          <label className="flex items-center gap-1.5 rounded-full border border-border px-3 py-1">
            <Search className="h-3.5 w-3.5 text-muted" />
            <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Buscar" className="w-28 bg-transparent text-xs outline-none" />
          </label>
        </div>
      </div>

      {items.length === 0 && data && (
        <div className="rounded-card border border-dashed border-border p-10 text-center">
          <p className="font-semibold">Nenhum comunicado por aqui</p>
          <p className="mt-1 text-sm text-muted">Quando a equipe publicar um aviso para você, ele aparece aqui e depois do login.</p>
        </div>
      )}

      {current.length > 0 && (
        <div className="mb-3 grid gap-3 lg:grid-cols-[minmax(0,1.7fr)_minmax(0,1fr)]">
          <HeroCarousel items={heroes} onOpen={setOpen} />
          <div className="flex flex-col gap-3">
            <div className="rounded-[14px] border border-border bg-surface p-4">
              <p className="mb-2.5 text-xs text-muted">Sua leitura</p>
              <div className="flex items-center gap-4">
                <ReadRing percent={readShare} />
                <div>
                  <p className="text-[22px] font-semibold">{readShare}%</p>
                  <p className="text-xs text-muted">
                    {current.filter((a) => a.readAt).length} de {current.length} lidos
                  </p>
                </div>
              </div>
            </div>
            <div className="flex-1 rounded-[14px] border border-border bg-surface p-4">
              <p className="mb-2 text-xs text-muted">Aguardando seu "ciente"</p>
              {awaitingAck.length === 0 ? (
                <p className="flex items-center gap-1.5 text-[13px] text-success">
                  <CheckCircle2 className="h-4 w-4" /> Nada pendente
                </p>
              ) : (
                awaitingAck.map((a) => (
                  <button key={a.id} onClick={() => setOpen(a.id)} className="flex w-full items-start gap-2 border-b border-border py-1.5 text-left last:border-0 hover:text-primary">
                    <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-warning" />
                    <span className="text-[13px]">{a.title}</span>
                  </button>
                ))
              )}
            </div>
          </div>
        </div>
      )}

      {cards.length > 0 && (
        <div className="grid gap-3 [grid-template-columns:repeat(auto-fill,minmax(200px,1fr))]">
          {cards.map((a, i) => (
            <Tile key={a.id} item={a} delay={i * 70} onOpen={() => setOpen(a.id)} />
          ))}
        </div>
      )}

      {previous.filter(matches).length > 0 && (
        <section className="mt-8">
          <h2 className="mb-3 text-sm font-semibold text-muted">Anteriores</h2>
          <div className="grid gap-3 opacity-90 [grid-template-columns:repeat(auto-fill,minmax(200px,1fr))]">
            {previous.filter(matches).map((a, i) => (
              <Tile key={a.id} item={a} delay={i * 50} onOpen={() => setOpen(a.id)} />
            ))}
          </div>
        </section>
      )}

      {open && <DetailModal item={open} onClose={() => setOpen(null)} />}
    </div>
  );
}

function ReadRing({ percent }: { percent: number }) {
  const [shown, setShown] = useState(0);
  useEffect(() => {
    const timer = setTimeout(() => setShown(percent), 150);
    return () => clearTimeout(timer);
  }, [percent]);
  const c = 2 * Math.PI * 26;
  return (
    <svg width="64" height="64" viewBox="0 0 64 64" aria-hidden>
      <circle cx="32" cy="32" r="26" fill="none" stroke="var(--color-border)" strokeWidth="6" />
      <circle
        cx="32"
        cy="32"
        r="26"
        fill="none"
        stroke="var(--color-success)"
        strokeWidth="6"
        strokeLinecap="round"
        strokeDasharray={c}
        strokeDashoffset={c * (1 - shown / 100)}
        transform="rotate(-90 32 32)"
        style={{ transition: "stroke-dashoffset 1.2s ease" }}
      />
    </svg>
  );
}

function HeroCarousel({ items, onOpen }: { items: AnnouncementDTO[]; onOpen: (id: string) => void }) {
  const [index, setIndex] = useState(0);
  const [hover, setHover] = useState(false);
  useEffect(() => {
    if (items.length < 2 || hover || reducedMotion()) return;
    const timer = setInterval(() => setIndex((i) => (i + 1) % items.length), HERO_MS);
    return () => clearInterval(timer);
  }, [items.length, hover]);
  const item = items[index % Math.max(1, items.length)];
  if (!item) return null;
  const style = KIND_STYLE[item.kind];
  const cover = item.images[0];
  return (
    <div
      className="relative flex min-h-[260px] cursor-pointer flex-col justify-end overflow-hidden rounded-2xl p-5 text-white"
      style={{ background: style.solid, transition: "background 0.6s" }}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      onClick={() => onOpen(item.id)}
    >
      {cover && (
        <>
          <img key={cover.url} src={cover.url} alt="" className="story-fade absolute inset-0 h-full w-full object-cover" />
          <div className="absolute inset-0" style={{ background: "linear-gradient(180deg, rgba(0,0,0,0.25) 0%, rgba(0,0,0,0.15) 40%, rgba(0,0,0,0.78) 100%)" }} />
        </>
      )}
      <div className="absolute left-5 right-5 top-4 flex items-center justify-between">
        <span className="flex items-center gap-1 rounded-full bg-white/20 px-2.5 py-0.5 text-[11px]">
          {item.pinned && <Pin className="h-3 w-3" />} {ANNOUNCEMENT_KIND_LABEL[item.kind]}
          {item.category ? ` · ${item.category}` : ""}
        </span>
        {items.length > 1 && (
          <span className="flex items-center gap-1.5">
            {items.map((h, i) => (
              <button
                key={h.id}
                onClick={(e) => {
                  e.stopPropagation();
                  setIndex(i);
                }}
                className="h-1.5 rounded-full bg-white transition-all"
                style={{ width: i === index ? 18 : 6, opacity: i === index ? 1 : 0.4 }}
                aria-label={`Destaque ${i + 1}`}
              />
            ))}
          </span>
        )}
      </div>
      <div key={item.id} className="story-fade relative">
        <h2 className="max-w-[460px] text-[23px] font-semibold leading-tight tracking-[-0.4px]">{item.title}</h2>
        {item.body && <p className="mt-2 line-clamp-2 max-w-[460px] text-[13px] opacity-85">{plain(item.body)}</p>}
        <span className="mt-3.5 inline-flex items-center gap-1.5 border-b border-white/60 pb-0.5 text-[13px]">
          Ler comunicado <ArrowRight className="h-3.5 w-3.5" />
        </span>
      </div>
    </div>
  );
}

function Tile({ item, delay, onOpen }: { item: AnnouncementDTO; delay: number; onOpen: () => void }) {
  const style = KIND_STYLE[item.kind];
  const cover = item.images[0];
  const likes = item.reactions.reduce((sum, r) => sum + r.count, 0);
  return (
    <button onClick={onOpen} className="board-tile story-fade overflow-hidden rounded-[14px] border border-border bg-surface text-left" style={{ animationDelay: `${delay}ms` }}>
      <div className="relative flex h-[84px] items-center justify-center" style={{ background: style.tint, color: style.ink }}>
        {cover ? <img src={cover.url} alt="" className="h-full w-full object-cover" /> : <style.icon className="h-6 w-6" />}
        {item.showsToday && !item.readAt && <span className="absolute right-2.5 top-2.5 rounded-full bg-primary px-2 py-px text-[11px] font-semibold text-primary-fg">Novo</span>}
      </div>
      <div className="p-3">
        <p className="mb-1 text-[11px]" style={{ color: style.ink }}>
          {ANNOUNCEMENT_KIND_LABEL[item.kind]}
          {item.category ? ` · ${item.category}` : ""}
        </p>
        <p className="mb-2.5 line-clamp-2 text-sm font-semibold leading-snug">{item.title}</p>
        <div className="flex justify-between text-xs text-muted">
          <span>{(item.showsToday && announcementUntil(item)) || shortDate(item.startDate)}</span>
          <span>
            {item.requireAck && (item.ackAt ? "Ciente ✓" : "Pede ciente")}
            {likes > 0 && ` · ${likes} reações`}
          </span>
        </div>
      </div>
    </button>
  );
}

function DetailModal({ item, onClose }: { item: AnnouncementDTO; onClose: () => void }) {
  const queryClient = useQueryClient();
  const style = KIND_STYLE[item.kind];
  const [imageIndex, setImageIndex] = useState(0);
  const image = item.images[imageIndex];
  const updateBoard = (patch: (a: AnnouncementDTO) => AnnouncementDTO) =>
    queryClient.setQueryData<BoardResponse>(["announcements", "board"], (prev) =>
      prev ? { ...prev, items: prev.items.map((a) => (a.id === item.id ? patch(a) : a)), unread: prev.items.filter((a) => (a.id === item.id ? false : a.showsToday && !a.readAt)).length } : prev
    );

  useEffect(() => {
    if (item.readAt) return;
    api.post(`/announcements/${item.id}/read`).then(() => updateBoard((a) => ({ ...a, readAt: new Date().toISOString() }))).catch(() => undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [item.id]);

  const ack = useMutation({
    mutationFn: () => api.post(`/announcements/${item.id}/ack`),
    onSuccess: () => {
      updateBoard((a) => ({ ...a, ackAt: new Date().toISOString() }));
      queryClient.invalidateQueries({ queryKey: ["announcements", "pending"] });
      toast.success("Leitura confirmada.");
    },
    onError: () => toast.error("Não foi possível confirmar agora. Tente de novo."),
  });
  const react = useMutation({
    mutationFn: async (emoji: string) => (await api.post<AnnouncementDTO["reactions"]>(`/announcements/${item.id}/reactions`, { emoji })).data,
    onSuccess: (reactions) => updateBoard((a) => ({ ...a, reactions })),
  });

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-3 backdrop-blur-sm" onClick={onClose}>
      <div role="dialog" aria-modal="true" aria-labelledby="notice-title" className="story-in flex max-h-[92vh] w-full max-w-2xl flex-col overflow-hidden rounded-[20px] bg-surface shadow-elevated" onClick={(e) => e.stopPropagation()}>
        <div className="relative shrink-0" style={{ background: style.solid }}>
          {image ? (
            <img src={image.url} alt="" className="max-h-[320px] w-full object-cover" />
          ) : (
            <div className="flex h-28 items-center justify-center text-white">
              <style.icon className="h-9 w-9" />
            </div>
          )}
          <button onClick={onClose} className="focus-ring absolute right-3 top-3 rounded-full bg-black/40 p-1.5 text-white hover:bg-black/60" aria-label="Fechar">
            <X className="h-4 w-4" />
          </button>
          {item.images.length > 1 && (
            <div className="absolute bottom-3 left-0 right-0 flex justify-center gap-1.5">
              {item.images.map((img, i) => (
                <button key={img.url} onClick={() => setImageIndex(i)} className="h-1.5 rounded-full bg-white transition-all" style={{ width: i === imageIndex ? 18 : 6, opacity: i === imageIndex ? 1 : 0.5 }} aria-label={`Imagem ${i + 1}`} />
              ))}
            </div>
          )}
        </div>
        <div className="flex-1 overflow-y-auto p-5">
          <div className="mb-2 flex flex-wrap items-center gap-2">
            <KindBadge kind={item.kind} />
            {item.category && <span className="rounded-full border border-border px-2.5 py-0.5 text-[11px]">{item.category}</span>}
            <span className="text-xs text-muted">
              {item.authorName ? `${item.authorName} · ` : ""}
              {new Date(item.createdAt).toLocaleDateString("pt-BR", { day: "2-digit", month: "long", year: "numeric" })}
            </span>
          </div>
          <h2 id="notice-title" className="text-xl font-semibold leading-snug">
            {item.title}
          </h2>
          {item.body && <AnnouncementBody text={item.body} className="mt-3 text-[14.5px] leading-relaxed" />}
          {(item.linkUrl || item.attachments.length > 0) && (
            <div className="mt-4 flex flex-wrap gap-2">
              {item.linkUrl && (
                <a href={item.linkUrl} target="_blank" rel="noreferrer" className="focus-ring inline-flex items-center gap-1.5 rounded-card border border-border px-3 py-1.5 text-sm font-medium hover:bg-surface-alt">
                  <ExternalLink className="h-4 w-4" /> {item.linkLabel || "Abrir link"}
                </a>
              )}
              {item.attachments.map((f) => (
                <a key={f.url} href={f.url} target="_blank" rel="noreferrer" className="focus-ring inline-flex items-center gap-1.5 rounded-card border border-border px-3 py-1.5 text-sm font-medium hover:bg-surface-alt">
                  <FileText className="h-4 w-4" /> {f.fileName}
                </a>
              ))}
            </div>
          )}
        </div>
        <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border px-5 py-3">
          <div className="flex gap-1.5">
            {item.reactions.map((r) => (
              <button
                key={r.emoji}
                onClick={() => react.mutate(r.emoji)}
                className={clsx("focus-ring flex items-center gap-1 rounded-full border px-2.5 py-1 text-sm transition-colors", r.mine ? "border-primary bg-primary/10" : "border-border hover:bg-surface-alt")}
                aria-pressed={r.mine}
              >
                {r.emoji} {r.count > 0 && <span className="text-xs">{r.count}</span>}
              </button>
            ))}
          </div>
          {item.requireAck &&
            (item.ackAt ? (
              <span className="flex items-center gap-1.5 text-sm font-medium text-success">
                <CheckCircle2 className="h-4 w-4" /> Você confirmou em {new Date(item.ackAt).toLocaleDateString("pt-BR")}
              </span>
            ) : (
              <button onClick={() => ack.mutate()} disabled={ack.isPending} className="focus-ring flex items-center gap-1.5 rounded-card bg-primary px-4 py-2 text-sm font-semibold text-primary-fg disabled:opacity-60">
                <ShieldCheck className="h-4 w-4" /> Li e estou ciente
              </button>
            ))}
        </div>
      </div>
    </div>
  );
}
