import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import clsx from "clsx";
import { RotateCcw, Save } from "lucide-react";
import { DEFAULT_BIRTHDAY_MESSAGES, PERMISSION, fillBirthdayTags, type BirthdayKind, type BirthdayMessageDTO } from "@whatsatendende/types";
import { useAuthStore } from "../../store/auth-store";
import { api, getApiErrorMessage } from "../../lib/api";
import { fillAutoMessageTags, AGENT_EXAMPLE, CLIENT_EXAMPLE_NAME } from "../../lib/auto-message-tags";
import { renderWhatsAppFormatting } from "../../lib/whatsappFormatting";
import { ReplyMediaField, captionTooLong, saveReplyMediaOrWarn, type ReplyMediaChange } from "./ReplyMediaField";

const BASE = "/birthday-messages";

const CARDS: Record<BirthdayKind, { icon: string; title: string; description: string; example: { name: string; firstName: string; relation: string; age: number } }> = {
  HOLDER: { icon: "🎂", title: "Para o cliente (titular)", description: "Quando o próprio cliente faz aniversário", example: { name: CLIENT_EXAMPLE_NAME, firstName: CLIENT_EXAMPLE_NAME.split(" ")[0], relation: "Titular", age: 62 } },
  BENEFICIARY: { icon: "💐", title: "Para o beneficiário", description: "Quando alguém do contrato (filho, neto, cônjuge...) faz aniversário", example: { name: "Pedro Souza", firstName: "Pedro", relation: "Neto", age: 8 } },
};

const TAGS: Record<BirthdayKind, { tag: string; label: string }[]> = {
  HOLDER: [
    { tag: "{{saudacao}}", label: "Bom dia, Boa tarde ou Boa noite" },
    { tag: "{{primeiro_nome}}", label: "Primeiro nome do cliente" },
    { tag: "{{cliente}}", label: "Nome do cliente" },
    { tag: "{{idade}}", label: "A idade que faz hoje" },
    { tag: "{{atendente}}", label: "Nome do atendente" },
  ],
  BENEFICIARY: [
    { tag: "{{aniversariante}}", label: "Nome de quem faz aniversário" },
    { tag: "{{aniversariante_primeiro_nome}}", label: "Primeiro nome de quem faz aniversário" },
    { tag: "{{parentesco}}", label: "Filho, neto, cônjuge... (como vem na planilha)" },
    { tag: "{{idade}}", label: "A idade que faz hoje" },
    { tag: "{{saudacao}}", label: "Bom dia, Boa tarde ou Boa noite" },
    { tag: "{{primeiro_nome}}", label: "Primeiro nome do cliente (quem conversa)" },
  ],
};

/** Respostas › Aniversários: the message the birthday pop-up suggests, for the client and for a beneficiary. */
export function AniversariosTab() {
  const permissions = useAuthStore((s) => s.permissions);
  const canEdit = Boolean(permissions?.[PERMISSION.RESPOSTAS_ANIVERSARIO_EDITAR]);
  const { data: messages } = useQuery({ queryKey: ["birthday-messages"], queryFn: async () => (await api.get<BirthdayMessageDTO[]>(BASE)).data });

  return (
    <div className="h-full overflow-y-auto pb-6">
      <p className="mb-4 max-w-3xl text-sm text-muted">
        Quando o atendente aceita uma conversa e alguém do contrato do cliente faz aniversário hoje (pela data de nascimento da fonte de dados), aparece um aviso com a mensagem abaixo pronta.
        O atendente envia como está ou edita antes. Cada pessoa é parabenizada uma vez por ano.
      </p>
      <div className="grid gap-5 xl:grid-cols-2">
        {(["HOLDER", "BENEFICIARY"] as const).map((kind) => {
          const message = messages?.find((m) => m.kind === kind);
          return message ? <BirthdayMessageCard key={kind} message={message} canEdit={canEdit} /> : <div key={kind} className="h-80 animate-pulse rounded-2xl bg-surface-alt" />;
        })}
      </div>
    </div>
  );
}

function BirthdayMessageCard({ message, canEdit }: { message: BirthdayMessageDTO; canEdit: boolean }) {
  const queryClient = useQueryClient();
  const card = CARDS[message.kind];
  const [text, setText] = useState(message.text);
  const [active, setActive] = useState(message.active);
  const [media, setMedia] = useState<ReplyMediaChange>({ kind: "keep" });
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    setText(message.text);
    setActive(message.active);
  }, [message.text, message.active]);
  const dirty = text !== message.text || active !== message.active || media.kind !== "keep";
  const tooLong = captionTooLong(text, message.media, media);

  const save = useMutation({
    mutationFn: async () => {
      await api.patch(`${BASE}/${message.kind}`, { text, active });
      await saveReplyMediaOrWarn(BASE, message.kind, media);
    },
    onSuccess: () => {
      setMedia({ kind: "keep" });
      queryClient.invalidateQueries({ queryKey: ["birthday-messages"] });
      toast.success("Mensagem de aniversário salva.");
    },
    onError: (err) => toast.error(getApiErrorMessage(err)),
  });

  function insertTag(tag: string) {
    const el = textareaRef.current;
    const start = el?.selectionStart ?? text.length;
    const end = el?.selectionEnd ?? text.length;
    setText(text.slice(0, start) + tag + text.slice(end));
    requestAnimationFrame(() => {
      el?.focus();
      el?.setSelectionRange(start + tag.length, start + tag.length);
    });
  }

  const preview = fillAutoMessageTags(fillBirthdayTags(text, card.example), {
    atendente: AGENT_EXAMPLE.displayName,
    atendenteNome: AGENT_EXAMPLE.fullName,
    atendenteCargo: AGENT_EXAMPLE.cargo,
    cliente: CLIENT_EXAMPLE_NAME,
  });

  return (
    <section className={clsx("flex flex-col gap-4 rounded-2xl border border-border bg-surface p-4 shadow-soft sm:flex-row", !active && "opacity-80")}>
      <div className="min-w-0 flex-1 space-y-3">
        <div className="flex items-center gap-3">
          <span className={clsx("flex h-10 w-10 items-center justify-center rounded-xl text-xl", message.kind === "HOLDER" ? "bg-secondary/40" : "bg-primary/15")}>{card.icon}</span>
          <div className="min-w-0 flex-1">
            <h3 className="font-bold">{card.title}</h3>
            <p className="text-xs text-muted">{card.description}</p>
          </div>
          <label className="flex items-center gap-2 text-xs font-semibold text-muted">
            {active ? "Ativa" : "Desligada"}
            <input type="checkbox" role="switch" checked={active} disabled={!canEdit} onChange={(e) => setActive(e.target.checked)} className="h-4 w-4 accent-[var(--color-primary)]" />
          </label>
        </div>
        <textarea
          ref={textareaRef}
          value={text}
          onChange={(e) => setText(e.target.value)}
          readOnly={!canEdit}
          rows={8}
          maxLength={4000}
          className="focus-ring w-full resize-y rounded-card border border-border bg-surface-alt px-3 py-2 text-sm leading-relaxed"
          aria-label={`Texto ${card.title}`}
        />
        {tooLong && <p className="text-xs text-danger">Com imagem, o texto vai como legenda e precisa ser menor.</p>}
        {canEdit && (
          <div className="flex flex-wrap gap-1.5">
            {TAGS[message.kind].map((t) => (
              <button
                key={t.tag}
                type="button"
                onClick={() => insertTag(t.tag)}
                title={t.label}
                className="rounded-full border border-dashed border-primary/50 bg-surface px-2 py-0.5 font-mono text-[11px] text-primary hover:bg-primary/10"
              >
                {t.tag}
              </button>
            ))}
          </div>
        )}
        <ReplyMediaField current={message.media} previewPath={`${BASE}/${message.kind}/media`} canEdit={canEdit} change={media} onChange={setMedia} />
        <div className="flex flex-wrap items-center gap-2">
          {canEdit && (
            <>
              <button
                onClick={() => save.mutate()}
                disabled={!dirty || !text.trim() || tooLong || save.isPending}
                className="focus-ring inline-flex items-center gap-1.5 rounded-card bg-primary px-3 py-1.5 text-sm font-semibold text-primary-fg disabled:opacity-50"
              >
                <Save className="h-4 w-4" /> Salvar
              </button>
              {text !== DEFAULT_BIRTHDAY_MESSAGES[message.kind] && (
                <button onClick={() => setText(DEFAULT_BIRTHDAY_MESSAGES[message.kind])} className="focus-ring inline-flex items-center gap-1.5 rounded-card px-3 py-1.5 text-sm font-semibold text-muted hover:bg-surface-alt">
                  <RotateCcw className="h-4 w-4" /> Voltar ao texto original
                </button>
              )}
            </>
          )}
          {message.updatedByName && <span className="text-xs text-muted">Alterada por {message.updatedByName}</span>}
        </div>
      </div>

      <div className="w-full shrink-0 sm:w-64">
        <p className="mb-1.5 text-xs font-medium text-muted">Como o cliente recebe:</p>
        <div className="overflow-hidden rounded-[22px] border-[6px] border-[#10161c] bg-[#efeae2] dark:bg-[#0b141a]">
          <div className="flex items-center gap-2 bg-[#0b6a5a] px-3 py-2 text-xs font-bold text-white">
            <span className="flex h-6 w-6 items-center justify-center rounded-full bg-white/20 text-[10px]">MC</span>
            {CLIENT_EXAMPLE_NAME}
          </div>
          <div className="space-y-2 p-2.5">
            {(media.kind === "set" || (media.kind === "keep" && message.media)) && (
              <div className="ml-auto flex aspect-[4/3] w-3/4 max-w-full items-center justify-center rounded-lg bg-gradient-to-br from-yellow-100 via-yellow-300 to-amber-500 text-center text-xs font-bold text-amber-950">
                🖼️ {media.kind === "set" ? media.file.name : message.media?.fileName}
              </div>
            )}
            <div className="ml-auto max-w-[95%] whitespace-pre-wrap break-words rounded-lg rounded-tr-sm bg-[#d9fdd3] px-2.5 py-1.5 text-[12.5px] text-[#111b21] shadow-sm dark:bg-[#005c4b] dark:text-[#e9edef]">
              {renderWhatsAppFormatting(`*${AGENT_EXAMPLE.displayName}:*\n\n${preview}`)}
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
