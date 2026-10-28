import { useState, type FormEvent } from "react";
import { X } from "lucide-react";
import type { AutoMessageTemplateDTO, AutoMessageTrigger } from "@whatsatendende/types";
import { AutoMessagePreview, SenderNameToggle } from "./AutoMessagePreview";
import { ConnectionScopePicker, toConnectionScopeValue, type ConnectionScopeValue } from "./ConnectionScopePicker";
import { UserScopePicker, toUserScopeValue, type UserScopeValue } from "./UserScopePicker";
import {
  fillAutoMessageTags,
  AGENT_EXAMPLE,
  TRANSFER_TO_EXAMPLE,
  TRANSFER_FROM_EXAMPLE_FULLNAME,
  CLIENT_EXAMPLE_NAME,
} from "../../lib/auto-message-tags";

export interface AutoMessageFormValues {
  trigger: AutoMessageTrigger;
  name: string;
  text: string;
  active: boolean;
  showSenderName: boolean;
  connectionScope: ConnectionScopeValue;
  userScope: UserScopeValue;
}

// {{atendente}} kept for templates saved before the other two existed —
// see PROMPT: "quero que tenha as tags do cadastro do usuário".
const TAGS: { tag: string; label: string }[] = [
  { tag: "{{atendente}}", label: "Nome de exibição do atendente" },
  { tag: "{{atendente_nome}}", label: "Nome completo do atendente" },
  { tag: "{{atendente_cargo}}", label: "Cargo do atendente" },
  { tag: "{{cliente}}", label: "Nome do cliente" },
  { tag: "{{primeiro_nome}}", label: "Primeiro nome do cliente" },
  { tag: "{{saudacao}}", label: "Bom dia, Boa tarde ou Boa noite, conforme o horário" },
];

/**
 * Shared form for both auto-message tabs (Transferência/Aceite) — same
 * shape either way (nome, texto com tags, ativo), just a different
 * trigger. See PROMPT: "inclua em uma aba do menu Respostas, para poder
 * editar quando necessário e tenha disponível as tags."
 */
export function AutoMessageFormModal({
  trigger,
  template,
  onClose,
  onSubmit,
}: {
  trigger: AutoMessageTrigger;
  template: AutoMessageTemplateDTO | null;
  onClose: () => void;
  onSubmit: (values: AutoMessageFormValues) => Promise<void>;
}) {
  const [name, setName] = useState(template?.name ?? "");
  const [text, setText] = useState(template?.text ?? "");
  const [active, setActive] = useState(template?.active ?? true);
  const [showSenderName, setShowSenderName] = useState(template?.showSenderName ?? true);
  const [connectionScope, setConnectionScope] = useState(toConnectionScopeValue(template?.connectionScope, true));
  const [userScope, setUserScope] = useState(toUserScopeValue(template?.userScope));
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [textareaEl, setTextareaEl] = useState<HTMLTextAreaElement | null>(null);

  function insertTag(tag: string) {
    if (!textareaEl) {
      setText((t) => t + tag);
      return;
    }
    const start = textareaEl.selectionStart ?? text.length;
    const end = textareaEl.selectionEnd ?? text.length;
    const next = text.slice(0, start) + tag + text.slice(end);
    setText(next);
    requestAnimationFrame(() => {
      textareaEl.focus();
      textareaEl.setSelectionRange(start + tag.length, start + tag.length);
    });
  }

  // TRANSFER illustrates the two agents it actually involves with different
  // example people — {{atendente}}/_nome/_cargo describe who the customer
  // is landing on, while the sender (bold name atop the preview) is who
  // clicked "Transferir" — same distinction fixed for the real send. ACCEPT
  // has only one agent, so both are the same example person there.
  const templateAgentExample = trigger === "TRANSFER" ? TRANSFER_TO_EXAMPLE : AGENT_EXAMPLE;
  const senderExampleName = trigger === "TRANSFER" ? TRANSFER_FROM_EXAMPLE_FULLNAME : AGENT_EXAMPLE.fullName;
  const previewText = fillAutoMessageTags(text || "...", {
    atendente: templateAgentExample.displayName,
    atendenteNome: templateAgentExample.fullName,
    atendenteCargo: templateAgentExample.cargo,
    cliente: CLIENT_EXAMPLE_NAME,
  });

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    if (!connectionScope.allConnections && connectionScope.connectionIds.length === 0) {
      setError("Escolha pelo menos uma conexão ou marque todas as conexões");
      return;
    }
    if (!userScope.allUsers && userScope.userIds.length === 0) {
      setError("Escolha pelo menos um usuário ou marque todos os usuários");
      return;
    }
    setLoading(true);
    try {
      await onSubmit({ trigger, name, text, active, showSenderName, connectionScope, userScope });
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Erro ao salvar mensagem automática");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="drawer-backdrop">
      <form onSubmit={handleSubmit} className="drawer-panel max-w-md overflow-y-auto p-5">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-base font-semibold">{template ? "Editar mensagem automática" : "Nova mensagem automática"}</h2>
          <button type="button" onClick={onClose} className="focus-ring rounded-full p-1 text-muted hover:bg-surface-alt" aria-label="Fechar">
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="space-y-3">
          <label className="block">
            <span className="mb-1 block text-sm font-medium">Nome</span>
            <input
              required
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Ex: Aviso padrão"
              className="focus-ring w-full rounded-card border border-border bg-transparent px-3 py-2 text-sm"
            />
          </label>

          <div>
            {/* Wraps: the tags don't fit beside "Texto" in the panel, and pushed the whole form sideways. */}
            <div className="mb-1 flex flex-wrap items-center justify-between gap-1">
              <span className="text-sm font-medium">Texto</span>
              <div className="flex flex-wrap gap-1">
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
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder="Ex: Esta conversa foi transferida para {{atendente}}."
              className="focus-ring w-full resize-none rounded-card border border-border bg-transparent px-3 py-2 text-sm"
            />
            <p className="mt-1 text-xs text-muted">
              {trigger === "TRANSFER"
                ? 'Use *asterisco* pra negrito. As tags de atendente aqui descrevem quem vai RECEBER a conversa — a mensagem é enviada em nome de quem clicou em "Transferir".'
                : 'Use *asterisco* pra negrito. As tags de atendente descrevem quem aceitou a conversa — a mensagem é enviada em nome dessa mesma pessoa.'}
            </p>
          </div>

          <SenderNameToggle checked={showSenderName} onChange={setShowSenderName} />

          <AutoMessagePreview senderName={showSenderName ? senderExampleName : null} text={previewText} />

          <ConnectionScopePicker
            value={connectionScope}
            onChange={setConnectionScope}
            hint="Uma mensagem escolhida para a conexão tem prioridade sobre uma de todas as conexões."
          />

          {/* Transferência keeps one message for everyone — see PROMPT: "os campos para selecionar os usuários que poderão utilizar a mensagem" (Aceite). */}
          {trigger === "ACCEPT" && (
            <UserScopePicker
              value={userScope}
              onChange={setUserScope}
              hint="Enviada quando um destes usuários aceita a conversa. Uma mensagem escolhida para o usuário tem prioridade sobre uma de todos os usuários."
            />
          )}

          <label className="flex items-center justify-between rounded-card border border-border px-3 py-2">
            <span className="text-sm font-medium">Ativo</span>
            <input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} className="h-4 w-4 accent-primary" />
          </label>
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
