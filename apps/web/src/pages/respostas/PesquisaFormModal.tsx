import { useId, useState, type FormEvent } from "react";
import { X } from "lucide-react";
import type { SatisfactionSurveyDTO } from "@whatsatendende/types";
import { renderWhatsAppFormatting } from "../../lib/whatsappFormatting";
import { ConnectionScopePicker, toConnectionScopeValue, type ConnectionScopeValue } from "./ConnectionScopePicker";
import { TagButtons, insertTag } from "../dados/TagButtons";
import { fillCustomerTags, fillGreetingTag } from "@whatsatendende/types";
import { CLIENT_EXAMPLE_NAME } from "../../lib/auto-message-tags";

const CUSTOMER_TAGS = ["{{saudacao}}", "{{primeiro_nome}}", "{{cliente}}"] as const;

const MIN_WINDOW_HOURS = 1;
const MAX_WINDOW_HOURS = 72; // matches the backend's zod schema
const MIN_CLOSING_WAIT_MINUTES = 1;
const MAX_CLOSING_WAIT_MINUTES = 720;

export const DEFAULT_SURVEY_QUESTION =
  "Em uma escala de 0 a 10, o quanto você recomendaria o nosso atendimento a um amigo ou colega? Responda apenas com o número, sendo 0 nada provável e 10 muito provável.";

export interface PesquisaFormValues {
  name: string;
  active: boolean;
  connectionScope: ConnectionScopeValue;
  question: string;
  thanks: string;
  answerWindowHours: number;
  closingWaitMinutes: number;
}

/** The form's starting values — an existing survey, a copy of one (Duplicar), or a blank one. */
export function toPesquisaFormValues(survey: SatisfactionSurveyDTO | null, copy = false): PesquisaFormValues {
  if (!survey) {
    return {
      name: "",
      active: false,
      connectionScope: { allConnections: false, connectionIds: [] },
      question: DEFAULT_SURVEY_QUESTION,
      thanks: "Obrigado pela sua avaliação!",
      answerWindowHours: 24,
      closingWaitMinutes: 30,
    };
  }
  return {
    // A copy starts off: it only goes out once someone switches it on.
    name: copy ? `Cópia de ${survey.name}` : survey.name,
    active: copy ? false : survey.active,
    connectionScope: toConnectionScopeValue(survey.connectionScope, false),
    question: survey.question,
    thanks: survey.thanks,
    answerWindowHours: survey.answerWindowHours,
    closingWaitMinutes: survey.closingWaitMinutes,
  };
}

/**
 * One pesquisa de satisfação (NPS, nota de 0 a 10) — new, a copy or an existing one. Saved switched on, it is sent
 * when an attended conversation of its connections is closed.
 */
export function PesquisaFormModal({
  title,
  initial,
  savedQuestion,
  readOnly,
  onClose,
  onSubmit,
}: {
  title: string;
  initial: PesquisaFormValues;
  /** The question as saved — to warn that a new text starts a new question in the Dashboard. Null for a new survey. */
  savedQuestion: string | null;
  readOnly?: boolean;
  onClose: () => void;
  onSubmit: (values: PesquisaFormValues) => Promise<void>;
}) {
  const nameId = useId();
  const [values, setValues] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const set = (patch: Partial<PesquisaFormValues>) => setValues((v) => ({ ...v, ...patch }));
  const [questionEl, setQuestionEl] = useState<HTMLTextAreaElement | null>(null);

  const scopeMissing = !values.connectionScope.allConnections && values.connectionScope.connectionIds.length === 0;
  const waitInRange =
    Number.isInteger(values.closingWaitMinutes) && values.closingWaitMinutes >= MIN_CLOSING_WAIT_MINUTES && values.closingWaitMinutes <= MAX_CLOSING_WAIT_MINUTES;
  // The closing message waits inside the time the customer still has to answer.
  const waitWithinWindow = values.closingWaitMinutes <= values.answerWindowHours * 60;
  const windowInRange = Number.isInteger(values.answerWindowHours) && values.answerWindowHours >= MIN_WINDOW_HOURS && values.answerWindowHours <= MAX_WINDOW_HOURS;
  const valid =
    values.name.trim() !== "" &&
    values.question.trim() !== "" &&
    values.thanks.trim() !== "" &&
    windowInRange &&
    waitInRange &&
    waitWithinWindow &&
    !(values.active && scopeMissing);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    if (values.active && scopeMissing) {
      setError("Escolha pelo menos uma conexão ou marque todas as conexões para ligar a pesquisa.");
      return;
    }
    if (!valid) return;
    setSaving(true);
    try {
      await onSubmit({ ...values, name: values.name.trim(), question: values.question.trim(), thanks: values.thanks.trim() });
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Não foi possível salvar a pesquisa.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="drawer-backdrop">
      <form onSubmit={handleSubmit} className="drawer-panel max-w-lg overflow-y-auto p-5" aria-label={title}>
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-base font-semibold">{title}</h2>
          <button type="button" onClick={onClose} className="focus-ring rounded-full p-1 text-muted hover:bg-surface-alt" aria-label="Fechar">
            <X className="h-5 w-5" />
          </button>
        </div>

        <fieldset disabled={readOnly} className="space-y-4">
          <div>
            <label htmlFor={nameId} className="mb-1 block text-sm font-medium">
              Nome
            </label>
            <input
              id={nameId}
              required
              value={values.name}
              onChange={(e) => set({ name: e.target.value })}
              maxLength={120}
              placeholder="Ex: Pesquisa do suporte"
              aria-describedby={`${nameId}-hint`}
              className="focus-ring w-full rounded-card border border-border bg-transparent px-3 py-2 text-sm"
            />
            <p id={`${nameId}-hint`} className="mt-1 text-xs text-muted">
              Só para você encontrar a pesquisa aqui — o cliente não vê.
            </p>
          </div>

          <label className="flex items-center justify-between gap-4 rounded-card border border-border px-3 py-2">
            <span>
              <span className="block text-sm font-semibold">Enviar pesquisa ao encerrar</span>
              <span className="block text-xs text-muted">
                {values.active ? "Ligada — será enviada nas conexões escolhidas." : "Desligada — nada é enviado aos clientes."}
              </span>
            </span>
            <input type="checkbox" role="switch" checked={values.active} onChange={(e) => set({ active: e.target.checked })} className="h-5 w-5 shrink-0 accent-primary" />
          </label>

          <ConnectionScopePicker
            value={values.connectionScope}
            onChange={(connectionScope) => set({ connectionScope })}
            hint={
              values.active && scopeMissing
                ? "Escolha pelo menos uma conexão para ligar a pesquisa."
                : "Enviada em conversas dessas conexões. Uma pesquisa escolhida para a conexão tem prioridade sobre uma de todas as conexões."
            }
          />

          <label className="block">
            <span className="mb-1 block text-sm font-medium">Pergunta</span>
            <textarea
              rows={3}
              value={values.question}
              ref={setQuestionEl}
              onChange={(e) => set({ question: e.target.value })}
              maxLength={1024}
              className="focus-ring w-full resize-none rounded-card border border-border bg-transparent px-3 py-2 text-sm"
            />
            <TagButtons tags={CUSTOMER_TAGS} onInsert={(tag) => insertTag(questionEl, values.question, tag, (question) => set({ question }))} />
            <span className="mt-1 block text-xs text-muted">
              {savedQuestion !== null && values.question.trim() !== savedQuestion
                ? "Ao salvar, este texto passa a ser uma nova pergunta no Dashboard. O NPS da anterior continua no histórico."
                : "Peça uma nota de 0 a 10. Cada texto de pergunta tem o seu NPS no Dashboard."}
            </span>
          </label>

          <label className="block">
            <span className="mb-1 block text-sm font-medium">Agradecimento</span>
            <input
              value={values.thanks}
              onChange={(e) => set({ thanks: e.target.value })}
              maxLength={1024}
              className="focus-ring w-full rounded-card border border-border bg-transparent px-3 py-2 text-sm"
            />
            <span className="mt-1 block text-xs text-muted">Enviado na hora, quando o cliente responde com uma nota válida. A mensagem de encerramento vem 10 segundos depois.</span>
          </label>

          <div className="grid gap-4 sm:grid-cols-2">
            <label className="block">
              <span className="mb-1 block text-sm font-medium">Se o cliente não responder, enviar a mensagem de encerramento em (minutos)</span>
              <input
                type="number"
                min={MIN_CLOSING_WAIT_MINUTES}
                max={MAX_CLOSING_WAIT_MINUTES}
                value={values.closingWaitMinutes}
                onChange={(e) => set({ closingWaitMinutes: Number(e.target.value) })}
                aria-invalid={!waitInRange || !waitWithinWindow}
                className="focus-ring w-full rounded-card border border-border bg-transparent px-3 py-2 text-sm"
              />
              {waitInRange && !waitWithinWindow ? (
                <span className="mt-1 block text-xs text-danger" role="alert">
                  A espera não pode ser maior que o tempo para o cliente responder ({values.answerWindowHours} h).
                </span>
              ) : (
                <span className="mt-1 block text-xs text-muted">
                  {waitInRange
                    ? "Conta a partir do envio da pergunta."
                    : `Use um valor de ${MIN_CLOSING_WAIT_MINUTES} a ${MAX_CLOSING_WAIT_MINUTES} minutos.`}
                </span>
              )}
            </label>

            <label className="block">
              <span className="mb-1 block text-sm font-medium">Aceitar resposta por até (horas)</span>
              <input
                type="number"
                min={MIN_WINDOW_HOURS}
                max={MAX_WINDOW_HOURS}
                value={values.answerWindowHours}
                onChange={(e) => set({ answerWindowHours: Number(e.target.value) })}
                aria-invalid={!windowInRange}
                className="focus-ring w-full rounded-card border border-border bg-transparent px-3 py-2 text-sm"
              />
              <span className="mt-1 block text-xs text-muted">Depois disso, ou se o cliente escrever outra coisa, a mensagem abre uma conversa normal.</span>
            </label>
          </div>

          <div>
            <p className="mb-1 text-xs font-medium text-muted">Prévia de como o cliente vai receber:</p>
            <div className="max-w-sm whitespace-pre-wrap break-words rounded-card bg-primary px-3 py-2 text-sm text-primary-fg shadow-soft">
              {renderWhatsAppFormatting(fillGreetingTag(fillCustomerTags(values.question, CLIENT_EXAMPLE_NAME), new Date().getTimezoneOffset()) || "...")}
            </div>
          </div>
        </fieldset>

        {error && <p className="mt-3 rounded-card bg-danger-soft px-3 py-2 text-sm text-danger">{error}</p>}

        <div className="mt-5 flex gap-2">
          <button type="button" onClick={onClose} className="focus-ring flex-1 rounded-card border border-border py-2 text-sm">
            {readOnly ? "Fechar" : "Cancelar"}
          </button>
          {!readOnly && (
            <button type="submit" disabled={saving || !valid} className="focus-ring flex-1 rounded-card bg-primary py-2 text-sm font-semibold text-primary-fg disabled:opacity-60">
              {saving ? "Salvando..." : "Salvar"}
            </button>
          )}
        </div>
      </form>
    </div>
  );
}
