import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { format } from "date-fns";
import { toast } from "sonner";
import clsx from "clsx";
import { CheckCircle2, Image as ImageIcon, Pencil, Send } from "lucide-react";
import type { BirthdayPersonDTO, ConversationBirthdayDTO } from "@whatsatendende/types";
import { api, getApiErrorMessage } from "../../lib/api";
import { useClientData } from "../../hooks/useClientData";

export const birthdayKey = (conversationId: string) => ["birthday", conversationId];

export function useConversationBirthday(conversationId: string) {
  return useQuery({
    queryKey: birthdayKey(conversationId),
    queryFn: async () => (await api.get<ConversationBirthdayDTO>(`/conversations/${conversationId}/birthday`)).data,
    staleTime: 5 * 60_000,
  });
}

const CONFETTI_COLORS = ["#ffe450", "#ff8fab", "#7dd3fc", "#a7f3d0", "#c4b5fd", "#fdba74"];

async function mediaFile(person: BirthdayPersonDTO): Promise<File | undefined> {
  if (!person.media) return undefined;
  const { data } = await api.get<Blob>(person.media.url, { responseType: "blob" });
  return new File([data], person.media.fileName, { type: person.media.mimeType });
}

/**
 * Hoje é aniversário! — once per conversation, when the attendant takes it (after the suspension warning, if any):
 * who of the client's contracts has a birthday, the age, and the message of Respostas › Aniversários ready to go.
 */
export function BirthdayModal({
  conversationId,
  onSend,
  onEdit,
}: {
  conversationId: string;
  /** Sends exactly like the composer (text, or the card with the text as its caption). */
  onSend: (text: string, file?: File) => Promise<void>;
  /** "Editar antes": the text (and the card) go to the composer to adjust. */
  onEdit: (text: string, file?: File) => void;
}) {
  const queryClient = useQueryClient();
  const { data } = useConversationBirthday(conversationId);
  const { data: clientData } = useClientData(conversationId);
  const [selected, setSelected] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const people = useMemo(() => data?.people ?? [], [data]);
  const person = people.find((p) => p.key === selected) ?? people.find((p) => !p.greeted) ?? people[0];

  useEffect(() => {
    if (!selected && person) setSelected(person.key);
  }, [person, selected]);

  const refresh = () => queryClient.invalidateQueries({ queryKey: birthdayKey(conversationId) });
  const ackMutation = useMutation({ mutationFn: () => api.post(`/conversations/${conversationId}/birthday/ack`), onSuccess: refresh });

  // The suspension warning goes first; the birthday waits until it was seen.
  if (!data?.pending || !person || clientData?.suspensionWarningPending) return null;

  async function send() {
    if (!person?.text) return;
    setSending(true);
    try {
      await onSend(person.text, await mediaFile(person));
      await api.post(`/conversations/${conversationId}/birthday/greeted`, { personKey: person.key });
      toast.success(`Parabéns enviado para ${person.firstName}! 🎉`);
      refresh();
    } catch (err) {
      toast.error(getApiErrorMessage(err));
    } finally {
      setSending(false);
    }
  }

  async function edit() {
    if (!person?.text) return;
    onEdit(person.text, await mediaFile(person).catch(() => undefined));
    ackMutation.mutate();
  }

  const allGreeted = people.every((p) => p.greeted);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/45 px-4" role="dialog" aria-modal="true" aria-labelledby="birthday-title">
      <div className="chat-pop w-full max-w-md overflow-hidden rounded-[20px] border border-border bg-surface shadow-elevated">
        <div
          className="relative overflow-hidden px-6 pb-4 pt-6 text-center"
          style={{ background: "radial-gradient(120% 90% at 50% 0%, color-mix(in srgb, var(--color-secondary) 55%, var(--color-surface)) 0%, color-mix(in srgb, var(--color-primary) 18%, var(--color-surface)) 60%, var(--color-surface) 100%)" }}
        >
          <div className="bday-confetti pointer-events-none absolute inset-0" aria-hidden>
            {CONFETTI_COLORS.concat(CONFETTI_COLORS).map((color, i) => (
              <i key={i} style={{ left: `${6 + i * 8}%`, background: color, animationDelay: `${(i % 6) * 0.35}s` }} />
            ))}
          </div>
          <div className="bday-cake mx-auto mb-2.5 flex h-16 w-16 items-center justify-center rounded-[22px] bg-surface text-4xl shadow-lg">🎂</div>
          <h2 id="birthday-title" className="text-xl font-extrabold">
            {people.length > 1 ? "Aniversários hoje!" : "Hoje é aniversário!"}
          </h2>
          <p className="mt-0.5 text-sm text-muted">{allGreeted ? "Já foi parabenizado este ano." : "Que tal mandar os parabéns antes de começar?"}</p>
        </div>

        <div className="space-y-3 px-5 pb-5 pt-4">
          {people.map((p) => (
            <button
              key={p.key}
              type="button"
              onClick={() => setSelected(p.key)}
              className={clsx("flex w-full items-center gap-3 rounded-2xl border px-3 py-2.5 text-left", p.key === person.key ? "border-primary bg-primary/[0.07]" : "border-border hover:bg-surface-alt")}
            >
              <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-secondary/40 text-lg">{p.holder ? "🎉" : "💐"}</span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-bold">{p.name}</span>
                <span className="block text-xs text-muted">
                  {p.holder ? "Titular" : `Beneficiário · ${p.relation ?? "—"}`}
                  {p.contract ? ` · contrato ${p.contract}` : ""}
                </span>
                {p.greeted && (
                  <span className="mt-0.5 flex items-center gap-1 text-[11px] font-semibold text-success">
                    <CheckCircle2 className="h-3 w-3" /> Parabenizado por {p.greeted.byName} às {format(new Date(p.greeted.at), "HH:mm")}
                  </span>
                )}
              </span>
              <span className="text-center leading-none">
                <b className="block text-2xl font-extrabold tabular-nums text-primary">{p.age}</b>
                <span className="text-[10px] font-bold uppercase tracking-wider text-muted">anos</span>
              </span>
            </button>
          ))}

          {person.text ? (
            <div className="space-y-1.5 rounded-2xl bg-primary/[0.06] p-3">
              <p className="flex items-center justify-between text-[10.5px] font-bold uppercase tracking-wider text-muted">
                <span>Mensagem para {person.holder ? "o cliente" : "o beneficiário"}</span>
                {person.media && (
                  <span className="flex items-center gap-1 normal-case tracking-normal">
                    <ImageIcon className="h-3 w-3" /> com cartão
                  </span>
                )}
              </p>
              <p className="max-h-44 overflow-y-auto whitespace-pre-line rounded-xl rounded-tr-sm bg-surface px-3 py-2 text-sm shadow-sm">{person.text}</p>
            </div>
          ) : (
            <p className="rounded-xl bg-surface-alt px-3 py-2 text-xs text-muted">A mensagem de aniversário para {person.holder ? "o cliente" : "o beneficiário"} está desligada em Respostas › Aniversários.</p>
          )}

          <div className="grid grid-cols-2 gap-2">
            {person.text && (
              <button
                autoFocus
                onClick={send}
                disabled={sending}
                className="focus-ring col-span-2 inline-flex items-center justify-center gap-2 rounded-card bg-primary py-3 text-sm font-bold text-primary-fg shadow-md disabled:opacity-60"
              >
                <Send className="h-4 w-4" />
                {person.greeted ? `Enviar de novo para ${person.firstName}` : `Enviar parabéns para ${person.firstName}`}
              </button>
            )}
            {person.text && (
              <button onClick={edit} className="focus-ring inline-flex items-center justify-center gap-2 rounded-card border border-border py-2 text-sm font-semibold hover:bg-surface-alt">
                <Pencil className="h-4 w-4" /> Editar antes
              </button>
            )}
            <button onClick={() => ackMutation.mutate()} className={clsx("focus-ring rounded-card py-2 text-sm font-semibold text-muted hover:bg-surface-alt", !person.text && "col-span-2")}>
              {allGreeted ? "Entendi" : "Agora não"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
