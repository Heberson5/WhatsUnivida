import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  BOLETO_SEND_MESSAGE_MAX_LENGTH,
  BOLETO_SEND_MESSAGE_TAGS,
  PERMISSION,
  fillBoletoSendMessage,
  type BoletoSendMessageDTO,
} from "@whatsatendende/types";
import { api, getApiErrorMessage } from "../../lib/api";
import { useAuthStore } from "../../store/auth-store";
import { TagButtons, insertTag } from "./TagButtons";

const inputClass = "focus-ring w-full rounded-card border border-border bg-transparent px-3 py-2 text-sm";
// The examples of the previews: one boleto, and three in the same PDF.
const EXAMPLE_CLIENT = "Maria Aparecida Souza";
const EXAMPLE_ONE = [{ due: "10/11/2026", cents: 12758 }];
const EXAMPLE_THREE = [...EXAMPLE_ONE, { due: "10/12/2026", cents: 12758 }, { due: "10/01/2027", cents: 12758 }];

/**
 * Dados › Mensagem de envio: the text the attendant gets ready to send with the boleto PDF (as its caption) — the
 * plural one when several boletos go in the same file. The attendant can still change it before sending.
 */
export function BoletoSendMessagePanel() {
  const queryClient = useQueryClient();
  const canEdit = useAuthStore((s) => Boolean(s.permissions?.[PERMISSION.FONTES_DADOS_EDITAR]));
  const { data } = useQuery({ queryKey: ["boleto-send-message"], queryFn: async () => (await api.get<BoletoSendMessageDTO>("/boletos/send-message")).data });
  const [draft, setDraft] = useState<BoletoSendMessageDTO | null>(null);
  const [singleEl, setSingleEl] = useState<HTMLTextAreaElement | null>(null);
  const [pluralEl, setPluralEl] = useState<HTMLTextAreaElement | null>(null);

  useEffect(() => {
    if (data) setDraft(data);
  }, [data]);

  const saveMutation = useMutation({
    mutationFn: async (message: BoletoSendMessageDTO) => (await api.put<BoletoSendMessageDTO>("/boletos/send-message", message)).data,
    onSuccess: (saved) => {
      queryClient.setQueryData(["boleto-send-message"], saved);
      toast.success("Mensagem de envio salva.");
    },
    onError: (err) => toast.error(getApiErrorMessage(err)),
  });

  if (!draft) return null;
  const fields: { key: keyof BoletoSendMessageDTO; label: string; hint: string; el: HTMLTextAreaElement | null; setEl: (el: HTMLTextAreaElement | null) => void; example: typeof EXAMPLE_ONE }[] = [
    { key: "single", label: "Um boleto", hint: "{vencimento} e {valor} são os do boleto.", el: singleEl, setEl: setSingleEl, example: EXAMPLE_ONE },
    {
      key: "plural",
      label: "Vários boletos (no mesmo PDF)",
      hint: "{quantidade} é quantos boletos vão; {total}, a soma dos valores; {vencimento} e {valor}, os do primeiro.",
      el: pluralEl,
      setEl: setPluralEl,
      example: EXAMPLE_THREE,
    },
  ];

  return (
    <div className="shadow-soft max-w-3xl space-y-5 rounded-card border border-border bg-surface p-6">
      <div>
        <h2 className="text-base font-semibold">Mensagem de envio do boleto</h2>
        <p className="mt-1 text-sm text-muted">
          Vai como comentário do PDF quando o atendente envia boletos pelos Dados do cliente. Com mais de um boleto, o sistema usa a mensagem no plural. O atendente ainda
          pode ajustar o texto antes de enviar, e as tags <code className="rounded bg-surface-alt px-1">{"{{dados.coluna}}"}</code> também funcionam.
        </p>
      </div>
      {fields.map(({ key, label, hint, el, setEl, example }) => (
        <div key={key}>
          <label className="block">
            <span className="mb-1 block text-sm font-medium">{label}</span>
            <textarea
              ref={setEl}
              rows={3}
              value={draft[key]}
              disabled={!canEdit}
              maxLength={BOLETO_SEND_MESSAGE_MAX_LENGTH}
              onChange={(e) => setDraft({ ...draft, [key]: e.target.value })}
              className={inputClass}
            />
            <span className="mt-1 block text-xs text-muted">{hint}</span>
          </label>
          {canEdit && <TagButtons tags={BOLETO_SEND_MESSAGE_TAGS} onInsert={(tag) => insertTag(el, draft[key], tag, (text) => setDraft({ ...draft, [key]: text }))} />}
          <div className="mt-2 rounded-card border border-dashed border-border bg-surface-alt px-3 py-2 text-xs">
            <span className="font-semibold">Prévia: </span>
            {fillBoletoSendMessage(draft, { clientName: EXAMPLE_CLIENT, boletos: example })}
          </div>
        </div>
      ))}
      {canEdit && (
        <button
          type="button"
          onClick={() => saveMutation.mutate(draft)}
          disabled={saveMutation.isPending || !draft.single.trim() || !draft.plural.trim() || JSON.stringify(draft) === JSON.stringify(data)}
          className="focus-ring rounded-card bg-primary px-4 py-2 text-sm font-semibold text-primary-fg disabled:opacity-60"
        >
          Salvar mensagem
        </button>
      )}
    </div>
  );
}
