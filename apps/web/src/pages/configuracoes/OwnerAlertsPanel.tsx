import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { format } from "date-fns";
import { OWNER_ALERT_EVENTS, SMS_PROVIDERS, type OwnerAlertEvent, type OwnerAlertsDTO, type SmsProviderId } from "@whatsatendende/types";
import { api, getApiErrorMessage } from "../../lib/api";
import { UnsavedChangesBar } from "../../components/common/UnsavedChangesBar";

/**
 * Configurações › Avisos do administrador — the Administrador's own e-mail server and SMS provider, apart from the
 * company's (Configurações › E-mail and SMS), to be told when something needs them. Only the Administrador sees this
 * tab; the API refuses everyone else.
 */

interface Form {
  events: Record<OwnerAlertEvent, boolean>;
  email: { enabled: boolean; host: string; port: number; secure: boolean; username: string; password: string; fromName: string; fromEmail: string; recipients: string };
  sms: { enabled: boolean; provider: SmsProviderId | null; config: Record<string, string>; recipients: string };
}

const EVENT_KEYS = Object.keys(OWNER_ALERT_EVENTS) as OwnerAlertEvent[];
const splitList = (text: string) => text.split(/[\n,;]+/).map((item) => item.trim()).filter(Boolean);

function toForm(data: OwnerAlertsDTO): Form {
  return {
    events: { ...data.events },
    email: { ...data.email, password: "", recipients: data.email.recipients.join("\n") },
    sms: { enabled: data.sms.enabled, provider: data.sms.provider, config: { ...data.sms.config }, recipients: data.sms.recipients.join("\n") },
  };
}

const inputClass = "focus-ring w-full rounded-card border border-border bg-transparent px-3 py-2 text-sm";
const SAVED_SECRET = "•••••••• (salvo — deixe em branco para manter)";

export function OwnerAlertsPanel() {
  const queryClient = useQueryClient();
  const { data } = useQuery({ queryKey: ["owner-alerts"], queryFn: async () => (await api.get<OwnerAlertsDTO>("/settings/owner-alerts")).data });
  const [form, setForm] = useState<Form | null>(null);
  useEffect(() => {
    if (data) setForm(toForm(data));
  }, [data]);

  const saveMutation = useMutation({
    mutationFn: () => {
      const f = form!;
      const { password, recipients, ...email } = f.email;
      return api.put<OwnerAlertsDTO>("/settings/owner-alerts", {
        events: f.events,
        email: { ...email, port: Number(email.port), recipients: splitList(recipients), ...(password ? { password } : {}) },
        sms: { ...f.sms, recipients: splitList(f.sms.recipients) },
      });
    },
    onSuccess: (res) => {
      queryClient.setQueryData(["owner-alerts"], res.data);
      toast.success("Avisos do administrador salvos.");
    },
    onError: (err) => toast.error(getApiErrorMessage(err)),
  });

  const testMutation = useMutation({
    mutationFn: (channel: "email" | "sms") => api.post<OwnerAlertsDTO>("/settings/owner-alerts/test", { channel }),
    onSuccess: (res, channel) => {
      queryClient.setQueryData(["owner-alerts"], res.data);
      toast.success(channel === "email" ? "E-mail de teste enviado." : "SMS de teste enviado.");
    },
    onError: (err) => {
      queryClient.invalidateQueries({ queryKey: ["owner-alerts"] });
      toast.error(getApiErrorMessage(err));
    },
  });

  if (!data || !form) {
    return <div className="shadow-soft max-w-2xl rounded-card border border-border bg-surface p-6 text-sm text-muted">Carregando...</div>;
  }

  const dirty = JSON.stringify(form) !== JSON.stringify(toForm(data));
  const setEmail = (patch: Partial<Form["email"]>) => setForm({ ...form, email: { ...form.email, ...patch } });
  const setSms = (patch: Partial<Form["sms"]>) => setForm({ ...form, sms: { ...form.sms, ...patch } });
  const smsFields = form.sms.provider ? SMS_PROVIDERS[form.sms.provider].fields : [];

  return (
    <div className="shadow-soft max-w-2xl space-y-6 rounded-card border border-border bg-surface p-6">
      <div>
        <h2 className="text-base font-semibold">Avisos do administrador</h2>
        <p className="mt-1 text-sm text-muted">
          Receba um aviso quando algo no sistema precisar da sua atenção. Esta configuração é só sua: usa o seu próprio servidor de e-mail e o
          seu provedor de SMS, separados dos da empresa (Configurações › E-mail e SMS), e não aparece para Gestores nem Atendentes.
        </p>
        {data.lastError && (
          <p role="alert" className="mt-3 rounded-card bg-danger-soft px-3 py-2 text-sm text-danger">
            O último aviso por {data.lastError.channel === "email" ? "e-mail" : "SMS"} não foi entregue ({format(new Date(data.lastError.at), "dd/MM HH:mm")}): {data.lastError.message}
          </p>
        )}
        {data.lastSentAt && <p className="mt-2 text-xs text-muted">Último aviso entregue em {format(new Date(data.lastSentAt), "dd/MM/yyyy HH:mm")}.</p>}
      </div>

      <div className="border-t border-border pt-5">
        <h3 className="text-sm font-semibold">Quando avisar</h3>
        <div className="mt-3 space-y-2">
          {EVENT_KEYS.map((key) => (
            <label key={key} className="flex items-start gap-3 rounded-card border border-border px-3 py-2">
              <input
                type="checkbox"
                checked={form.events[key]}
                onChange={(e) => setForm({ ...form, events: { ...form.events, [key]: e.target.checked } })}
                className="mt-0.5 h-4 w-4 shrink-0 accent-[var(--color-primary)]"
              />
              <span>
                <span className="block text-sm font-medium">{OWNER_ALERT_EVENTS[key].label}</span>
                <span className="block text-xs text-muted">{OWNER_ALERT_EVENTS[key].description}</span>
              </span>
            </label>
          ))}
        </div>
      </div>

      <div className="border-t border-border pt-5">
        <label className="flex items-center gap-2 text-sm font-semibold">
          <input type="checkbox" checked={form.email.enabled} onChange={(e) => setEmail({ enabled: e.target.checked })} className="h-4 w-4 accent-[var(--color-primary)]" />
          Avisar por e-mail
        </label>
        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          <label className="block">
            <span className="mb-1 block text-sm font-medium">Servidor SMTP</span>
            <input value={form.email.host} onChange={(e) => setEmail({ host: e.target.value })} placeholder="smtp.seuprovedor.com" className={inputClass} />
          </label>
          <label className="block">
            <span className="mb-1 block text-sm font-medium">Porta</span>
            <input type="number" min={1} max={65535} value={form.email.port} onChange={(e) => setEmail({ port: Number(e.target.value) })} className={inputClass} />
          </label>
          <label className="block">
            <span className="mb-1 block text-sm font-medium">Usuário</span>
            <input autoComplete="off" value={form.email.username} onChange={(e) => setEmail({ username: e.target.value })} className={inputClass} />
          </label>
          <label className="block">
            <span className="mb-1 block text-sm font-medium">Senha</span>
            <input type="password" autoComplete="new-password" value={form.email.password} onChange={(e) => setEmail({ password: e.target.value })} placeholder={data.email.hasPassword ? SAVED_SECRET : ""} className={inputClass} />
          </label>
          <label className="block">
            <span className="mb-1 block text-sm font-medium">Nome do remetente</span>
            <input value={form.email.fromName} onChange={(e) => setEmail({ fromName: e.target.value })} className={inputClass} />
          </label>
          <label className="block">
            <span className="mb-1 block text-sm font-medium">E-mail do remetente</span>
            <input type="email" value={form.email.fromEmail} onChange={(e) => setEmail({ fromEmail: e.target.value })} className={inputClass} />
          </label>
          <label className="flex items-center gap-2 text-sm sm:col-span-2">
            <input type="checkbox" checked={form.email.secure} onChange={(e) => setEmail({ secure: e.target.checked })} className="h-4 w-4 accent-[var(--color-primary)]" />
            Conexão segura (SSL/TLS direto — normalmente na porta 465)
          </label>
          <label className="block sm:col-span-2">
            <span className="mb-1 block text-sm font-medium">Quem recebe (um e-mail por linha)</span>
            <textarea rows={2} value={form.email.recipients} onChange={(e) => setEmail({ recipients: e.target.value })} placeholder="voce@seudominio.com" className={inputClass} />
          </label>
        </div>
        <button
          type="button"
          onClick={() => testMutation.mutate("email")}
          disabled={dirty || testMutation.isPending}
          title={dirty ? "Salve antes de testar" : undefined}
          className="focus-ring mt-3 rounded-card border border-border px-3 py-1.5 text-sm font-semibold hover:bg-surface-alt disabled:opacity-60"
        >
          Enviar e-mail de teste
        </button>
      </div>

      <div className="border-t border-border pt-5">
        <label className="flex items-center gap-2 text-sm font-semibold">
          <input type="checkbox" checked={form.sms.enabled} onChange={(e) => setSms({ enabled: e.target.checked })} className="h-4 w-4 accent-[var(--color-primary)]" />
          Avisar por SMS
        </label>
        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          <label className="block sm:col-span-2">
            <span className="mb-1 block text-sm font-medium">Provedor</span>
            <select value={form.sms.provider ?? ""} onChange={(e) => setSms({ provider: (e.target.value || null) as SmsProviderId | null, config: {} })} className={inputClass}>
              <option value="">Escolha o provedor...</option>
              {(Object.keys(SMS_PROVIDERS) as SmsProviderId[]).map((id) => (
                <option key={id} value={id}>
                  {SMS_PROVIDERS[id].label}
                </option>
              ))}
            </select>
          </label>
          {smsFields.map((f) => {
            const saved = f.secret && form.sms.provider === data.sms.provider && data.sms.secretsSet[f.key];
            return (
              <label key={f.key} className="block">
                <span className="mb-1 block text-sm font-medium">{f.label}</span>
                {f.options ? (
                  <select value={form.sms.config[f.key] ?? f.options[0].value} onChange={(e) => setSms({ config: { ...form.sms.config, [f.key]: e.target.value } })} className={inputClass}>
                    {f.options.map((o) => (
                      <option key={o.value} value={o.value}>
                        {o.label}
                      </option>
                    ))}
                  </select>
                ) : f.multiline ? (
                  <textarea rows={3} value={form.sms.config[f.key] ?? ""} onChange={(e) => setSms({ config: { ...form.sms.config, [f.key]: e.target.value } })} placeholder={saved ? SAVED_SECRET : f.placeholder} className={`${inputClass} font-mono text-xs`} />
                ) : (
                  <input
                    type={f.secret ? "password" : "text"}
                    autoComplete="off"
                    value={form.sms.config[f.key] ?? ""}
                    onChange={(e) => setSms({ config: { ...form.sms.config, [f.key]: e.target.value } })}
                    placeholder={saved ? SAVED_SECRET : f.placeholder}
                    className={inputClass}
                  />
                )}
                {f.help && <span className="mt-1 block text-xs text-muted">{f.help}</span>}
              </label>
            );
          })}
          <label className="block sm:col-span-2">
            <span className="mb-1 block text-sm font-medium">Celulares que recebem (um por linha, com DDD)</span>
            <textarea rows={2} value={form.sms.recipients} onChange={(e) => setSms({ recipients: e.target.value })} placeholder="(65) 99999-0000" className={inputClass} />
          </label>
        </div>
        <button
          type="button"
          onClick={() => testMutation.mutate("sms")}
          disabled={dirty || testMutation.isPending}
          title={dirty ? "Salve antes de testar" : undefined}
          className="focus-ring mt-3 rounded-card border border-border px-3 py-1.5 text-sm font-semibold hover:bg-surface-alt disabled:opacity-60"
        >
          Enviar SMS de teste
        </button>
      </div>

      <button onClick={() => saveMutation.mutate()} disabled={!dirty || saveMutation.isPending} className="focus-ring rounded-card bg-primary px-4 py-2 text-sm font-semibold text-primary-fg disabled:opacity-60">
        Salvar configuração
      </button>
      <UnsavedChangesBar dirty={dirty} saving={saveMutation.isPending} onSave={() => saveMutation.mutate()} onDiscard={() => setForm(toForm(data))} />
    </div>
  );
}
