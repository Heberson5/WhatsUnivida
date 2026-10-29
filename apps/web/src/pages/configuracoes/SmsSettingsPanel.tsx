import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { CheckCircle2, MessageSquareText, Send, TriangleAlert } from "lucide-react";
import { PERMISSION, SMS_PROVIDERS, type SmsProviderId, type SmsSettingsDTO } from "@whatsatendende/types";
import { useAuthStore } from "../../store/auth-store";
import { api, getApiErrorMessage } from "../../lib/api";

const inputClass = "focus-ring w-full rounded-card border border-border bg-transparent px-3 py-2 text-sm";

/**
 * Configurações › SMS: the provider that sends the SMS alerts (for now, the failure alert of the scheduled
 * presentation). Any provider below, or "HTTP genérico" for one with its own API. The SMS option only shows up in the
 * alerts after a test SMS goes through.
 */
export function SmsSettingsPanel() {
  const canEdit = useAuthStore((s) => Boolean(s.permissions?.[PERMISSION.CONFIGURACOES_SMS_EDITAR]));
  const queryClient = useQueryClient();
  const { data } = useQuery({ queryKey: ["sms-settings"], queryFn: async () => (await api.get<SmsSettingsDTO>("/settings/sms")).data });

  const [enabled, setEnabled] = useState(false);
  const [provider, setProvider] = useState<SmsProviderId | null>(null);
  const [config, setConfig] = useState<Record<string, string>>({});
  const [testPhone, setTestPhone] = useState("");

  useEffect(() => {
    if (!data) return;
    setEnabled(data.enabled);
    setProvider(data.provider);
    setConfig(data.config);
  }, [data]);

  const onSaved = (next: SmsSettingsDTO) => {
    queryClient.setQueryData(["sms-settings"], next);
    queryClient.invalidateQueries({ queryKey: ["sms-availability"] });
  };
  const save = useMutation({
    mutationFn: async () => (await api.put<SmsSettingsDTO>("/settings/sms", { enabled, provider, config })).data,
    onSuccess: (next) => {
      onSaved(next);
      toast.success("SMS salvo. Envie um SMS de teste para liberar os alertas por SMS.");
    },
    onError: (err) => toast.error(getApiErrorMessage(err)),
  });
  const test = useMutation({
    mutationFn: async () => {
      await api.put<SmsSettingsDTO>("/settings/sms", { enabled, provider, config });
      return (await api.post<SmsSettingsDTO>("/settings/sms/test", { phone: testPhone })).data;
    },
    onSuccess: (next) => {
      onSaved(next);
      toast.success(`SMS de teste enviado para ${testPhone}.`);
    },
    onError: (err) => {
      queryClient.invalidateQueries({ queryKey: ["sms-settings"] });
      toast.error(getApiErrorMessage(err, "O SMS de teste não foi enviado"));
    },
  });

  const fields = provider ? SMS_PROVIDERS[provider].fields : [];

  return (
    <div className="shadow-soft grid gap-6 rounded-card border border-border bg-surface p-6 lg:grid-cols-[1fr_320px]">
      <div className="space-y-4">
        <div>
          <h2 className="flex items-center gap-2 text-base font-semibold">
            <MessageSquareText className="h-4 w-4 text-primary" /> SMS
          </h2>
          <p className="mt-1 text-sm text-muted">
            O provedor que envia os alertas por SMS — por enquanto, o aviso de falha do Agendamento da apresentação. Escolha o seu provedor e preencha os dados da conta; para um que não está na
            lista, use "Outro provedor (HTTP genérico)".
          </p>
        </div>

        <label className="flex items-center gap-2">
          <input type="checkbox" checked={enabled} disabled={!canEdit} onChange={(e) => setEnabled(e.target.checked)} />
          <span className="text-sm font-medium">Usar SMS nos alertas</span>
        </label>

        <label className="block">
          <span className="mb-1 block text-sm font-medium">Provedor</span>
          <select
            value={provider ?? ""}
            disabled={!canEdit}
            onChange={(e) => {
              setProvider((e.target.value || null) as SmsProviderId | null);
              setConfig({});
            }}
            className={inputClass}
          >
            <option value="">Escolha o provedor...</option>
            {(Object.keys(SMS_PROVIDERS) as SmsProviderId[]).map((id) => (
              <option key={id} value={id}>
                {SMS_PROVIDERS[id].label}
              </option>
            ))}
          </select>
        </label>

        {fields.map((f) => (
          <label key={f.key} className="block">
            <span className="mb-1 block text-sm font-medium">{f.label}</span>
            {f.options ? (
              <select value={config[f.key] ?? f.options[0].value} disabled={!canEdit} onChange={(e) => setConfig({ ...config, [f.key]: e.target.value })} className={inputClass}>
                {f.options.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
            ) : f.multiline ? (
              <textarea
                rows={3}
                value={config[f.key] ?? ""}
                disabled={!canEdit}
                onChange={(e) => setConfig({ ...config, [f.key]: e.target.value })}
                placeholder={f.secret && data?.secretsSet[f.key] ? "•••••••• (salvo — deixe em branco para manter)" : f.placeholder}
                className={`${inputClass} font-mono text-xs`}
              />
            ) : (
              <input
                type={f.secret ? "password" : "text"}
                autoComplete="off"
                value={config[f.key] ?? ""}
                disabled={!canEdit}
                onChange={(e) => setConfig({ ...config, [f.key]: e.target.value })}
                placeholder={f.secret && data?.secretsSet[f.key] ? "•••••••• (salvo — deixe em branco para manter)" : f.placeholder}
                className={inputClass}
              />
            )}
            {f.help && <span className="mt-1 block text-xs text-muted">{f.help}</span>}
          </label>
        ))}

        {canEdit && (
          <div className="flex flex-wrap items-center gap-2 border-t border-border pt-4">
            <button onClick={() => save.mutate()} disabled={save.isPending} className="focus-ring rounded-card bg-primary px-4 py-2 text-sm font-semibold text-primary-fg disabled:opacity-60">
              Salvar
            </button>
            <input
              type="tel"
              value={testPhone}
              onChange={(e) => setTestPhone(e.target.value)}
              placeholder="Celular para o teste, com DDD"
              className="focus-ring min-w-[200px] flex-1 rounded-card border border-border bg-transparent px-3 py-2 text-sm"
            />
            <button
              onClick={() => test.mutate()}
              disabled={!provider || testPhone.replace(/\D/g, "").length < 10 || test.isPending}
              className="focus-ring flex items-center gap-1.5 rounded-card border border-border px-4 py-2 text-sm font-medium hover:bg-surface-alt disabled:opacity-60"
            >
              <Send className="h-4 w-4" /> {test.isPending ? "Enviando..." : "Enviar SMS de teste"}
            </button>
          </div>
        )}
      </div>

      <aside className="space-y-3">
        <div className="rounded-card border border-border p-4">
          <p className="text-sm font-semibold">Situação</p>
          {data?.verifiedAt && data.enabled ? (
            <p className="mt-2 flex items-start gap-2 text-sm text-emerald-700 dark:text-emerald-300">
              <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" /> Funcionando — teste enviado em {new Date(data.verifiedAt).toLocaleString("pt-BR")}. A opção "Por SMS" aparece nos alertas.
            </p>
          ) : data?.lastError ? (
            <p className="mt-2 flex items-start gap-2 text-sm text-red-600">
              <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" /> O último teste falhou: {data.lastError}
            </p>
          ) : (
            <p className="mt-2 text-sm text-muted">Ainda não testado. Salve e envie um SMS de teste: só então os alertas por SMS ficam disponíveis.</p>
          )}
        </div>
        {provider && SMS_PROVIDERS[provider].site && (
          <p className="px-1 text-xs text-muted">
            As credenciais ficam no painel do provedor ({SMS_PROVIDERS[provider].site}). Senhas e chaves são guardadas criptografadas e não voltam para esta tela.
          </p>
        )}
      </aside>
    </div>
  );
}
