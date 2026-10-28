import { useState, type FormEvent } from "react";
import { useQuery } from "@tanstack/react-query";
import { X, AlertTriangle } from "lucide-react";
import { PERMISSION, REPLY_MEDIA_CAPTION_MAX, type ClosingMessageDTO } from "@whatsatendende/types";
import { api } from "../../lib/api";
import { useAuthStore } from "../../store/auth-store";
import { ReplyMediaField, captionTooLong, hasReplyMedia, type ReplyMediaChange } from "./ReplyMediaField";
import { AutoMessagePreview, SenderNameToggle } from "./AutoMessagePreview";
import { ConnectionScopePicker, toConnectionScopeValue, type ConnectionScopeValue } from "./ConnectionScopePicker";
import { fillAutoMessageTags, AGENT_EXAMPLE, CLIENT_EXAMPLE_NAME } from "../../lib/auto-message-tags";

// {{atendente}} kept for parity with Transferência/Aceite — see PROMPT:
// "quero que tenha as tags do cadastro do usuário".
const TAGS: { tag: string; label: string }[] = [
  { tag: "{{atendente}}", label: "Nome de exibição do atendente" },
  { tag: "{{atendente_nome}}", label: "Nome completo do atendente" },
  { tag: "{{atendente_cargo}}", label: "Cargo do atendente" },
  { tag: "{{cliente}}", label: "Nome do cliente" },
  { tag: "{{primeiro_nome}}", label: "Primeiro nome do cliente" },
  { tag: "{{saudacao}}", label: "Bom dia, Boa tarde ou Boa noite, conforme o horário" },
];

export interface EncerramentoFormValues {
  name: string;
  text: string;
  active: boolean;
  showSenderName: boolean;
  userIds: string[];
  connectionScope: ConnectionScopeValue;
}

interface AssignableUser {
  id: string;
  displayName: string;
  presence: "ONLINE" | "AWAY" | "OFFLINE";
  whatsappConnectionName: string | null;
}

const PRESENCE_DOT: Record<string, string> = { ONLINE: "bg-green-500", AWAY: "bg-yellow-500", OFFLINE: "bg-gray-400" };

export function EncerramentoFormModal({
  closingMessage,
  allClosingMessages,
  onClose,
  onSubmit,
}: {
  closingMessage: ClosingMessageDTO | null;
  /** Every other cadastro — used only to warn when checking a user already assigned elsewhere; see PROMPT: "se habilitar o usuário no recente, irá sair do anterior". */
  allClosingMessages: ClosingMessageDTO[];
  onClose: () => void;
  onSubmit: (values: EncerramentoFormValues, media: ReplyMediaChange) => Promise<void>;
}) {
  const canEditMedia = Boolean(useAuthStore((s) => s.permissions)?.[PERMISSION.RESPOSTAS_MIDIA_GERENCIAR]);
  const [media, setMedia] = useState<ReplyMediaChange>({ kind: "keep" });
  const { data: users } = useQuery({
    queryKey: ["agents-transfer-targets-all"],
    queryFn: async () => (await api.get<AssignableUser[]>("/agents/transfer-targets", { params: { excludeSelf: false } })).data,
  });

  const [values, setValues] = useState<EncerramentoFormValues>({
    name: closingMessage?.name ?? "",
    text: closingMessage?.text ?? "",
    active: closingMessage?.active ?? true,
    showSenderName: closingMessage?.showSenderName ?? true,
    userIds: closingMessage?.assignedUsers.map((u) => u.id) ?? [],
    connectionScope: toConnectionScopeValue(closingMessage?.connectionScope, true),
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
    const next = values.text.slice(0, start) + tag + values.text.slice(end);
    setValues((v) => ({ ...v, text: next }));
    requestAnimationFrame(() => {
      textareaEl.focus();
      textareaEl.setSelectionRange(start + tag.length, start + tag.length);
    });
  }

  // Only one agent involved (whoever is closing), so the sender and the
  // {{atendente}} tags always describe the same example person — unlike
  // Transferência, which involves two.
  const previewText = fillAutoMessageTags(values.text || "...", {
    atendente: AGENT_EXAMPLE.displayName,
    atendenteNome: AGENT_EXAMPLE.fullName,
    atendenteCargo: AGENT_EXAMPLE.cargo,
    cliente: CLIENT_EXAMPLE_NAME,
  });

  // Which OTHER cadastro (not this one) each user currently belongs to —
  // so checking them here can show exactly what they'll be moved out of,
  // instead of silently reassigning.
  const currentlyAssignedElsewhere = new Map<string, string>();
  for (const cm of allClosingMessages) {
    if (cm.id === closingMessage?.id) continue;
    for (const u of cm.assignedUsers) currentlyAssignedElsewhere.set(u.id, cm.name);
  }

  function toggleUser(userId: string) {
    setValues((v) => ({
      ...v,
      userIds: v.userIds.includes(userId) ? v.userIds.filter((id) => id !== userId) : [...v.userIds, userId],
    }));
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    if (!values.connectionScope.allConnections && values.connectionScope.connectionIds.length === 0) {
      setError("Escolha pelo menos uma conexão ou marque todas as conexões");
      return;
    }
    if (captionTooLong(values.text, closingMessage?.media, media)) {
      setError(`Com anexo, o texto vai como legenda e pode ter até ${REPLY_MEDIA_CAPTION_MAX.toLocaleString("pt-BR")} caracteres.`);
      return;
    }
    setLoading(true);
    try {
      await onSubmit(values, media);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Erro ao salvar encerramento");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="drawer-backdrop">
      <form onSubmit={handleSubmit} className="drawer-panel max-w-md overflow-y-auto p-5">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-base font-semibold">{closingMessage ? "Editar encerramento" : "Novo encerramento"}</h2>
          <button type="button" onClick={onClose} className="focus-ring rounded-full p-1 text-muted hover:bg-surface-alt" aria-label="Fechar">
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="flex-1 space-y-3 overflow-y-auto">
          <Field label="Nome">
            <input
              required
              value={values.name}
              onChange={(e) => setValues((v) => ({ ...v, name: e.target.value }))}
              placeholder="Ex: Encerramento padrão"
              className="focus-ring w-full rounded-card border border-border bg-transparent px-3 py-2 text-sm"
            />
          </Field>

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
              placeholder="Mensagem enviada ao cliente ao encerrar a conversa..."
              className="focus-ring w-full resize-none rounded-card border border-border bg-transparent px-3 py-2 text-sm"
            />
            <p className="mt-1 text-xs text-muted">Use *asterisco* pra negrito. A mensagem é enviada em nome de quem clicar em Encerrar.</p>
            {hasReplyMedia(closingMessage?.media, media) && (
              <p className={`mt-1 text-xs ${values.text.length > REPLY_MEDIA_CAPTION_MAX ? "text-danger" : "text-muted"}`}>
                Legenda do anexo: {values.text.length.toLocaleString("pt-BR")} de {REPLY_MEDIA_CAPTION_MAX.toLocaleString("pt-BR")} caracteres
              </p>
            )}
          </div>

          <ReplyMediaField
            current={closingMessage?.media}
            previewPath={closingMessage ? `/closing-messages/${closingMessage.id}/media` : null}
            canEdit={canEditMedia}
            change={media}
            onChange={setMedia}
          />

          <SenderNameToggle
            checked={values.showSenderName}
            onChange={(showSenderName) => setValues((v) => ({ ...v, showSenderName }))}
            note="Com a pesquisa de satisfação ligada, a mensagem sai depois da pesquisa sempre sem o nome."
          />

          <AutoMessagePreview senderName={values.showSenderName ? AGENT_EXAMPLE.fullName : null} text={previewText} />

          <label className="flex items-center justify-between rounded-card border border-border px-3 py-2">
            <span className="text-sm font-medium">Ativo</span>
            <input
              type="checkbox"
              checked={values.active}
              onChange={(e) => setValues((v) => ({ ...v, active: e.target.checked }))}
              className="h-4 w-4 accent-primary"
            />
          </label>

          <ConnectionScopePicker
            value={values.connectionScope}
            onChange={(connectionScope) => setValues((v) => ({ ...v, connectionScope }))}
            hint="Só é enviada ao encerrar conversas dessas conexões."
          />

          <div>
            <span className="mb-1 block text-sm font-medium">Usuários</span>
            <p className="mb-1.5 text-xs text-muted">Ao clicar em Encerrar, estes usuários disparam esta mensagem automaticamente.</p>
            <div className="max-h-52 overflow-y-auto rounded-card border border-border">
              {users?.length === 0 && <p className="p-4 text-center text-xs text-muted">Nenhum usuário disponível.</p>}
              {users?.map((u) => {
                const elsewhere = currentlyAssignedElsewhere.get(u.id);
                const checked = values.userIds.includes(u.id);
                return (
                  <label
                    key={u.id}
                    className="flex w-full items-start gap-3 border-b border-border px-3 py-2 last:border-b-0 hover:bg-surface-alt"
                  >
                    <input type="checkbox" checked={checked} onChange={() => toggleUser(u.id)} className="mt-0.5 h-4 w-4 shrink-0 accent-primary" />
                    <span className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${PRESENCE_DOT[u.presence]}`} />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm">
                        {u.displayName}
                        {u.whatsappConnectionName ? <span className="text-xs text-muted"> · {u.whatsappConnectionName}</span> : null}
                      </span>
                      {elsewhere && checked && (
                        <span className="mt-0.5 flex items-center gap-1 text-xs text-amber-600">
                          <AlertTriangle className="h-3 w-3 shrink-0" /> Vai sair de "{elsewhere}"
                        </span>
                      )}
                      {elsewhere && !checked && <span className="mt-0.5 block text-xs text-muted">Atualmente em "{elsewhere}"</span>}
                    </span>
                  </label>
                );
              })}
            </div>
          </div>
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
