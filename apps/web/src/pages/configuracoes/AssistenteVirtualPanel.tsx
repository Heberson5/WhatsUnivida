import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Bot, CheckCircle2, CircleDashed, TriangleAlert } from "lucide-react";
import {
  AI_ASSISTANT_NAME_MAX,
  AI_ASSISTANT_TEXT_MAX,
  DEFAULT_AI_ASSISTANT_SETTINGS,
  aiAssistantReply,
  type AiAssistantSettingsDTO,
  type AiAssistantStatusDTO,
} from "@whatsatendende/types";
import { api, getApiErrorMessage } from "../../lib/api";
import { AssistenteDadosClientes } from "./AssistenteDadosClientes";
import { AssistenteSimulador } from "./AssistenteSimulador";

const inputClass = "focus-ring w-full rounded-card border border-border bg-transparent px-3 py-2 text-sm";

interface ConnectionOption {
  id: string;
  name: string;
}

/** One phone per line or separated by comma — kept as typed while editing, digits only when saved. */
function parsePhones(text: string): string[] {
  return text
    .split(/[\n,;]+/)
    .map((p) => p.replace(/\D/g, ""))
    .filter(Boolean);
}

/**
 * Configurações › Assistente Virtual: the local AI (on the VPS itself, no cost per message) that answers customers
 * before the queue. Administrador only. Off until switched on here; Modo teste limits it to the phones listed.
 */
export function AssistenteVirtualPanel() {
  const queryClient = useQueryClient();
  const { data } = useQuery({ queryKey: ["ai-assistant-settings"], queryFn: async () => (await api.get<AiAssistantSettingsDTO>("/settings/ai-assistant")).data });
  const { data: status, isFetching: checking, refetch: recheck } = useQuery({
    queryKey: ["ai-assistant-status"],
    queryFn: async () => (await api.get<AiAssistantStatusDTO>("/settings/ai-assistant/status")).data,
  });
  const { data: connections } = useQuery({
    queryKey: ["whatsapp-connections"],
    queryFn: async () => (await api.get<ConnectionOption[]>("/whatsapp/connections")).data,
  });

  const [form, setForm] = useState<AiAssistantSettingsDTO>(DEFAULT_AI_ASSISTANT_SETTINGS);
  const [phones, setPhones] = useState("");

  useEffect(() => {
    if (!data) return;
    setForm(data);
    setPhones(data.testPhones.join("\n"));
  }, [data]);

  const save = useMutation({
    mutationFn: async () => (await api.put<AiAssistantSettingsDTO>("/settings/ai-assistant", { ...form, testPhones: parsePhones(phones) })).data,
    onSuccess: (saved) => {
      queryClient.setQueryData(["ai-assistant-settings"], saved);
      toast.success("Assistente Virtual salvo.");
    },
    onError: (err) => toast.error(getApiErrorMessage(err)),
  });

  const toggleConnection = (id: string) =>
    setForm((f) => ({ ...f, connectionIds: f.connectionIds.includes(id) ? f.connectionIds.filter((c) => c !== id) : [...f.connectionIds, id] }));

  const noPhones = form.testMode && parsePhones(phones).length === 0;

  return (
    <div className="space-y-6">
      <div className="shadow-soft grid gap-6 rounded-card border border-border bg-surface p-6 lg:grid-cols-[1fr_320px]">
        <div className="space-y-4">
          <div>
            <h2 className="flex items-center gap-2 text-base font-semibold">
              <Bot className="h-4 w-4 text-primary" /> Assistente Virtual
            </h2>
            <p className="mt-1 text-sm text-muted">
              Uma IA que roda no próprio servidor (sem custo por mensagem) e atende o cliente antes da fila. Quando o cliente pede um atendente, ou o assunto não é com ela, a conversa vai para a
              fila com um resumo. Toda resposta dela começa com o nome abaixo.
            </p>
          </div>

          <label className="flex items-center gap-2">
            <input type="checkbox" checked={form.enabled} onChange={(e) => setForm({ ...form, enabled: e.target.checked })} className="h-4 w-4 accent-[var(--color-primary)]" />
            <span className="text-sm font-medium">Assistente Virtual ligado</span>
          </label>

          <label className="block">
            <span className="mb-1 block text-sm font-medium">Nome que aparece nas respostas</span>
            <input value={form.name} maxLength={AI_ASSISTANT_NAME_MAX} onChange={(e) => setForm({ ...form, name: e.target.value })} className={inputClass} />
            <span className="mt-1 block whitespace-pre-line text-xs text-muted">{"O cliente vê:\n"}{aiAssistantReply(form.name, "Olá! Como posso ajudar?")}</span>
          </label>

          <fieldset>
            <legend className="mb-1 text-sm font-medium">Conexões em que o assistente atende</legend>
            {connections && connections.length > 0 ? (
              <div className="grid gap-1 sm:grid-cols-2">
                {connections.map((c) => (
                  <label key={c.id} className="flex items-center gap-2 text-sm">
                    <input type="checkbox" checked={form.connectionIds.includes(c.id)} onChange={() => toggleConnection(c.id)} className="h-4 w-4 accent-[var(--color-primary)]" />
                    {c.name}
                  </label>
                ))}
              </div>
            ) : (
              <p className="text-sm text-muted">Nenhuma conexão cadastrada.</p>
            )}
          </fieldset>

          <div className="space-y-2 rounded-card border border-border p-3">
            <label className="flex items-center gap-2">
              <input type="checkbox" checked={form.testMode} onChange={(e) => setForm({ ...form, testMode: e.target.checked })} className="h-4 w-4 accent-[var(--color-primary)]" />
              <span className="text-sm font-medium">Modo teste</span>
            </label>
            <p className="text-xs text-muted">Ligado, o assistente só atende os telefones abaixo; os outros clientes seguem como hoje (Fluxo ou fila).</p>
            {form.testMode && (
              <label className="block">
                <span className="mb-1 block text-xs font-medium">Telefones de teste (um por linha, com DDD)</span>
                <textarea rows={3} value={phones} onChange={(e) => setPhones(e.target.value)} placeholder="65 99999-9999" className={`${inputClass} font-mono text-xs`} />
                {noPhones && <span className="mt-1 block text-xs text-warning">Sem telefones de teste, o assistente não atende ninguém.</span>}
              </label>
            )}
          </div>

          <label className="block">
            <span className="mb-1 block text-sm font-medium">Saudação</span>
            <textarea rows={2} value={form.greeting} maxLength={AI_ASSISTANT_TEXT_MAX} onChange={(e) => setForm({ ...form, greeting: e.target.value })} className={inputClass} />
          </label>

          <label className="block">
            <span className="mb-1 block text-sm font-medium">Ao passar para um atendente (dentro do expediente)</span>
            <textarea rows={2} value={form.transferMessage} maxLength={AI_ASSISTANT_TEXT_MAX} onChange={(e) => setForm({ ...form, transferMessage: e.target.value })} className={inputClass} />
            <span className="mt-1 block text-xs text-muted">Fora do expediente, vai a mensagem de fora do expediente da conexão (Respostas › Horário de expediente) e o assistente para de responder.</span>
          </label>

          <div className="space-y-1 rounded-card border border-border p-3">
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={form.agentTranscription}
                onChange={(e) => setForm({ ...form, agentTranscription: e.target.checked })}
                className="h-4 w-4 accent-[var(--color-primary)]"
              />
              <span className="text-sm font-medium">Botão Transcrever nos áudios para os atendentes</span>
            </label>
            <p className="text-xs text-muted">
              Ligado, cada áudio do cliente ganha o botão Transcrever no atendimento. Desligado, os áudios só são transcritos enquanto o assistente estiver atendendo. A transcrição roda no
              servidor e leva de 20 segundos a 1 minuto por minuto de áudio.
            </p>
          </div>

          <div className="border-t border-border pt-4">
            <button onClick={() => save.mutate()} disabled={save.isPending} className="focus-ring rounded-card bg-primary px-4 py-2 text-sm font-semibold text-primary-fg disabled:opacity-60">
              Salvar
            </button>
          </div>
        </div>

        <aside className="space-y-3">
          <div className="rounded-card border border-border p-4">
            <p className="text-sm font-semibold">Situação da IA no servidor</p>
            {!status ? (
              <p className="mt-2 text-sm text-muted">Verificando…</p>
            ) : status.reachable && status.modelReady ? (
              <p className="mt-2 flex items-start gap-2 text-sm text-emerald-700 dark:text-emerald-300">
                <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" /> Pronta — modelo {status.model}.
              </p>
            ) : status.reachable ? (
              <p className="mt-2 flex items-start gap-2 text-sm text-warning">
                <CircleDashed className="mt-0.5 h-4 w-4 shrink-0" /> Serviço no ar, baixando o modelo {status.model}. Pode levar alguns minutos depois de uma atualização.
              </p>
            ) : (
              <p className="mt-2 flex items-start gap-2 text-sm text-red-600">
                <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" /> {status.error ?? "A IA não está acessível."} Enquanto isso, as conversas seguem o caminho normal.
              </p>
            )}
            <button onClick={() => void recheck()} disabled={checking} className="focus-ring mt-3 rounded-card border border-border px-3 py-1.5 text-xs font-medium hover:bg-surface-alt disabled:opacity-60">
              {checking ? "Verificando…" : "Verificar de novo"}
            </button>
          </div>
          <div className="rounded-card border border-border p-4">
            <p className="text-sm font-semibold">Transcrição de áudio</p>
            {!status ? (
              <p className="mt-2 text-sm text-muted">Verificando…</p>
            ) : status.transcriptionReady ? (
              <p className="mt-2 flex items-start gap-2 text-sm text-emerald-700 dark:text-emerald-300">
                <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" /> Pronta — {status.transcriptionModel}.
              </p>
            ) : (
              <p className="mt-2 flex items-start gap-2 text-sm text-warning">
                <CircleDashed className="mt-0.5 h-4 w-4 shrink-0" /> Ainda não está pronta (na primeira vez o modelo {status.transcriptionModel} é baixado). Enquanto isso, um áudio do cliente vai para a fila.
              </p>
            )}
          </div>
          <AssistenteDadosClientes />
          <p className="px-1 text-xs text-muted">O assistente só responde a um áudio depois de transcrevê-lo. Tudo roda no servidor: nada é enviado para serviços externos.</p>
        </aside>
      </div>
      <AssistenteSimulador />
    </div>
  );
}
