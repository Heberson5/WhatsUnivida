import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { MessageSquareOff } from "lucide-react";
import { toast } from "sonner";
import type { NoReturnSettingsDTO } from "@whatsatendende/types";
import { api, getApiErrorMessage } from "../../lib/api";
import { TagButtons, insertTag } from "../dados/TagButtons";

const MESSAGE_TAGS = ["{{saudacao}}", "{{primeiro_nome}}", "{{cliente}}", "{{atendente}}"] as const;

const MAX_MINUTES = 240;

/**
 * Respostas › Encerramento › Encerramento por falta de retorno: the automatic mode (reminder after X minutes of
 * silence, close Y minutes later — counted only within expediente) and the two texts, also used by "Encerrar por
 * falta de retorno" in the Encerrar dialog.
 */
export function NoReturnSettingsCard({ canEdit }: { canEdit: boolean }) {
  const queryClient = useQueryClient();
  const { data } = useQuery({
    queryKey: ["no-return-settings"],
    queryFn: async () => (await api.get<NoReturnSettingsDTO>("/settings/no-return")).data,
  });
  const [form, setForm] = useState<NoReturnSettingsDTO | null>(null);
  const [reminderEl, setReminderEl] = useState<HTMLTextAreaElement | null>(null);
  const [closeEl, setCloseEl] = useState<HTMLTextAreaElement | null>(null);
  useEffect(() => {
    if (data) setForm(data);
  }, [data]);

  const save = useMutation({
    mutationFn: async (values: NoReturnSettingsDTO) => (await api.put<NoReturnSettingsDTO>("/settings/no-return", values)).data,
    onSuccess: (saved) => {
      queryClient.setQueryData(["no-return-settings"], saved);
      toast.success("Encerramento por falta de retorno salvo.");
    },
    onError: (err) => toast.error(getApiErrorMessage(err)),
  });

  if (!form || !data) return null;
  const minutesValid = (n: number) => Number.isInteger(n) && n >= 1 && n <= MAX_MINUTES;
  const invalid = !minutesValid(form.reminderMinutes) || !minutesValid(form.closeMinutes) || !form.reminderText.trim() || !form.closeText.trim();
  const dirty = JSON.stringify(form) !== JSON.stringify(data);
  const set = <K extends keyof NoReturnSettingsDTO>(key: K, value: NoReturnSettingsDTO[K]) => setForm({ ...form, [key]: value });

  return (
    <section className="shadow-soft mb-4 rounded-card border border-border bg-surface p-4" aria-label="Encerramento por falta de retorno">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="flex items-center gap-2 text-sm font-semibold">
            <MessageSquareOff className="h-4 w-4 text-primary" /> Encerramento por falta de retorno
          </h3>
          <p className="mt-1 text-xs text-muted">
            Conta na meta do atendente e aparece à parte como "Sem retorno do cliente". O tempo só corre dentro do horário de expediente da
            conexão. As mensagens saem sem o nome do atendente.
          </p>
        </div>
        <label className="flex cursor-pointer items-center gap-2 text-sm font-medium">
          <input type="checkbox" checked={form.enabled} disabled={!canEdit} onChange={(e) => set("enabled", e.target.checked)} className="h-4 w-4 accent-primary" />
          Encerrar automaticamente
        </label>
      </div>

      <div className="mt-3 grid gap-4 md:grid-cols-2">
        <label className="block">
          <span className="mb-1 block text-sm font-medium">Lembrete após (minutos sem resposta do cliente)</span>
          <input
            type="number"
            min={1}
            max={MAX_MINUTES}
            value={form.reminderMinutes}
            disabled={!canEdit}
            onChange={(e) => set("reminderMinutes", Number(e.target.value))}
            className="focus-ring w-28 rounded-card border border-border bg-transparent px-3 py-2 text-sm disabled:opacity-60"
          />
        </label>
        <label className="block">
          <span className="mb-1 block text-sm font-medium">Encerrar após o lembrete (minutos)</span>
          <input
            type="number"
            min={1}
            max={MAX_MINUTES}
            value={form.closeMinutes}
            disabled={!canEdit}
            onChange={(e) => set("closeMinutes", Number(e.target.value))}
            className="focus-ring w-28 rounded-card border border-border bg-transparent px-3 py-2 text-sm disabled:opacity-60"
          />
        </label>
        <label className="block">
          <span className="mb-1 block text-sm font-medium">Mensagem de lembrete</span>
          <textarea
            rows={3}
            maxLength={1000}
            value={form.reminderText}
            ref={setReminderEl}
            disabled={!canEdit}
            onChange={(e) => set("reminderText", e.target.value)}
            className="focus-ring w-full rounded-card border border-border bg-transparent px-3 py-2 text-sm disabled:opacity-60"
          />
          {canEdit && <TagButtons tags={MESSAGE_TAGS} onInsert={(tag) => insertTag(reminderEl, form.reminderText, tag, (text) => set("reminderText", text))} />}
        </label>
        <label className="block">
          <span className="mb-1 block text-sm font-medium">Mensagem de encerramento</span>
          <textarea
            rows={3}
            maxLength={1000}
            value={form.closeText}
            ref={setCloseEl}
            disabled={!canEdit}
            onChange={(e) => set("closeText", e.target.value)}
            className="focus-ring w-full rounded-card border border-border bg-transparent px-3 py-2 text-sm disabled:opacity-60"
          />
          {canEdit && <TagButtons tags={MESSAGE_TAGS} onInsert={(tag) => insertTag(closeEl, form.closeText, tag, (text) => set("closeText", text))} />}
        </label>
      </div>
      <label className="mt-3 flex cursor-pointer items-start gap-2 text-sm">
        <input
          type="checkbox"
          checked={form.sendSurvey}
          disabled={!canEdit}
          onChange={(e) => set("sendSurvey", e.target.checked)}
          className="mt-0.5 h-4 w-4 accent-primary"
        />
        <span>
          <span className="font-medium">Enviar a pesquisa de satisfação</span>
          <span className="block text-xs text-muted">
            Ao encerrar por falta de retorno, envia a pesquisa da conexão (Respostas › Pesquisa), sem o nome do atendente. A mensagem de encerramento
            vai depois da nota do cliente, ou quando o tempo de espera da pesquisa acabar.
          </span>
        </span>
      </label>
      <p className="mt-2 text-xs text-muted">
        Use {"{{saudacao}}"}, {"{{primeiro_nome}}"}, {"{{cliente}}"} e {"{{atendente}}"} nas mensagens. Não encerra quando a última mensagem é do cliente, quando há "Lembrar de retornar" ou envio
        agendado pendente, ou quando o atendente marcou "Não encerrar automaticamente". Se o cliente voltar, a conversa vai para o mesmo atendente (se estiver online).
      </p>
      {canEdit && (
        <div className="mt-3 flex justify-end">
          <button
            onClick={() => save.mutate(form)}
            disabled={!dirty || invalid || save.isPending}
            className="focus-ring rounded-card bg-primary px-4 py-2 text-sm font-semibold text-primary-fg disabled:opacity-50"
          >
            {save.isPending ? "Salvando..." : "Salvar"}
          </button>
        </div>
      )}
    </section>
  );
}
