import { useEffect, useMemo, useState } from "react";
import { ChevronDown, ChevronUp, Search, X } from "lucide-react";
import type { MessageDTO } from "@whatsatendende/types";

/** Lowercase without accents, so "aviso" also finds "Avíso" and "nao" finds "não". */
export function foldForSearch(value: string) {
  return value.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
}

/** A message's searchable text: what was written (or the caption), plus the name of a document sent with it. */
function searchableText(m: MessageDTO): string {
  return [m.body ?? "", ...m.attachments.filter((a) => a.kind === "DOCUMENT").map((a) => a.fileName)].join(" ");
}

/**
 * The magnifier inside a conversation — Atendimento and Gestão share it. Purely client-side, over the history already
 * loaded (both screens load all of it right after opening); `scrollTo` brings the current match into view.
 */
export function useConversationSearch(messages: MessageDTO[], scrollTo: (messageId: string) => void) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [index, setIndex] = useState(0);

  const matches = useMemo(() => {
    const normalized = foldForSearch(query.trim());
    if (!normalized) return [];
    return messages.filter((m) => foldForSearch(searchableText(m)).includes(normalized));
  }, [messages, query]);

  // A fresh search starts at the most recent match — the one most likely wanted — rather than the oldest. Keyed off the
  // query (not the matches) so it only jumps on a deliberate new search, not when the message list changes mid-search.
  useEffect(() => {
    setIndex(Math.max(0, matches.length - 1));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query]);

  const currentId = open ? (matches[index]?.id ?? null) : null;
  useEffect(() => {
    if (currentId) scrollTo(currentId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentId, open]);

  return {
    open,
    query,
    matches,
    index,
    currentId,
    /** Whether there's something typed — older pages then load without the pacing delay. */
    searching: open && query.trim().length > 0,
    openSearch: () => setOpen(true),
    setQuery,
    goTo: (direction: 1 | -1) => {
      if (matches.length === 0) return;
      setIndex((i) => (i + direction + matches.length) % matches.length);
    },
    close: () => {
      setOpen(false);
      setQuery("");
      setIndex(0);
    },
  };
}

export type ConversationSearchState = ReturnType<typeof useConversationSearch>;

export function ConversationSearchButton({ search }: { search: ConversationSearchState }) {
  return (
    <button
      onClick={search.openSearch}
      className="focus-ring flex items-center gap-1.5 rounded-card border border-border p-1.5 text-muted hover:bg-surface-alt sm:px-2"
      aria-label="Pesquisar nesta conversa"
      title="Pesquisar nesta conversa"
    >
      <Search className="h-3.5 w-3.5" />
    </button>
  );
}

/** The bar under the header: the text, "3/7", previous/next (Enter / Shift+Enter) and close (Esc). */
export function ConversationSearchBar({ search, loadingOlder }: { search: ConversationSearchState; loadingOlder: boolean }) {
  if (!search.open) return null;
  const { matches, index, query } = search;
  return (
    <div className="flex items-center gap-2 border-b border-border bg-surface px-3 py-2 sm:px-4">
      <Search className="h-4 w-4 shrink-0 text-muted" />
      <input
        autoFocus
        value={query}
        onChange={(e) => search.setQuery(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") search.goTo(e.shiftKey ? -1 : 1);
          if (e.key === "Escape") search.close();
        }}
        placeholder="Pesquisar nesta conversa"
        className="min-w-0 flex-1 bg-transparent text-sm focus:outline-none"
      />
      <span className="shrink-0 text-xs text-muted">
        {query.trim() ? (matches.length > 0 ? `${index + 1}/${matches.length}` : "0/0") : ""}
        {search.searching && loadingOlder ? " · buscando em mensagens antigas..." : ""}
      </span>
      <button
        onClick={() => search.goTo(-1)}
        disabled={matches.length === 0}
        className="focus-ring shrink-0 rounded-full p-1 text-muted hover:bg-surface-alt disabled:opacity-40"
        aria-label="Resultado anterior"
      >
        <ChevronUp className="h-4 w-4" />
      </button>
      <button
        onClick={() => search.goTo(1)}
        disabled={matches.length === 0}
        className="focus-ring shrink-0 rounded-full p-1 text-muted hover:bg-surface-alt disabled:opacity-40"
        aria-label="Próximo resultado"
      >
        <ChevronDown className="h-4 w-4" />
      </button>
      <button onClick={search.close} className="focus-ring shrink-0 rounded-full p-1 text-muted hover:bg-surface-alt" aria-label="Fechar pesquisa">
        <X className="h-4 w-4" />
      </button>
    </div>
  );
}
