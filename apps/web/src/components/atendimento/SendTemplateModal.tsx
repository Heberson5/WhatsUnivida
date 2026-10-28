import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import clsx from "clsx";
import { FileText, X } from "lucide-react";
import { toast } from "sonner";
import type { MessageTemplateDTO } from "@whatsatendende/types";
import { api, getApiErrorMessage } from "../../lib/api";

const CATEGORY_LABEL: Record<string, string> = { MARKETING: "Marketing", UTILITY: "Utilidade", AUTHENTICATION: "Autenticação" };

function paramCount(text: string | null): number {
  return Math.max(0, ...[...(text ?? "").matchAll(/\{\{(\d+)\}\}/g)].map((m) => Number(m[1])));
}

function fill(text: string, params: string[]): string {
  return text.replace(/\{\{(\d+)\}\}/g, (tag, n: string) => params[Number(n) - 1] || tag);
}

/** Picks an approved WhatsApp Oficial template, fills its {{n}} fields and sends it into the conversation. */
export function SendTemplateModal({
  conversationId,
  templates,
  onClose,
  onSent,
}: {
  conversationId: string;
  templates: MessageTemplateDTO[];
  onClose: () => void;
  onSent: () => void;
}) {
  const [selected, setSelected] = useState<MessageTemplateDTO | null>(templates.length === 1 ? templates[0] : null);
  const [headerParams, setHeaderParams] = useState<string[]>([]);
  const [bodyParams, setBodyParams] = useState<string[]>([]);

  const headerCount = selected?.headerType === "TEXT" ? paramCount(selected.headerText) : 0;
  const bodyCount = selected ? paramCount(selected.bodyText) : 0;
  const complete = Boolean(selected) && [...Array(headerCount)].every((_, i) => headerParams[i]?.trim()) && [...Array(bodyCount)].every((_, i) => bodyParams[i]?.trim());

  const send = useMutation({
    mutationFn: () =>
      api.post(`/messages/conversations/${conversationId}/template`, {
        templateId: selected!.id,
        headerParams: headerParams.slice(0, headerCount).map((p) => p.trim()),
        bodyParams: bodyParams.slice(0, bodyCount).map((p) => p.trim()),
      }),
    onSuccess: () => {
      toast.success("Template enviado.");
      onSent();
    },
    onError: (err) => toast.error(getApiErrorMessage(err)),
  });

  function choose(template: MessageTemplateDTO) {
    setSelected(template);
    setHeaderParams([]);
    setBodyParams([]);
  }

  return (
    <div className="drawer-backdrop" onClick={onClose}>
      <div className="drawer-panel max-w-md" role="dialog" aria-modal="true" aria-labelledby="send-template-title" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between border-b border-border px-5 py-4">
          <h2 id="send-template-title" className="text-base font-semibold">
            Enviar template
          </h2>
          <button type="button" onClick={onClose} className="focus-ring rounded-lg p-1.5 text-muted hover:bg-surface-alt" aria-label="Fechar">
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="flex-1 space-y-4 overflow-y-auto px-5 py-4">
          <p className="text-xs text-muted">Somente templates aprovados pela Meta para esta conexão aparecem aqui.</p>
          {templates.length === 0 && (
            <p className="rounded-card border border-dashed border-border p-4 text-center text-sm text-muted">
              Nenhum template aprovado para esta conexão. Cadastre um em Respostas › Templates e aguarde a aprovação da Meta.
            </p>
          )}
          <div className="space-y-1.5">
            {templates.map((t) => (
              <button
                key={t.id}
                type="button"
                onClick={() => choose(t)}
                aria-pressed={selected?.id === t.id}
                className={clsx(
                  "focus-ring flex w-full items-start gap-2.5 rounded-lg border px-3 py-2 text-left",
                  selected?.id === t.id ? "border-primary bg-primary/[0.06]" : "border-border hover:bg-surface-alt"
                )}
              >
                <FileText className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-mono text-[13px] font-semibold">{t.name}</span>
                  <span className="line-clamp-2 text-xs text-muted">{t.bodyText}</span>
                </span>
                <span className="shrink-0 rounded-full bg-surface-alt px-2 py-0.5 text-[10.5px] font-semibold text-muted">{CATEGORY_LABEL[t.category] ?? t.category}</span>
              </button>
            ))}
          </div>

          {selected && (headerCount > 0 || bodyCount > 0) && (
            <div className="space-y-2">
              <p className="text-xs font-semibold uppercase tracking-[0.06em] text-muted">Preencha os campos</p>
              {[...Array(headerCount)].map((_, i) => (
                <label key={`h${i}`} className="block">
                  <span className="mb-1 block text-xs font-medium">Cabeçalho {`{{${i + 1}}}`}</span>
                  <input
                    value={headerParams[i] ?? ""}
                    onChange={(e) => setHeaderParams((p) => Object.assign([...p], { [i]: e.target.value }))}
                    maxLength={60}
                    className="focus-ring w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm"
                  />
                </label>
              ))}
              {[...Array(bodyCount)].map((_, i) => (
                <label key={`b${i}`} className="block">
                  <span className="mb-1 block text-xs font-medium">Texto {`{{${i + 1}}}`}</span>
                  <input
                    value={bodyParams[i] ?? ""}
                    onChange={(e) => setBodyParams((p) => Object.assign([...p], { [i]: e.target.value }))}
                    maxLength={1024}
                    className="focus-ring w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm"
                  />
                </label>
              ))}
            </div>
          )}

          {selected && (
            <div>
              <p className="mb-1.5 text-xs font-semibold uppercase tracking-[0.06em] text-muted">Como o cliente vai receber</p>
              <div className="rounded-card bg-[#e9e2d6] p-3 dark:bg-[#1b2229]">
                <div className="ms-auto max-w-[85%] whitespace-pre-wrap rounded-lg bg-[#d9fdd3] px-3 py-2 text-[13px] text-[#111b21] shadow-sm dark:bg-[#005c4b] dark:text-[#e9edef]">
                  {selected.headerType === "TEXT" && selected.headerText && <p className="mb-1 font-semibold">{fill(selected.headerText, headerParams)}</p>}
                  {selected.headerType !== "TEXT" && selected.headerType !== "NONE" && <p className="mb-1 text-xs opacity-70">[{selected.headerSampleFileName ?? "mídia do cabeçalho"}]</p>}
                  <p>{fill(selected.bodyText, bodyParams)}</p>
                  {selected.footerText && <p className="mt-1 text-[11px] opacity-60">{selected.footerText}</p>}
                </div>
              </div>
            </div>
          )}
        </div>
        <div className="flex gap-2 border-t border-border px-5 py-4">
          <button type="button" onClick={onClose} className="focus-ring flex-1 rounded-lg border border-border px-4 py-2 text-sm font-medium hover:bg-surface-alt">
            Cancelar
          </button>
          <button
            type="button"
            disabled={!complete || send.isPending}
            onClick={() => send.mutate()}
            className="focus-ring flex-1 rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-primary-fg disabled:opacity-50"
          >
            {send.isPending ? "Enviando..." : "Enviar template"}
          </button>
        </div>
      </div>
    </div>
  );
}
