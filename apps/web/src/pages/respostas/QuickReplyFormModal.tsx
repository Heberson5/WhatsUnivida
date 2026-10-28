import { useState, type FormEvent } from "react";
import { X } from "lucide-react";
import { PERMISSION, REPLY_MEDIA_CAPTION_MAX, type QuickReplyDTO } from "@whatsatendende/types";
import { useAuthStore } from "../../store/auth-store";
import { ConnectionScopePicker, toConnectionScopeValue, type ConnectionScopeValue } from "./ConnectionScopePicker";
import { ReplyMediaField, captionTooLong, hasReplyMedia, type ReplyMediaChange } from "./ReplyMediaField";
import { TagButtons, insertTag } from "../dados/TagButtons";

// Filled with the conversation's customer (and the greeting for the hour) when the reply is picked in the "/" menu.
const CUSTOMER_TAGS = ["{{saudacao}}", "{{primeiro_nome}}", "{{cliente}}"] as const;

export interface QuickReplyFormValues {
  name: string;
  shortcut: string;
  text: string;
  connectionScope: ConnectionScopeValue;
}

export function QuickReplyFormModal({
  quickReply,
  onClose,
  onSubmit,
}: {
  quickReply: QuickReplyDTO | null;
  onClose: () => void;
  onSubmit: (values: QuickReplyFormValues, media: ReplyMediaChange) => Promise<void>;
}) {
  const canEditMedia = Boolean(useAuthStore((s) => s.permissions)?.[PERMISSION.RESPOSTAS_MIDIA_GERENCIAR]);
  const [media, setMedia] = useState<ReplyMediaChange>({ kind: "keep" });
  const [values, setValues] = useState<QuickReplyFormValues>({
    name: quickReply?.name ?? "",
    shortcut: quickReply?.shortcut ?? "",
    text: quickReply?.text ?? "",
    connectionScope: toConnectionScopeValue(quickReply?.connectionScope, false),
  });
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [textEl, setTextEl] = useState<HTMLTextAreaElement | null>(null);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    if (!values.connectionScope.allConnections && values.connectionScope.connectionIds.length === 0) {
      setError("Escolha pelo menos uma conexão ou marque todas as conexões");
      return;
    }
    if (captionTooLong(values.text, quickReply?.media, media)) {
      setError(`Com anexo, o texto vai como legenda e pode ter até ${REPLY_MEDIA_CAPTION_MAX.toLocaleString("pt-BR")} caracteres.`);
      return;
    }
    setLoading(true);
    try {
      await onSubmit(values, media);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Erro ao salvar resposta rápida");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="drawer-backdrop">
      <form onSubmit={handleSubmit} className="drawer-panel max-w-md overflow-y-auto p-5">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-base font-semibold">{quickReply ? "Editar resposta rápida" : "Nova resposta rápida"}</h2>
          <button type="button" onClick={onClose} className="focus-ring rounded-full p-1 text-muted hover:bg-surface-alt" aria-label="Fechar">
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="space-y-3">
          <Field label="Nome">
            <input
              required
              value={values.name}
              onChange={(e) => setValues((v) => ({ ...v, name: e.target.value }))}
              placeholder="Ex: Boas-vindas"
              className="focus-ring w-full rounded-card border border-border bg-transparent px-3 py-2 text-sm"
            />
          </Field>

          <Field label="Atalho">
            <div className="flex items-center">
              <span className="rounded-l-card border border-r-0 border-border bg-surface-alt px-3 py-2 text-sm text-muted">/</span>
              <input
                required
                value={values.shortcut.replace(/^\/+/, "")}
                onChange={(e) => setValues((v) => ({ ...v, shortcut: e.target.value.replace(/\s+/g, "") }))}
                placeholder="boasvindas"
                className="focus-ring w-full rounded-r-card border border-border bg-transparent px-3 py-2 text-sm"
              />
            </div>
            <p className="mt-1 text-xs text-muted">Digitado pelo atendente na conversa (ex: "/{values.shortcut.replace(/^\/+/, "") || "boasvindas"}") para inserir o texto abaixo.</p>
          </Field>

          <ConnectionScopePicker
            value={values.connectionScope}
            onChange={(connectionScope) => setValues((v) => ({ ...v, connectionScope }))}
            hint='Aparece no "/" só para conversas dessas conexões.'
          />

          <Field label="Texto">
            <textarea
              required
              rows={5}
              value={values.text}
              ref={setTextEl}
              onChange={(e) => setValues((v) => ({ ...v, text: e.target.value }))}
              placeholder="Texto que será inserido no campo de mensagem..."
              className="focus-ring w-full resize-none rounded-card border border-border bg-transparent px-3 py-2 text-sm"
            />
            <TagButtons tags={CUSTOMER_TAGS} onInsert={(tag) => insertTag(textEl, values.text, tag, (text) => setValues((v) => ({ ...v, text })))} />
            {hasReplyMedia(quickReply?.media, media) && (
              <p className={`mt-1 text-xs ${values.text.length > REPLY_MEDIA_CAPTION_MAX ? "text-danger" : "text-muted"}`}>
                Legenda do anexo: {values.text.length.toLocaleString("pt-BR")} de {REPLY_MEDIA_CAPTION_MAX.toLocaleString("pt-BR")} caracteres
              </p>
            )}
          </Field>

          <ReplyMediaField
            current={quickReply?.media}
            previewPath={quickReply ? `/quick-replies/${quickReply.id}/media` : null}
            canEdit={canEditMedia}
            change={media}
            onChange={setMedia}
          />
        </div>

        {error && <p className="mt-3 rounded-card bg-danger-soft px-3 py-2 text-sm text-danger">{error}</p>}

        <div className="mt-5 flex gap-2">
          <button type="button" onClick={onClose} className="focus-ring flex-1 rounded-card border border-border py-2 text-sm">
            Cancelar
          </button>
          <button type="submit" disabled={loading} className="focus-ring flex-1 rounded-card bg-primary py-2 text-sm font-semibold text-primary-fg disabled:opacity-60">
            {loading ? "Salvando..." : "Salvar"}
          </button>
        </div>
      </form>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 block text-sm font-medium">{label}</span>
      {children}
    </label>
  );
}
