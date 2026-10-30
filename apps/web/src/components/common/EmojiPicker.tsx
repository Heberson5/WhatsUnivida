import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import clsx from "clsx";
import { Search } from "lucide-react";

interface EmojiEntry {
  label: string;
  emoji: string;
  group?: number;
  version: number;
  tags?: string[];
  skins?: { emoji: string; tone?: number | number[] }[];
}

const RECENT_GROUP = -1;
/** What public/fonts/twemoji.woff2 draws; anything newer would show as a square. */
const FONT_EMOJI_VERSION = 15;
const GROUPS: { id: number; label: string; icon: string }[] = [
  { id: 0, label: "Sorrisos e emoções", icon: "😀" },
  { id: 1, label: "Pessoas", icon: "👋" },
  { id: 3, label: "Animais e natureza", icon: "🐶" },
  { id: 4, label: "Comidas e bebidas", icon: "🍕" },
  { id: 5, label: "Viagens e lugares", icon: "✈️" },
  { id: 6, label: "Atividades", icon: "⚽" },
  { id: 7, label: "Objetos", icon: "💡" },
  { id: 8, label: "Símbolos", icon: "❤️" },
  { id: 9, label: "Bandeiras", icon: "🏳️" },
];
const TONES: { tone: number; sample: string; label: string }[] = [
  { tone: 0, sample: "👋", label: "Tom padrão" },
  { tone: 1, sample: "👋🏻", label: "Tom de pele claro" },
  { tone: 2, sample: "👋🏼", label: "Tom de pele médio-claro" },
  { tone: 3, sample: "👋🏽", label: "Tom de pele médio" },
  { tone: 4, sample: "👋🏾", label: "Tom de pele médio-escuro" },
  { tone: 5, sample: "👋🏿", label: "Tom de pele escuro" },
];

const RECENT_KEY = "emoji:recent";
const TONE_KEY = "emoji:tone";
const MAX_RECENT = 32;
const MAX_RESULTS = 200;

function readStored<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

function store(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // A blocked storage only costs the "recentes" list.
  }
}

const plain = (text: string) =>
  text
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase();

let loaded: Promise<EmojiEntry[]> | null = null;
/** The whole list (with the Portuguese names the search uses) only downloads when someone first opens the panel. */
function loadEmojis() {
  loaded ??= import("emojibase-data/pt/data.json").then((m) => (m.default as EmojiEntry[]).filter((e) => e.group !== undefined && e.group !== 2 && e.version <= FONT_EMOJI_VERSION));
  return loaded;
}

/** The full emoji panel, like WhatsApp Web's: categories, search, recent ones and skin tones. */
export function EmojiPicker({ onPick, className }: { onPick: (emoji: string) => void; className?: string }) {
  const [emojis, setEmojis] = useState<EmojiEntry[] | null>(null);
  const [recent, setRecent] = useState<string[]>(() => readStored<string[]>(RECENT_KEY, []));
  const [group, setGroup] = useState(() => (readStored<string[]>(RECENT_KEY, []).length ? RECENT_GROUP : GROUPS[0].id));
  const [tone, setTone] = useState(() => readStored<number>(TONE_KEY, 0));
  const [search, setSearch] = useState("");

  useEffect(() => {
    let alive = true;
    void loadEmojis().then((list) => alive && setEmojis(list));
    return () => {
      alive = false;
    };
  }, []);

  const shown = useMemo(() => {
    if (!emojis) return [];
    const q = plain(search.trim());
    if (q) return emojis.filter((e) => plain(e.label).includes(q) || e.tags?.some((t) => plain(t).includes(q))).slice(0, MAX_RESULTS);
    return emojis.filter((e) => e.group === group);
  }, [emojis, group, search]);

  function pick(emoji: string) {
    const next = [emoji, ...recent.filter((e) => e !== emoji)].slice(0, MAX_RECENT);
    setRecent(next);
    store(RECENT_KEY, next);
    onPick(emoji);
  }

  const withTone = (e: EmojiEntry) => (tone && e.skins?.find((s) => s.tone === tone)?.emoji) || e.emoji;
  const button = (key: string, emoji: string, title?: string) => (
    <button key={key} type="button" title={title} onClick={() => pick(emoji)} className="focus-ring rounded-lg p-1 text-[22px] leading-none hover:bg-surface-alt">
      {emoji}
    </button>
  );

  return (
    <div className={clsx("flex flex-col overflow-hidden rounded-card border border-border bg-surface", className)}>
      <label className="m-2 mb-1 flex items-center gap-2 rounded-full bg-surface-alt px-3 py-1.5 text-sm text-muted">
        <Search className="h-4 w-4 shrink-0" />
        <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Pesquisar emoji" className="w-full bg-transparent text-[var(--color-text)] outline-none" />
      </label>
      {!search.trim() && (
        <div className="flex shrink-0 gap-0.5 overflow-x-auto border-b border-border px-1.5 pb-1">
          {[{ id: RECENT_GROUP, label: "Recentes", icon: "🕘" }, ...GROUPS].map((g) => (
            <button
              key={g.id}
              type="button"
              title={g.label}
              aria-label={g.label}
              aria-pressed={group === g.id}
              onClick={() => setGroup(g.id)}
              className={clsx("shrink-0 rounded-lg p-1 text-base leading-none hover:bg-surface-alt", group === g.id && "bg-primary/15")}
            >
              {g.icon}
            </button>
          ))}
        </div>
      )}
      <div className="min-h-0 flex-1 overflow-y-auto p-1.5">
        {!emojis && <p className="p-3 text-center text-xs text-muted">Carregando emojis…</p>}
        {emojis && search.trim() && shown.length === 0 && <p className="p-3 text-center text-xs text-muted">Nenhum emoji encontrado.</p>}
        {emojis && !search.trim() && group === RECENT_GROUP && recent.length === 0 && <p className="p-3 text-center text-xs text-muted">Os emojis que você usar aparecem aqui.</p>}
        <div className="flex flex-wrap">
          {!search.trim() && group === RECENT_GROUP ? recent.map((e) => button(e, e)) : shown.map((e) => button(e.emoji, withTone(e), e.label))}
        </div>
      </div>
      <div className="flex shrink-0 items-center justify-end gap-0.5 border-t border-border px-1.5 py-1">
        {TONES.map((t) => (
          <button
            key={t.tone}
            type="button"
            title={t.label}
            aria-label={t.label}
            aria-pressed={tone === t.tone}
            onClick={() => (setTone(t.tone), store(TONE_KEY, t.tone))}
            className={clsx("rounded-md p-0.5 text-sm leading-none hover:bg-surface-alt", tone === t.tone && "bg-primary/15")}
          >
            {t.sample}
          </button>
        ))}
      </div>
    </div>
  );
}

/** The same panel over the page: reacting with any emoji, from a bubble that has no room of its own for it. */
export function EmojiPickerDialog({ onPick, onClose }: { onPick: (emoji: string) => void; onClose: () => void }) {
  return createPortal(
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/30 p-4"
      role="presentation"
      onClick={(e) => {
        e.stopPropagation();
        onClose();
      }}
    >
      <div role="dialog" aria-modal="true" aria-label="Escolher emoji" className="shadow-elevated w-80 max-w-full" onClick={(e) => e.stopPropagation()}>
        <EmojiPicker className="h-96" onPick={onPick} />
      </div>
    </div>,
    document.body
  );
}
