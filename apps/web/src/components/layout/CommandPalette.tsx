import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import clsx from "clsx";
import { LogOut, Monitor, Moon, PauseCircle, PlayCircle, Search, Sparkles, Sun, UserCircle, type LucideIcon } from "lucide-react";
import { PERMISSION, type ConversationListItemDTO, type PauseReasonDTO } from "@whatsatendende/types";
import { api } from "../../lib/api";
import { contactDisplayName } from "../../lib/contact-display";
import { disconnectSocket } from "../../lib/socket";
import { useAuthStore } from "../../store/auth-store";
import { useCommandPaletteStore } from "../../store/command-palette-store";
import { useTheme } from "../../hooks/useTheme";
import { usePauseActions } from "../../hooks/usePauseActions";
import { useVisibleMenuItems } from "./Sidebar";

const MIN_CONTACT_QUERY = 2;
const MAX_CONTACTS = 6;

interface PaletteItem {
  id: string;
  group: "Contatos" | "Telas" | "Ações";
  label: string;
  hint?: string;
  icon?: LucideIcon;
  avatar?: string;
  run: () => void;
}

/** Accent/case-insensitive "contains" match. */
function normalize(text: string) {
  return text.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
}

function Highlight({ text, query }: { text: string; query: string }) {
  const i = query ? normalize(text).indexOf(normalize(query)) : -1;
  if (i < 0) return <>{text}</>;
  return (
    <>
      {text.slice(0, i)}
      <mark className="bg-transparent font-bold text-primary">{text.slice(i, i + query.length)}</mark>
      {text.slice(i + query.length)}
    </>
  );
}

function useDebounced<T>(value: T, ms: number) {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return debounced;
}

/** Ctrl+K / ⌘K search: contacts, screens and quick actions, from anywhere in the app. */
export function CommandPalette() {
  const open = useCommandPaletteStore((s) => s.open);
  const setOpen = useCommandPaletteStore((s) => s.setOpen);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setOpen(!useCommandPaletteStore.getState().open);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [setOpen]);

  if (!open) return null;
  return <PaletteDialog onClose={() => setOpen(false)} />;
}

function PaletteDialog({ onClose }: { onClose: () => void }) {
  const navigate = useNavigate();
  const user = useAuthStore((s) => s.user);
  const permissions = useAuthStore((s) => s.permissions);
  const clearSession = useAuthStore((s) => s.clearSession);
  const menuItems = useVisibleMenuItems();
  const { setTheme } = useTheme();
  const { pause, resume } = usePauseActions(onClose);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);
  const debouncedQuery = useDebounced(query.trim(), 250);
  const canOversee = Boolean(permissions?.[PERMISSION.GESTAO_ACESSAR]);
  const canAttend = Boolean(permissions?.[PERMISSION.ATENDIMENTO_ACESSAR]);
  const paused = user?.presence === "AWAY";

  const { data: mine } = useQuery({
    queryKey: ["mine"],
    queryFn: async () => (await api.get<ConversationListItemDTO[]>("/conversations/mine")).data,
    enabled: canAttend,
  });
  // Managers search every conversation (Gestão's own endpoint); agents only their own.
  const { data: oversight } = useQuery({
    queryKey: ["command-palette-contacts", debouncedQuery],
    queryFn: async () => (await api.get<ConversationListItemDTO[]>("/conversations/oversight", { params: { q: debouncedQuery } })).data,
    enabled: canOversee && debouncedQuery.length >= MIN_CONTACT_QUERY,
  });
  const { data: pauseReasons } = useQuery({
    queryKey: ["pause-reasons-active"],
    queryFn: async () => (await api.get<PauseReasonDTO[]>("/pause-reasons/active")).data,
    enabled: !paused,
  });

  const items = useMemo<PaletteItem[]>(() => {
    const q = normalize(query.trim());
    const matches = (text: string) => !q || normalize(text).includes(q);
    const mineIds = new Set(mine?.map((c) => c.id));

    const contactSource =
      query.trim().length < MIN_CONTACT_QUERY
        ? []
        : canOversee
          ? (oversight ?? [])
          : (mine ?? []).filter((c) => matches(contactDisplayName(c.contact, c.channel)) || matches(c.contact.phone ?? ""));
    // One row per contact: the most recent conversation wins.
    const seen = new Set<string>();
    const contacts: PaletteItem[] = [];
    for (const c of [...contactSource].sort((a, b) => b.lastMessageAt.localeCompare(a.lastMessageAt))) {
      if (seen.has(c.contact.id) || contacts.length >= MAX_CONTACTS) continue;
      seen.add(c.contact.id);
      const isMine = mineIds.has(c.id);
      contacts.push({
        id: `contact-${c.id}`,
        group: "Contatos",
        label: contactDisplayName(c.contact, c.channel),
        avatar: contactDisplayName(c.contact, c.channel).slice(0, 2).toUpperCase(),
        hint: isMine ? "em atendimento com você" : c.assignedAgentName ? `com ${c.assignedAgentName}` : c.contact.phone ?? undefined,
        run: () => navigate(isMine ? `/atendimento?open=${c.id}` : `/gestao?open=${c.id}`),
      });
    }

    const screens: PaletteItem[] = [
      ...menuItems.map((m) => ({ id: `screen-${m.to}`, group: "Telas" as const, label: m.label, icon: m.icon, hint: "ir para", run: () => navigate(m.to) })),
      { id: "screen-perfil", group: "Telas" as const, label: "Meu Perfil", icon: UserCircle, hint: "ir para", run: () => navigate("/perfil") },
      { id: "screen-notas", group: "Telas" as const, label: "Notas de versão", icon: Sparkles, hint: "ir para", run: () => navigate("/notas-de-versao") },
    ].filter((s) => matches(s.label));

    const actions: PaletteItem[] = [
      ...(paused
        ? [{ id: "resume", group: "Ações" as const, label: "Retomar atendimento", icon: PlayCircle, run: () => resume.mutate() }]
        : (pauseReasons ?? []).map((r) => ({
            id: `pause-${r.id}`,
            group: "Ações" as const,
            label: `Pausar: ${r.name}`,
            icon: PauseCircle,
            run: () => pause.mutate(r.id),
          }))),
      { id: "theme-light", group: "Ações" as const, label: "Tema claro", icon: Sun, run: () => setTheme("LIGHT") },
      { id: "theme-dark", group: "Ações" as const, label: "Tema escuro", icon: Moon, run: () => setTheme("DARK") },
      { id: "theme-auto", group: "Ações" as const, label: "Tema automático", icon: Monitor, run: () => setTheme("AUTO") },
      {
        id: "logout",
        group: "Ações" as const,
        label: "Sair",
        icon: LogOut,
        run: async () => {
          await api.post("/auth/logout").catch(() => undefined);
          disconnectSocket();
          clearSession();
          navigate("/login");
        },
      },
    ].filter((a) => matches(a.label));

    return [...contacts, ...screens, ...actions];
  }, [query, mine, oversight, canOversee, menuItems, paused, pauseReasons, navigate, pause, resume, setTheme, clearSession]);

  useEffect(() => setActive(0), [query]);
  useEffect(() => {
    listRef.current?.querySelector(`[data-index="${active}"]`)?.scrollIntoView({ block: "nearest" });
  }, [active]);

  function choose(item: PaletteItem) {
    item.run();
    // Pause/resume close the palette themselves once the request succeeds.
    if (!item.id.startsWith("pause-") && item.id !== "resume") onClose();
  }

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Escape") {
      e.preventDefault();
      onClose();
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((i) => Math.min(i + 1, items.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((i) => Math.max(i - 1, 0));
    } else if (e.key === "Enter" && items[active]) {
      e.preventDefault();
      choose(items[active]);
    }
  }

  const searchingContacts = canOversee && query.trim().length >= MIN_CONTACT_QUERY && (debouncedQuery !== query.trim() || !oversight);

  return (
    <div className="fixed inset-0 z-[60] flex items-start justify-center bg-black/45 px-3 pt-[10vh] backdrop-blur-[2px]" onMouseDown={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Busca rápida"
        className="w-full max-w-xl overflow-hidden rounded-2xl border border-border bg-surface shadow-elevated"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-3 border-b border-border px-4 py-3.5">
          <Search className="h-5 w-5 shrink-0 text-muted" />
          <input
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder="Buscar contato, tela ou ação…"
            className="flex-1 bg-transparent text-base outline-none placeholder:text-muted"
            aria-controls="command-palette-list"
            aria-activedescendant={items[active] ? `cp-${items[active].id}` : undefined}
          />
          <kbd className="rounded border border-border px-1.5 font-mono text-[10px] text-muted">Esc</kbd>
        </div>
        <div ref={listRef} id="command-palette-list" role="listbox" className="max-h-[55vh] overflow-y-auto p-2">
          {items.length === 0 && !searchingContacts && <p className="px-3 py-8 text-center text-sm text-muted">Nada encontrado para “{query}”.</p>}
          {(["Contatos", "Telas", "Ações"] as const).map((group) => {
            const groupItems = items.filter((i) => i.group === group);
            if (group === "Contatos" && searchingContacts && groupItems.length === 0) {
              return (
                <p key={group} className="px-3 py-2 text-xs text-muted">
                  Buscando contatos…
                </p>
              );
            }
            if (groupItems.length === 0) return null;
            return (
              <div key={group} className="mb-1">
                <p className="px-2.5 pb-1 pt-2 text-[10px] font-semibold uppercase tracking-[0.08em] text-muted">{group}</p>
                {groupItems.map((item) => {
                  const index = items.indexOf(item);
                  return (
                    <button
                      key={item.id}
                      id={`cp-${item.id}`}
                      data-index={index}
                      role="option"
                      aria-selected={index === active}
                      onMouseMove={() => setActive(index)}
                      onClick={() => choose(item)}
                      className={clsx(
                        "flex w-full items-center gap-3 rounded-lg px-2.5 py-2 text-left text-sm",
                        index === active ? "bg-primary/10" : "hover:bg-surface-alt"
                      )}
                    >
                      {item.avatar ? (
                        <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-primary/15 text-[10px] font-bold text-primary">{item.avatar}</span>
                      ) : item.icon ? (
                        <item.icon className="h-4 w-4 shrink-0 text-muted" />
                      ) : null}
                      <span className="min-w-0 flex-1 truncate">
                        <Highlight text={item.label} query={query.trim()} />
                      </span>
                      {item.hint && <span className="shrink-0 truncate text-xs text-muted">{item.hint}</span>}
                    </button>
                  );
                })}
              </div>
            );
          })}
        </div>
        <div className="hidden gap-4 border-t border-border bg-surface-alt px-4 py-2 text-[11px] text-muted sm:flex">
          <span>
            <kbd className="rounded border border-border bg-surface px-1 font-mono">↑↓</kbd> navegar
          </span>
          <span>
            <kbd className="rounded border border-border bg-surface px-1 font-mono">Enter</kbd> abrir
          </span>
          <span>
            <kbd className="rounded border border-border bg-surface px-1 font-mono">Esc</kbd> fechar
          </span>
        </div>
      </div>
    </div>
  );
}
