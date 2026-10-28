import { useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowDown, ArrowUp, Pencil, Plus, Trash2, X } from "lucide-react";
import { toast } from "sonner";
import { PERMISSION, REPLY_MEDIA_CAPTION_MAX, type QueueWaitMessageDTO } from "@whatsatendende/types";
import { useAuthStore } from "../../store/auth-store";
import { api, getApiErrorMessage } from "../../lib/api";
import { fillAutoMessageTags, CLIENT_EXAMPLE_NAME } from "../../lib/auto-message-tags";
import { ConnectionScopePicker, describeConnectionScope, toConnectionScopeValue, type ConnectionScopeValue } from "./ConnectionScopePicker";
import { ReplyMediaField, captionTooLong, hasReplyMedia, saveReplyMediaOrWarn, type ReplyMediaChange } from "./ReplyMediaField";
import { AutoMessagePreview } from "./AutoMessagePreview";
import { MediaBadge } from "./RespostasRapidasTab";

// Nobody has the conversation yet, so no agent tags.
const TAGS: { tag: string; label: string }[] = [
  { tag: "{{saudacao}}", label: "Bom dia, Boa tarde ou Boa noite, conforme o horário" },
  { tag: "{{primeiro_nome}}", label: "Primeiro nome do cliente" },
  { tag: "{{cliente}}", label: "Nome do cliente" },
];

interface FormValues {
  delayMinutes: number;
  text: string;
  active: boolean;
  connectionScope: ConnectionScopeValue;
}

const BASE = "/queue-wait-messages";

/** Respostas › Espera na fila: the messages the customer gets, one after another, while waiting to be accepted. */
export function EsperaFilaTab() {
  const queryClient = useQueryClient();
  const permissions = useAuthStore((s) => s.permissions);
  const canAdicionar = permissions?.[PERMISSION.RESPOSTAS_ESPERA_ADICIONAR];
  const canEditar = permissions?.[PERMISSION.RESPOSTAS_ESPERA_EDITAR];
  const canExcluir = permissions?.[PERMISSION.RESPOSTAS_ESPERA_EXCLUIR];
  const [modalTarget, setModalTarget] = useState<QueueWaitMessageDTO | null | "new">(null);
  const [deleteTarget, setDeleteTarget] = useState<QueueWaitMessageDTO | null>(null);

  const { data: messages, isLoading } = useQuery({
    queryKey: ["queue-wait-messages"],
    queryFn: async () => (await api.get<QueueWaitMessageDTO[]>(BASE)).data,
  });
  const refresh = () => queryClient.invalidateQueries({ queryKey: ["queue-wait-messages"] });

  const saveMutation = useMutation({
    mutationFn: async ({ id, values, media }: { id: string | null; values: FormValues; media: ReplyMediaChange }) => {
      const saved = id ? (await api.patch<QueueWaitMessageDTO>(`${BASE}/${id}`, values)).data : (await api.post<QueueWaitMessageDTO>(BASE, values)).data;
      await saveReplyMediaOrWarn(BASE, saved.id, media);
    },
    onSettled: refresh,
    onSuccess: (_d, { id }) => toast.success(id ? "Mensagem de espera atualizada." : "Mensagem de espera criada."),
  });

  const moveMutation = useMutation({
    mutationFn: ({ id, direction }: { id: string; direction: "up" | "down" }) => api.post(`${BASE}/${id}/move`, { direction }),
    onSettled: refresh,
    onError: (err) => toast.error(getApiErrorMessage(err)),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => api.delete(`${BASE}/${id}`),
    onSuccess: () => {
      refresh();
      toast.success("Mensagem de espera excluída.");
      setDeleteTarget(null);
    },
    onError: (err) => toast.error(getApiErrorMessage(err)),
  });

  async function handleSubmit(values: FormValues, media: ReplyMediaChange) {
    try {
      await saveMutation.mutateAsync({ id: modalTarget && modalTarget !== "new" ? modalTarget.id : null, values, media });
    } catch (err) {
      throw new Error(getApiErrorMessage(err));
    }
  }

  // "aos N min na fila": when each one goes out, counting the ones before it (active ones only).
  let elapsed = 0;
  const sendsAt = new Map<string, number>();
  for (const m of messages ?? []) {
    if (!m.active) continue;
    elapsed += m.delayMinutes;
    sendsAt.set(m.id, elapsed);
  }

  return (
    <div className="flex h-full flex-col overflow-y-auto">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div className="max-w-2xl space-y-1 text-sm text-muted">
          <p>
            Enquanto o cliente espera na fila, recebe estas mensagens em ordem — cada uma alguns minutos depois da anterior (a primeira, depois que ele entra na fila).
          </p>
          <p className="text-xs">
            Só conta o tempo dentro do Horário de expediente e nada é enviado fora dele. Para quando um atendente aceita a conversa ou depois da última mensagem. Não vale
            enquanto o cliente está no Fluxo, nem para grupos. Sai sem o nome de atendente.
          </p>
        </div>
        {canAdicionar && (
          <button
            onClick={() => setModalTarget("new")}
            className="focus-ring flex shrink-0 items-center gap-1.5 rounded-card bg-primary px-4 py-2 text-sm font-semibold text-primary-fg hover:opacity-90"
          >
            <Plus className="h-4 w-4" /> Nova mensagem de espera
          </button>
        )}
      </div>

      <div className="shadow-soft min-h-[16rem] flex-1 overflow-auto rounded-card border border-border bg-surface">
        {isLoading && <p className="px-4 py-8 text-center text-sm text-muted">Carregando...</p>}
        {!isLoading && messages?.length === 0 && <p className="px-4 py-8 text-center text-sm text-muted">Nenhuma mensagem de espera cadastrada ainda.</p>}
        <ol>
          {messages?.map((m, i) => (
            <li key={m.id} className="flex items-start gap-3 border-b border-border px-4 py-3 last:border-b-0 hover:bg-surface-alt">
              <span className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-primary/10 text-xs font-semibold text-primary">{m.position}</span>
              <div className="min-w-0 flex-1">
                <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm font-medium">
                  <span>
                    {m.delayMinutes} min {i === 0 ? "depois de entrar na fila" : "depois da anterior"}
                  </span>
                  {sendsAt.has(m.id) && <span className="text-xs font-normal text-muted">· aos {sendsAt.get(m.id)} min na fila</span>}
                  <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${m.active ? "bg-green-100 text-green-700" : "bg-gray-100 text-gray-600"}`}>
                    {m.active ? "Ativa" : "Inativa"}
                  </span>
                </p>
                <p className="mt-0.5 flex items-center gap-1.5 text-sm text-muted" title={m.text}>
                  {m.media && <MediaBadge kind={m.media.kind} />}
                  <span className="truncate">{m.text}</span>
                </p>
                <p className="mt-0.5 truncate text-xs text-muted">{describeConnectionScope(m.connectionScope)}</p>
              </div>
              <div className="flex shrink-0 gap-1">
                {canEditar && (
                  <>
                    <IconButton label="Subir" disabled={i === 0 || moveMutation.isPending} onClick={() => moveMutation.mutate({ id: m.id, direction: "up" })}>
                      <ArrowUp className="h-4 w-4" />
                    </IconButton>
                    <IconButton label="Descer" disabled={i === (messages?.length ?? 0) - 1 || moveMutation.isPending} onClick={() => moveMutation.mutate({ id: m.id, direction: "down" })}>
                      <ArrowDown className="h-4 w-4" />
                    </IconButton>
                    <IconButton label="Editar" onClick={() => setModalTarget(m)}>
                      <Pencil className="h-4 w-4" />
                    </IconButton>
                  </>
                )}
                {canExcluir && (
                  <IconButton label="Excluir" danger onClick={() => setDeleteTarget(m)}>
                    <Trash2 className="h-4 w-4" />
                  </IconButton>
                )}
              </div>
            </li>
          ))}
        </ol>
      </div>

      {modalTarget && <EsperaFilaFormModal message={modalTarget === "new" ? null : modalTarget} onClose={() => setModalTarget(null)} onSubmit={handleSubmit} />}

      {deleteTarget && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-4">
          <div className="w-full max-w-sm rounded-card border border-border bg-surface p-5 shadow-elevated">
            <h2 className="text-base font-semibold">Excluir mensagem de espera?</h2>
            <p className="mt-2 text-sm text-muted">A mensagem {deleteTarget.position} será removida e as seguintes sobem uma posição.</p>
            <div className="mt-5 flex gap-2">
              <button onClick={() => setDeleteTarget(null)} className="focus-ring flex-1 rounded-card border border-border py-2 text-sm">
                Cancelar
              </button>
              <button
                onClick={() => deleteMutation.mutate(deleteTarget.id)}
                disabled={deleteMutation.isPending}
                className="focus-ring flex-1 rounded-card bg-red-600 py-2 text-sm font-semibold text-white disabled:opacity-60"
              >
                {deleteMutation.isPending ? "Excluindo..." : "Excluir"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function IconButton({ label, onClick, disabled, danger, children }: { label: string; onClick: () => void; disabled?: boolean; danger?: boolean; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      title={label}
      className={`focus-ring rounded-card p-1.5 text-muted disabled:opacity-30 ${danger ? "hover:bg-danger-soft hover:text-danger" : "hover:bg-surface-alt"}`}
    >
      {children}
    </button>
  );
}

function EsperaFilaFormModal({
  message,
  onClose,
  onSubmit,
}: {
  message: QueueWaitMessageDTO | null;
  onClose: () => void;
  onSubmit: (values: FormValues, media: ReplyMediaChange) => Promise<void>;
}) {
  const canEditMedia = Boolean(useAuthStore((s) => s.permissions)?.[PERMISSION.RESPOSTAS_MIDIA_GERENCIAR]);
  const [media, setMedia] = useState<ReplyMediaChange>({ kind: "keep" });
  const [values, setValues] = useState<FormValues>({
    delayMinutes: message?.delayMinutes ?? 5,
    text: message?.text ?? "",
    active: message?.active ?? true,
    connectionScope: toConnectionScopeValue(message?.connectionScope, true),
  });
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [textareaEl, setTextareaEl] = useState<HTMLTextAreaElement | null>(null);

  function insertTag(tag: string) {
    if (!textareaEl) {
      setValues((v) => ({ ...v, text: v.text + tag }));
      return;
    }
    const start = textareaEl.selectionStart ?? values.text.length;
    const end = textareaEl.selectionEnd ?? values.text.length;
    setValues((v) => ({ ...v, text: v.text.slice(0, start) + tag + v.text.slice(end) }));
    requestAnimationFrame(() => {
      textareaEl.focus();
      textareaEl.setSelectionRange(start + tag.length, start + tag.length);
    });
  }

  const previewText = fillAutoMessageTags(values.text || "...", { atendente: "", atendenteNome: "", atendenteCargo: "", cliente: CLIENT_EXAMPLE_NAME });

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    if (!Number.isInteger(values.delayMinutes) || values.delayMinutes < 1 || values.delayMinutes > 1440) {
      setError("Informe de 1 a 1.440 minutos.");
      return;
    }
    if (!values.connectionScope.allConnections && values.connectionScope.connectionIds.length === 0) {
      setError("Escolha pelo menos uma conexão ou marque todas as conexões");
      return;
    }
    if (captionTooLong(values.text, message?.media, media)) {
      setError(`Com anexo, o texto vai como legenda e pode ter até ${REPLY_MEDIA_CAPTION_MAX.toLocaleString("pt-BR")} caracteres.`);
      return;
    }
    setLoading(true);
    try {
      await onSubmit(values, media);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Erro ao salvar a mensagem de espera");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="drawer-backdrop">
      <form onSubmit={handleSubmit} className="drawer-panel max-w-md overflow-y-auto p-5">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-base font-semibold">{message ? `Editar mensagem de espera ${message.position}` : "Nova mensagem de espera"}</h2>
          <button type="button" onClick={onClose} className="focus-ring rounded-full p-1 text-muted hover:bg-surface-alt" aria-label="Fechar">
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="flex-1 space-y-3 overflow-y-auto">
          <label className="block">
            <span className="mb-1 block text-sm font-medium">Enviar depois de (minutos)</span>
            <input
              type="number"
              min={1}
              max={1440}
              required
              value={Number.isNaN(values.delayMinutes) ? "" : values.delayMinutes}
              onChange={(e) => setValues((v) => ({ ...v, delayMinutes: e.target.valueAsNumber }))}
              className="focus-ring w-32 rounded-card border border-border bg-transparent px-3 py-2 text-sm"
            />
            <span className="mt-1 block text-xs text-muted">
              Contados a partir da mensagem anterior (a primeira: de quando o cliente entra na fila), só dentro do Horário de expediente.
            </span>
          </label>

          <div>
            <div className="mb-1 flex items-center justify-between">
              <span className="text-sm font-medium">Texto</span>
              <div className="flex flex-wrap justify-end gap-1">
                {TAGS.map((t) => (
                  <button
                    key={t.tag}
                    type="button"
                    onClick={() => insertTag(t.tag)}
                    title={`Inserir ${t.label}`}
                    className="focus-ring rounded-full bg-secondary/30 px-2 py-0.5 text-[11px] font-medium text-text hover:bg-secondary/50"
                  >
                    {t.tag}
                  </button>
                ))}
              </div>
            </div>
            <textarea
              ref={setTextareaEl}
              required
              rows={4}
              value={values.text}
              onChange={(e) => setValues((v) => ({ ...v, text: e.target.value }))}
              placeholder="Ex: {{saudacao}}, {{primeiro_nome}}! Você está na fila e logo será atendido."
              className="focus-ring w-full resize-none rounded-card border border-border bg-transparent px-3 py-2 text-sm"
            />
            <p className="mt-1 text-xs text-muted">Use *asterisco* pra negrito. Com imagem, vídeo ou PDF, o texto vai como legenda.</p>
            {hasReplyMedia(message?.media, media) && (
              <p className={`mt-1 text-xs ${values.text.length > REPLY_MEDIA_CAPTION_MAX ? "text-danger" : "text-muted"}`}>
                Legenda do anexo: {values.text.length.toLocaleString("pt-BR")} de {REPLY_MEDIA_CAPTION_MAX.toLocaleString("pt-BR")} caracteres
              </p>
            )}
          </div>

          <ReplyMediaField current={message?.media} previewPath={message ? `${BASE}/${message.id}/media` : null} canEdit={canEditMedia} change={media} onChange={setMedia} />

          <AutoMessagePreview senderName={null} text={previewText} />

          <label className="flex items-center justify-between rounded-card border border-border px-3 py-2">
            <span className="text-sm font-medium">Ativa</span>
            <input type="checkbox" checked={values.active} onChange={(e) => setValues((v) => ({ ...v, active: e.target.checked }))} className="h-4 w-4 accent-primary" />
          </label>

          <ConnectionScopePicker
            value={values.connectionScope}
            onChange={(connectionScope) => setValues((v) => ({ ...v, connectionScope }))}
            hint="Só é enviada a quem espera na fila dessas conexões. Instagram e Messenger recebem as de todas as conexões, só o texto."
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
