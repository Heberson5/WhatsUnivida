import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { CheckCircle2, CircleAlert, CircleX, Info, Play } from "lucide-react";
import type {
  AiAssistantSimulationDTO,
  AiAssistantSimulationWhen,
} from "@whatsatendende/types";
import { api, getApiErrorMessage } from "../../lib/api";

const inputClass =
  "focus-ring w-full rounded-card border border-border bg-transparent px-3 py-2 text-sm";

const STEP_ICON = {
  ok: (
    <CheckCircle2
      className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600"
      aria-label="ok"
    />
  ),
  warn: (
    <CircleAlert
      className="mt-0.5 h-4 w-4 shrink-0 text-warning"
      aria-label="atenção"
    />
  ),
  stop: (
    <CircleX
      className="mt-0.5 h-4 w-4 shrink-0 text-red-600"
      aria-label="para aqui"
    />
  ),
  info: (
    <Info
      className="mt-0.5 h-4 w-4 shrink-0 text-muted"
      aria-label="informação"
    />
  ),
};

/**
 * Simular atendimento: the administrator writes as a customer would and sees what the assistant would do, step by
 * step, and why it would pass to the team — nothing is sent to WhatsApp and no conversation is opened.
 */
export function AssistenteSimulador() {
  const { data: connections } = useQuery({
    queryKey: ["whatsapp-connections"],
    queryFn: async () =>
      (await api.get<{ id: string; name: string }[]>("/whatsapp/connections"))
        .data,
  });
  const [connectionId, setConnectionId] = useState("");
  const [message, setMessage] = useState("Quero o boleto");
  const [cpf, setCpf] = useState("");
  const [when, setWhen] = useState<AiAssistantSimulationWhen>("now");
  const chosen = connectionId || connections?.[0]?.id || "";

  const run = useMutation({
    mutationFn: async () =>
      (
        await api.post<AiAssistantSimulationDTO>(
          "/settings/ai-assistant/simulate",
          { connectionId: chosen, message, cpf: cpf.trim() || null, when },
        )
      ).data,
    onError: (err) => toast.error(getApiErrorMessage(err)),
  });

  return (
    <div className="shadow-soft rounded-card border border-border bg-surface p-6">
      <h2 className="text-base font-semibold">Simular atendimento</h2>
      <p className="mt-1 text-sm text-muted">
        Escreva como o cliente escreveria e veja o que o assistente faria, passo
        a passo, e por que passaria para a equipe. Nada é enviado pelo WhatsApp
        e nenhuma conversa é aberta.
      </p>
      <div className="mt-4 grid gap-3 md:grid-cols-2">
        <label className="block">
          <span className="mb-1 block text-sm font-medium">Conexão</span>
          <select
            value={chosen}
            onChange={(e) => setConnectionId(e.target.value)}
            className={inputClass}
          >
            {connections?.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </label>
        <label className="block">
          <span className="mb-1 block text-sm font-medium">Como se fosse</span>
          <select
            value={when}
            onChange={(e) =>
              setWhen(e.target.value as AiAssistantSimulationWhen)
            }
            className={inputClass}
          >
            <option value="now">Agora</option>
            <option value="open">Dentro do expediente</option>
            <option value="closed">Fora do expediente ou feriado</option>
          </select>
        </label>
        <label className="block">
          <span className="mb-1 block text-sm font-medium">
            Mensagem do cliente
          </span>
          <input
            value={message}
            maxLength={1000}
            onChange={(e) => setMessage(e.target.value)}
            className={inputClass}
          />
        </label>
        <label className="block">
          <span className="mb-1 block text-sm font-medium">
            CPF do titular (opcional)
          </span>
          <input
            value={cpf}
            maxLength={30}
            onChange={(e) => setCpf(e.target.value)}
            placeholder="000.000.000-00"
            className={inputClass}
          />
        </label>
      </div>
      <button
        onClick={() => run.mutate()}
        disabled={run.isPending || !chosen || !message.trim()}
        className="focus-ring mt-4 inline-flex items-center gap-2 rounded-card bg-primary px-4 py-2 text-sm font-semibold text-primary-fg disabled:opacity-60"
      >
        <Play className="h-4 w-4" /> {run.isPending ? "Simulando…" : "Simular"}
      </button>

      {run.data && (
        <div className="mt-4 space-y-3">
          <ol className="space-y-2 rounded-card border border-border p-3">
            {run.data.steps.map((step, i) => (
              <li key={i} className="flex items-start gap-2 text-sm">
                {STEP_ICON[step.status]}
                <span>
                  <span className="font-medium">{step.title}:</span>{" "}
                  <span className="whitespace-pre-line">{step.detail}</span>
                </span>
              </li>
            ))}
          </ol>
          <p className="rounded-card bg-surface-alt p-3 text-sm">
            <span className="font-semibold">O assistente: </span>
            {run.data.outcome}
          </p>
        </div>
      )}
    </div>
  );
}
