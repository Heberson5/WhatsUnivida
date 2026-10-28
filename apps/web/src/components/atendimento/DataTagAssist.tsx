import { Fragment, useEffect, useState } from "react";
import { toast } from "sonner";
import { Database } from "lucide-react";
import type { DataTagRenderDTO, DataTagsDTO } from "@whatsatendende/types";
import { api } from "../../lib/api";

const RENDER_DEBOUNCE_MS = 400;
const DATA_TAG = /\{\{\s*dados\.([a-z0-9_]+)\s*\}\}/g;
const FREE_FIELD = /\{\{\?\s*([^}]+?)\s*\}\}/g;
/** "{{" or "{{dados.par" right before the caret opens the variable list. */
const TYPING_TAG = /\{\{(?:dados\.)?([a-z0-9_]*)$/;

export function missingTagMessage(missing: string[]) {
  return `Não encontramos ${missing.map((m) => `*${m}*`).join(", ")} para este cliente na fonte de dados — a mensagem não pode ser enviada`;
}

/**
 * The composer's side of the {{dados.coluna}} tags: shows the text as it will
 * go out, refuses to send while a tag has no value for this client (the API
 * refuses too), asks for the free fields {{?campo}} and lists the columns
 * when "{{" is typed.
 */
export function useDataTagAssist(conversationId: string | undefined, text: string, caret: number) {
  const [tags, setTags] = useState<DataTagsDTO | null>(null);
  const [render, setRender] = useState<DataTagRenderDTO | null>(null);
  const [freeValues, setFreeValues] = useState<Record<string, string>>({});
  const hasDataTags = /\{\{\s*dados\./.test(text);
  const freeFields = [...new Set([...text.matchAll(FREE_FIELD)].map((m) => m[1]))];

  useEffect(() => {
    if (!hasDataTags || !conversationId) {
      setRender(null);
      return;
    }
    const timer = setTimeout(() => {
      api
        .post<DataTagRenderDTO>(`/conversations/${conversationId}/client-data/render`, { text })
        .then((res) => setRender(res.data))
        .catch(() => setRender(null));
    }, RENDER_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [text, hasDataTags, conversationId]);

  const typing = TYPING_TAG.exec(text.slice(0, caret));
  const isTypingTag = Boolean(typing);
  // Asked fresh each time "{{" is typed, so a source that just stopped working stops offering its columns.
  useEffect(() => {
    if (!isTypingTag) {
      setTags(null);
      return;
    }
    api
      .get<DataTagsDTO>("/data-sources/tags", { params: conversationId ? { conversationId } : undefined })
      .then((res) => setTags(res.data))
      .catch(() => setTags(null));
  }, [isTypingTag, conversationId]);
  const suggestions = typing && tags?.available ? tags.columns.filter((c) => c.startsWith(typing[1])).slice(0, 8) : [];

  /** The text ready to send (free fields filled), or null after warning why it can't go. */
  function finalize(value: string): string | null {
    const missing = render?.missing ?? [];
    if (hasDataTags && missing.length > 0) {
      toast.error(missingTagMessage(missing));
      return null;
    }
    const empty = freeFields.filter((f) => !freeValues[f]?.trim());
    if (empty.length > 0) {
      toast.error(`Preencha ${empty.map((f) => `"${f}"`).join(", ")} antes de enviar`);
      return null;
    }
    return value.replace(FREE_FIELD, (_m, field: string) => freeValues[field].trim());
  }

  /** Replaces the "{{..." being typed with the chosen tag. */
  function insertTag(value: string, column: string): { text: string; caret: number } {
    const before = value.slice(0, caret).replace(TYPING_TAG, `{{dados.${column}}}`);
    return { text: before + value.slice(caret), caret: before.length };
  }

  return {
    render: hasDataTags ? render : null,
    freeFields,
    freeValues,
    setFreeValue: (field: string, v: string) => setFreeValues((prev) => ({ ...prev, [field]: v })),
    suggestions,
    finalize,
    insertTag,
    reset: () => setFreeValues({}),
  };
}

/** The message as it will go out, with any tag that has no value in red. */
export function DataTagPreview({
  render,
  freeFields,
  freeValues,
  onFreeValue,
}: {
  render: DataTagRenderDTO | null;
  freeFields: string[];
  freeValues: Record<string, string>;
  onFreeValue: (field: string, value: string) => void;
}) {
  if (!render && freeFields.length === 0) return null;
  const parts = render ? render.text.split(DATA_TAG) : [];
  return (
    <div className="space-y-2 border-b border-border bg-surface-alt px-4 py-2 text-xs">
      {render && (
        <div>
          <p className="mb-0.5 flex items-center gap-1 font-semibold text-muted">
            <Database className="h-3 w-3" /> Vai assim:
          </p>
          <p className="whitespace-pre-wrap break-words">
            {parts.map((part, i) =>
              i % 2 === 1 ? (
                <mark key={i} className="rounded bg-danger-soft px-0.5 font-semibold text-danger">
                  {`{{dados.${part}}}`}
                </mark>
              ) : (
                <Fragment key={i}>{part}</Fragment>
              )
            )}
          </p>
          {render.missing.length > 0 && <p className="mt-1 font-medium text-danger">{missingTagMessage(render.missing)}</p>}
        </div>
      )}
      {freeFields.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {freeFields.map((field) => (
            <label key={field} className="flex items-center gap-1">
              <span className="font-medium">{field}:</span>
              <input
                value={freeValues[field] ?? ""}
                onChange={(e) => onFreeValue(field, e.target.value)}
                className="focus-ring w-36 rounded border border-border bg-surface px-1.5 py-0.5"
              />
            </label>
          ))}
        </div>
      )}
    </div>
  );
}
