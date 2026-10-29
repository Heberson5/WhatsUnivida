import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import clsx from "clsx";
import {
  AlertTriangle,
  CalendarClock,
  CheckCircle2,
  Copy,
  Download,
  History,
  Pause,
  Pencil,
  Play,
  Plus,
  RotateCw,
  Send,
  Tag,
  Trash2,
  X,
} from "lucide-react";
import {
  PERMISSION,
  REPORT_SCHEDULE_FREQUENCY_LABEL,
  REPORT_SCHEDULE_PERIOD_LABEL,
  type ReportScheduleConflictDTO,
  type ReportScheduleDTO,
  type ReportScheduleFrequency,
  type ReportScheduleInput,
  type ReportSchedulePeriod,
  type ReportScheduleRunDTO,
  type ReportScheduleSaveResultDTO,
  type SmsAvailabilityDTO,
} from "@whatsatendende/types";
import { useAuthStore } from "../../store/auth-store";
import { api, getApiErrorMessage } from "../../lib/api";
import { downloadFile } from "../../lib/download";
import { ChipsInput } from "../../components/common/ChipsInput";
import { ConnectionFilter } from "../../components/common/ConnectionFilter";

interface ListResponse {
  schedules: ReportScheduleDTO[];
  defaults: { subject: string; title: string; bodyText: string };
  tags: { tag: string; description: string }[];
}

interface CheckResponse {
  conflicts: ReportScheduleConflictDTO[];
  externalRecipients: string[];
  upcoming: string[];
}

const WEEKDAYS = ["Dom", "Seg", "Ter", "Qua", "Qui", "Sex", "Sáb"];
const MONTHS = ["Janeiro", "Fevereiro", "Março", "Abril", "Maio", "Junho", "Julho", "Agosto", "Setembro", "Outubro", "Novembro", "Dezembro"];
const STATUS: Record<NonNullable<ReportScheduleDTO["lastStatus"]>, { label: string; className: string }> = {
  SENT: { label: "Enviado", className: "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300" },
  PARTIAL: { label: "Enviado em parte", className: "bg-amber-500/15 text-amber-700 dark:text-amber-300" },
  FAILED: { label: "Falhou", className: "bg-red-500/10 text-red-700 dark:text-red-300" },
  RETRYING: { label: "Tentando de novo", className: "bg-amber-500/15 text-amber-700 dark:text-amber-300" },
};

const inputClass = "focus-ring w-full rounded-card border border-border bg-transparent px-3 py-2 text-sm";
const labelClass = "mb-1 block text-sm font-medium";

function todayLocal(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function formatWhen(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleString("pt-BR", { weekday: "short", day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" });
}

const formatDay = (day: string) => day.split("-").reverse().join("/");

function emptyInput(defaults: ListResponse["defaults"]): ReportScheduleInput {
  return {
    name: "",
    enabled: true,
    subject: defaults.subject,
    title: defaults.title,
    bodyText: defaults.bodyText,
    to: [],
    cc: [],
    frequency: "WEEKLY",
    time: "08:00",
    tzOffsetMinutes: new Date().getTimezoneOffset(),
    startDate: todayLocal(),
    weekdays: [1],
    monthDay: null,
    month: null,
    customInterval: 1,
    customUnit: "DAY",
    endType: "NEVER",
    endAfter: null,
    endDate: null,
    skipSaturday: true,
    skipSunday: true,
    period: "AUTO",
    agentId: null,
    connectionIds: [],
    alerts: { emails: [], whatsapp: null, sms: null },
  };
}

const INPUT_KEYS = Object.keys(emptyInput({ subject: "", title: "", bodyText: "" })) as (keyof ReportScheduleInput)[];

/** Just the editable fields of a saved schedule. */
function toInput(s: ReportScheduleDTO): ReportScheduleInput {
  return Object.fromEntries(INPUT_KEYS.map((k) => [k, s[k]])) as unknown as ReportScheduleInput;
}

/** One line describing when it goes out: "Toda segunda, quarta às 08:00 · pula fim de semana e feriados". */
function describeRule(s: ReportScheduleInput): string {
  const days = (list: number[]) => (list.length ? list.map((d) => WEEKDAYS[d].toLowerCase()).join(", ") : WEEKDAYS[new Date(`${s.startDate}T12:00`).getDay()].toLowerCase());
  const monthDay = s.monthDay ?? Number(s.startDate.slice(8, 10));
  const base = {
    DAILY: "Todo dia",
    WEEKLY: `Toda semana (${days(s.weekdays)})`,
    BIWEEKLY: `A cada 15 dias (${days(s.weekdays)})`,
    MONTHLY: `Todo mês, dia ${monthDay}`,
    YEARLY: `Todo ano, ${monthDay} de ${MONTHS[(s.month ?? Number(s.startDate.slice(5, 7))) - 1].toLowerCase()}`,
    CUSTOM:
      s.customUnit === "WEEK"
        ? `A cada ${s.customInterval} semana(s) (${days(s.weekdays)})`
        : s.customUnit === "MONTH"
          ? `A cada ${s.customInterval} mês(es), dia ${monthDay}`
          : `A cada ${s.customInterval} dia(s)`,
  }[s.frequency];
  const skip = s.skipSaturday && s.skipSunday ? " · pula sábado e domingo" : s.skipSaturday ? " · pula sábado" : s.skipSunday ? " · pula domingo" : "";
  return `${base} às ${s.time}${skip}`;
}

/** Configurações › Modelos de e-mail › Agendamento da apresentação: the Dashboard's PowerPoint e-mailed on a schedule. */
export function ReportSchedulesPanel() {
  const permissions = useAuthStore((s) => s.permissions);
  const canEdit = Boolean(permissions?.[PERMISSION.CONFIGURACOES_AGENDAMENTO_EDITAR]);
  const queryClient = useQueryClient();
  const { data } = useQuery({ queryKey: ["report-schedules"], queryFn: async () => (await api.get<ListResponse>("/report-schedules")).data });
  const [editing, setEditing] = useState<{ id: string | null; input: ReportScheduleInput } | null>(null);
  const [historyOf, setHistoryOf] = useState<ReportScheduleDTO | null>(null);
  const refresh = () => queryClient.invalidateQueries({ queryKey: ["report-schedules"] });

  const toggle = useMutation({
    mutationFn: (s: ReportScheduleDTO) => api.post(`/report-schedules/${s.id}/enabled`, { enabled: !s.enabled }),
    onSuccess: refresh,
    onError: (err) => toast.error(getApiErrorMessage(err)),
  });
  const duplicate = useMutation({
    mutationFn: (s: ReportScheduleDTO) => api.post<ReportScheduleDTO>(`/report-schedules/${s.id}/duplicate`),
    onSuccess: (res) => {
      refresh();
      toast.success("Cópia criada, desativada — revise e ative.");
      setEditing({ id: res.data.id, input: toInput(res.data) });
    },
    onError: (err) => toast.error(getApiErrorMessage(err)),
  });
  const remove = useMutation({
    mutationFn: (s: ReportScheduleDTO) => api.delete(`/report-schedules/${s.id}`),
    onSuccess: () => {
      refresh();
      toast.success("Agendamento excluído.");
    },
    onError: (err) => toast.error(getApiErrorMessage(err)),
  });
  const sendNow = useMutation({
    mutationFn: (s: ReportScheduleDTO) => api.post<ReportScheduleRunDTO>(`/report-schedules/${s.id}/send-now`),
    onSuccess: (res) => {
      refresh();
      toast.success(res.data.rejected.length ? `Enviado, mas recusado para: ${res.data.rejected.join(", ")}` : "Apresentação enviada agora.");
    },
    onError: (err) => toast.error(getApiErrorMessage(err, "Falha no envio")),
  });

  const schedules = data?.schedules ?? [];

  return (
    <div className="space-y-4">
      <div className="shadow-soft flex flex-wrap items-start justify-between gap-3 rounded-card border border-border bg-surface p-5">
        <div className="max-w-2xl">
          <h2 className="flex items-center gap-2 text-base font-semibold">
            <CalendarClock className="h-4 w-4 text-primary" /> Agendamento da apresentação
          </h2>
          <p className="mt-1 text-sm text-muted">
            Envia por e-mail, sozinha, a apresentação em PowerPoint do Dashboard, com os filtros escolhidos. O arquivo é montado na hora de cada envio e não fica salvo no servidor. Feriados do
            cadastro passam para o próximo dia livre; se um envio falhar, o sistema tenta de novo em 5 e 15 minutos e depois avisa quem estiver no alerta.
          </p>
        </div>
        {canEdit && data && (
          <button
            onClick={() => setEditing({ id: null, input: emptyInput(data.defaults) })}
            className="focus-ring flex items-center gap-1.5 rounded-card bg-primary px-4 py-2 text-sm font-semibold text-primary-fg"
          >
            <Plus className="h-4 w-4" /> Novo agendamento
          </button>
        )}
      </div>

      {schedules.length === 0 && data && (
        <div className="rounded-card border border-dashed border-border p-8 text-center text-sm text-muted">
          Nenhum envio agendado ainda. Crie o primeiro para a diretoria receber a apresentação sem precisar pedir.
        </div>
      )}

      <div className="grid gap-3 xl:grid-cols-2">
        {schedules.map((s) => (
          <div key={s.id} className={clsx("shadow-soft rounded-card border bg-surface p-4", s.lastStatus === "FAILED" ? "border-red-500/50" : "border-border")}>
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="flex flex-wrap items-center gap-2 font-semibold">
                  {s.name}
                  <span className={clsx("rounded-full px-2 py-0.5 text-[11px] font-semibold", s.enabled ? "bg-primary/10 text-primary" : "bg-surface-alt text-muted")}>
                    {s.enabled ? REPORT_SCHEDULE_FREQUENCY_LABEL[s.frequency] : "Desativado"}
                  </span>
                  {s.lastStatus && <span className={clsx("rounded-full px-2 py-0.5 text-[11px] font-semibold", STATUS[s.lastStatus].className)}>{STATUS[s.lastStatus].label}</span>}
                </p>
                <p className="mt-1 text-[13px] text-muted">{describeRule(s)}</p>
                <p className="mt-0.5 text-[13px] text-muted">
                  Para {s.to.length} {s.to.length === 1 ? "pessoa" : "pessoas"}
                  {s.cc.length ? `, com cópia para ${s.cc.length}` : ""} · {REPORT_SCHEDULE_PERIOD_LABEL[s.period]}
                </p>
              </div>
              <div className="shrink-0 text-right text-xs text-muted">
                <p>Próximo envio</p>
                <p className="font-semibold text-[var(--color-text)]">{s.enabled ? formatWhen(s.nextRunAt) : "—"}</p>
              </div>
            </div>
            {s.lastStatus && s.lastStatus !== "SENT" && s.lastError && (
              <div className="mt-3 flex items-start gap-2 rounded-card bg-red-500/10 p-2.5 text-[13px] text-red-700 dark:text-red-300">
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                <span className="min-w-0 flex-1">
                  {s.lastStatus === "RETRYING" ? "Falhou e vai tentar de novo: " : "Falhou no último envio: "}
                  {s.lastError}
                </span>
                {canEdit && (
                  <button onClick={() => sendNow.mutate(s)} className="focus-ring flex shrink-0 items-center gap-1 rounded-lg px-2 py-0.5 font-semibold hover:bg-red-500/10">
                    <RotateCw className="h-3.5 w-3.5" /> Reenviar agora
                  </button>
                )}
              </div>
            )}
            <div className="mt-3 flex flex-wrap gap-1.5 border-t border-border pt-3">
              {canEdit && (
                <button onClick={() => setEditing({ id: s.id, input: toInput(s) })} className="focus-ring flex items-center gap-1 rounded-lg border border-border px-2.5 py-1 text-xs font-medium hover:bg-surface-alt">
                  <Pencil className="h-3.5 w-3.5" /> Editar
                </button>
              )}
              {canEdit && (
                <button
                  onClick={() => sendNow.mutate(s)}
                  disabled={sendNow.isPending}
                  className="focus-ring flex items-center gap-1 rounded-lg border border-border px-2.5 py-1 text-xs font-medium hover:bg-surface-alt disabled:opacity-60"
                >
                  <Send className="h-3.5 w-3.5" /> {sendNow.isPending && sendNow.variables?.id === s.id ? "Enviando..." : "Enviar agora"}
                </button>
              )}
              {canEdit && (
                <button onClick={() => toggle.mutate(s)} className="focus-ring flex items-center gap-1 rounded-lg border border-border px-2.5 py-1 text-xs font-medium hover:bg-surface-alt">
                  {s.enabled ? <Pause className="h-3.5 w-3.5" /> : <Play className="h-3.5 w-3.5" />} {s.enabled ? "Desativar" : "Ativar"}
                </button>
              )}
              {canEdit && (
                <button onClick={() => duplicate.mutate(s)} className="focus-ring flex items-center gap-1 rounded-lg border border-border px-2.5 py-1 text-xs font-medium hover:bg-surface-alt">
                  <Copy className="h-3.5 w-3.5" /> Duplicar
                </button>
              )}
              <button onClick={() => setHistoryOf(s)} className="focus-ring flex items-center gap-1 rounded-lg border border-border px-2.5 py-1 text-xs font-medium hover:bg-surface-alt">
                <History className="h-3.5 w-3.5" /> Histórico
              </button>
              {canEdit && (
                <button
                  onClick={() => window.confirm(`Excluir o agendamento "${s.name}"? Os próximos envios não acontecem mais.`) && remove.mutate(s)}
                  className="focus-ring ml-auto flex items-center gap-1 rounded-lg px-2.5 py-1 text-xs font-medium text-red-600 hover:bg-red-500/10"
                >
                  <Trash2 className="h-3.5 w-3.5" /> Excluir
                </button>
              )}
            </div>
          </div>
        ))}
      </div>

      {editing && data && (
        <ScheduleForm
          id={editing.id}
          initial={editing.input}
          tags={data.tags}
          onClose={() => setEditing(null)}
          onSaved={() => {
            refresh();
            setEditing(null);
          }}
        />
      )}
      {historyOf && <RunsModal schedule={historyOf} onClose={() => setHistoryOf(null)} />}
    </div>
  );
}

type FocusableField = "subject" | "title" | "bodyText";

function ScheduleForm({
  id,
  initial,
  tags,
  onClose,
  onSaved,
}: {
  id: string | null;
  initial: ReportScheduleInput;
  tags: { tag: string; description: string }[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const [form, setForm] = useState<ReportScheduleInput>(initial);
  const [lastFocused, setLastFocused] = useState<FocusableField>("bodyText");
  const [warnings, setWarnings] = useState<CheckResponse | null>(null);
  const [upcoming, setUpcoming] = useState<string[]>([]);
  const [previewHtml, setPreviewHtml] = useState("");
  const set = <K extends keyof ReportScheduleInput>(key: K, value: ReportScheduleInput[K]) => setForm((f) => ({ ...f, [key]: value }));

  const { data: agents } = useQuery({ queryKey: ["agents"], queryFn: async () => (await api.get<{ id: string; displayName: string }[]>("/agents")).data });
  const { data: connections } = useQuery({
    queryKey: ["whatsapp-connections"],
    queryFn: async () => (await api.get<{ id: string; name: string }[]>("/whatsapp/connections")).data,
  });
  const { data: sms } = useQuery({ queryKey: ["sms-availability"], queryFn: async () => (await api.get<SmsAvailabilityDTO>("/settings/sms/availability")).data });

  // Live e-mail preview, debounced like the other templates.
  useEffect(() => {
    const timer = setTimeout(() => {
      api
        .post<{ html: string }>("/report-schedules/email-preview", { subject: form.subject, title: form.title, bodyText: form.bodyText })
        .then((res) => setPreviewHtml(res.data.html))
        .catch(() => undefined);
    }, 400);
    return () => clearTimeout(timer);
  }, [form.subject, form.title, form.bodyText]);

  // The next sends as configured — refreshed as the rule changes.
  const ruleKey = JSON.stringify([form.frequency, form.time, form.startDate, form.weekdays, form.monthDay, form.month, form.customInterval, form.customUnit, form.endType, form.endAfter, form.endDate, form.skipSaturday, form.skipSunday]);
  useEffect(() => {
    const timer = setTimeout(() => {
      api
        .post<CheckResponse>(`/report-schedules/check${id ? `?id=${id}` : ""}`, { ...form, to: form.to.length ? form.to : ["previa@exemplo.com"] })
        .then((res) => setUpcoming(res.data.upcoming))
        .catch(() => setUpcoming([]));
    }, 500);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ruleKey]);

  const save = useMutation({
    mutationFn: async () => (id ? api.put<ReportScheduleSaveResultDTO>(`/report-schedules/${id}`, form) : api.post<ReportScheduleSaveResultDTO>("/report-schedules", form)),
    onSuccess: () => {
      toast.success(id ? "Agendamento salvo." : "Agendamento criado.");
      onSaved();
    },
    onError: (err) => toast.error(getApiErrorMessage(err)),
  });

  const check = useMutation({
    mutationFn: async () => (await api.post<CheckResponse>(`/report-schedules/check${id ? `?id=${id}` : ""}`, form)).data,
    onSuccess: (result) => {
      if (result.conflicts.length || result.externalRecipients.length) setWarnings(result);
      else save.mutate();
    },
    onError: (err) => toast.error(getApiErrorMessage(err)),
  });

  const [downloading, setDownloading] = useState(false);
  async function downloadPreview() {
    setDownloading(true);
    try {
      await downloadFile("/report-schedules/preview", "previa-apresentacao.pptx", {
        frequency: form.frequency,
        customInterval: form.customInterval,
        customUnit: form.customUnit,
        period: form.period,
        agentId: form.agentId,
        connectionIds: form.connectionIds,
        tzOffsetMinutes: form.tzOffsetMinutes,
      });
    } catch (err) {
      toast.error(getApiErrorMessage(err, "Não foi possível gerar a prévia"));
    } finally {
      setDownloading(false);
    }
  }

  function insertTag(tag: string) {
    set(lastFocused, `${form[lastFocused]}${tag}`);
  }

  const showWeekdays = form.frequency === "WEEKLY" || form.frequency === "BIWEEKLY" || (form.frequency === "CUSTOM" && form.customUnit === "WEEK");
  const showMonthDay = form.frequency === "MONTHLY" || form.frequency === "YEARLY" || (form.frequency === "CUSTOM" && form.customUnit === "MONTH");
  const startMonthDay = Number(form.startDate.slice(8, 10));
  const missing = !form.name.trim() || form.to.length === 0 || !form.subject.trim() || !form.title.trim() || !form.bodyText.trim();
  const autoPeriod = useMemo(() => {
    if (form.period !== "AUTO") return null;
    const byFrequency: Record<ReportScheduleFrequency, ReportSchedulePeriod> = { DAILY: "yesterday", WEEKLY: "last7days", BIWEEKLY: "last15days", MONTHLY: "lastMonth", YEARLY: "lastYear", CUSTOM: "last7days" };
    return form.frequency === "CUSTOM" ? null : REPORT_SCHEDULE_PERIOD_LABEL[byFrequency[form.frequency]];
  }, [form.period, form.frequency]);

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/40 p-3 sm:p-6" onClick={onClose}>
      <div role="dialog" aria-modal="true" className="w-full max-w-6xl rounded-card border border-border bg-surface shadow-elevated" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between border-b border-border px-5 py-4">
          <h2 className="flex items-center gap-2 text-base font-semibold">
            <CalendarClock className="h-4 w-4 text-primary" /> {id ? "Editar agendamento" : "Novo agendamento"}
          </h2>
          <button onClick={onClose} className="focus-ring rounded-lg p-1.5 text-muted hover:bg-surface-alt" aria-label="Fechar">
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="grid gap-6 p-5 lg:grid-cols-2">
          <div className="space-y-4">
            <label className="block">
              <span className={labelClass}>Nome do agendamento</span>
              <input value={form.name} onChange={(e) => set("name", e.target.value)} placeholder="Ex.: Diretoria — semanal" className={inputClass} />
            </label>
            <label className="flex items-center gap-2">
              <input type="checkbox" checked={form.enabled} onChange={(e) => set("enabled", e.target.checked)} />
              <span className="text-sm font-medium">Enviar este e-mail automaticamente</span>
            </label>

            <div>
              <span className={labelClass}>Destinatários (Para)</span>
              <ChipsInput value={form.to} onChange={(v) => set("to", v)} placeholder="Digite os e-mails e tecle Enter" />
            </div>
            <div>
              <span className={labelClass}>Cópia (CC)</span>
              <ChipsInput value={form.cc} onChange={(v) => set("cc", v)} placeholder="Opcional" />
            </div>

            <label className="block">
              <span className={labelClass}>Assunto</span>
              <input value={form.subject} onChange={(e) => set("subject", e.target.value)} onFocus={() => setLastFocused("subject")} className={inputClass} />
            </label>
            <label className="block">
              <span className={labelClass}>Título</span>
              <input
                value={form.title}
                onChange={(e) => set("title", e.target.value)}
                onFocus={() => setLastFocused("title")}
                placeholder="Aparece em destaque no topo do e-mail"
                className={inputClass}
              />
            </label>
            <label className="block">
              <span className={labelClass}>Texto do e-mail</span>
              <textarea value={form.bodyText} onChange={(e) => set("bodyText", e.target.value)} onFocus={() => setLastFocused("bodyText")} rows={7} className={inputClass} />
              <span className="mt-1 block text-xs text-muted">Deixe uma linha em branco para começar um novo parágrafo. A apresentação vai em anexo.</span>
            </label>
            <div>
              <p className="mb-2 flex items-center gap-1.5 text-sm font-medium">
                <Tag className="h-3.5 w-3.5" /> Tags disponíveis (clique para inserir no campo selecionado)
              </p>
              <div className="flex flex-wrap gap-1.5">
                {[...tags, { tag: "{{empresa}}", description: "Nome da empresa" }].map((t) => (
                  <button
                    key={t.tag}
                    type="button"
                    title={t.description}
                    onClick={() => insertTag(t.tag)}
                    className="focus-ring rounded-full border border-border px-2 py-1 font-mono text-xs hover:bg-surface-alt"
                  >
                    {t.tag}
                  </button>
                ))}
              </div>
            </div>
          </div>

          <div className="space-y-4">
            <section className="rounded-card border border-border p-4">
              <h3 className="mb-3 text-sm font-semibold">Quando enviar</h3>
              <div className="grid gap-3 sm:grid-cols-3">
                <label className="block">
                  <span className={labelClass}>Frequência</span>
                  <select value={form.frequency} onChange={(e) => set("frequency", e.target.value as ReportScheduleFrequency)} className={inputClass}>
                    {(Object.keys(REPORT_SCHEDULE_FREQUENCY_LABEL) as ReportScheduleFrequency[]).map((f) => (
                      <option key={f} value={f}>
                        {REPORT_SCHEDULE_FREQUENCY_LABEL[f]}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="block">
                  <span className={labelClass}>Horário</span>
                  <input type="time" value={form.time} onChange={(e) => set("time", e.target.value)} className={inputClass} />
                </label>
                <label className="block">
                  <span className={labelClass}>A partir de</span>
                  <input type="date" value={form.startDate} onChange={(e) => set("startDate", e.target.value)} className={inputClass} />
                </label>
              </div>

              {form.frequency === "CUSTOM" && (
                <div className="mt-3 flex flex-wrap items-center gap-2 text-sm">
                  <span>A cada</span>
                  <input
                    type="number"
                    min={1}
                    max={365}
                    value={form.customInterval}
                    onChange={(e) => set("customInterval", Math.max(1, Number(e.target.value) || 1))}
                    className="focus-ring w-20 rounded-card border border-border bg-transparent px-3 py-1.5 text-sm"
                  />
                  <select value={form.customUnit} onChange={(e) => set("customUnit", e.target.value as ReportScheduleInput["customUnit"])} className="focus-ring rounded-card border border-border bg-transparent px-3 py-1.5 text-sm">
                    <option value="DAY">dia(s)</option>
                    <option value="WEEK">semana(s)</option>
                    <option value="MONTH">mês(es)</option>
                  </select>
                </div>
              )}

              {showWeekdays && (
                <div className="mt-3">
                  <span className={labelClass}>Dias da semana</span>
                  <div className="flex flex-wrap gap-1.5">
                    {WEEKDAYS.map((label, day) => {
                      const on = form.weekdays.includes(day);
                      return (
                        <button
                          key={label}
                          type="button"
                          onClick={() => set("weekdays", on ? form.weekdays.filter((d) => d !== day) : [...form.weekdays, day])}
                          className={clsx("focus-ring rounded-full border px-3 py-1 text-xs font-semibold", on ? "border-primary bg-primary text-primary-fg" : "border-border hover:bg-surface-alt")}
                        >
                          {label}
                        </button>
                      );
                    })}
                  </div>
                </div>
              )}

              {showMonthDay && (
                <div className="mt-3 flex flex-wrap items-end gap-3">
                  {form.frequency === "YEARLY" && (
                    <label className="block">
                      <span className={labelClass}>Mês</span>
                      <select value={form.month ?? Number(form.startDate.slice(5, 7))} onChange={(e) => set("month", Number(e.target.value))} className={inputClass}>
                        {MONTHS.map((m, i) => (
                          <option key={m} value={i + 1}>
                            {m}
                          </option>
                        ))}
                      </select>
                    </label>
                  )}
                  <label className="block">
                    <span className={labelClass}>Dia do mês</span>
                    <input
                      type="number"
                      min={1}
                      max={31}
                      value={form.monthDay ?? startMonthDay}
                      onChange={(e) => set("monthDay", Math.min(31, Math.max(1, Number(e.target.value) || 1)))}
                      className="focus-ring w-24 rounded-card border border-border bg-transparent px-3 py-2 text-sm"
                    />
                  </label>
                  {(form.monthDay ?? startMonthDay) > 28 && <p className="pb-2 text-xs text-muted">Nos meses mais curtos, vai no último dia.</p>}
                </div>
              )}

              <div className="mt-4 grid gap-3 sm:grid-cols-2">
                <div>
                  <span className={labelClass}>Repetir até</span>
                  <div className="flex flex-wrap items-center gap-2 text-sm">
                    <select value={form.endType} onChange={(e) => set("endType", e.target.value as ReportScheduleInput["endType"])} className="focus-ring rounded-card border border-border bg-transparent px-3 py-2 text-sm">
                      <option value="NEVER">Sem data para terminar</option>
                      <option value="AFTER">Depois de alguns envios</option>
                      <option value="ON_DATE">Uma data</option>
                    </select>
                    {form.endType === "AFTER" && (
                      <input
                        type="number"
                        min={1}
                        value={form.endAfter ?? 10}
                        onChange={(e) => set("endAfter", Math.max(1, Number(e.target.value) || 1))}
                        className="focus-ring w-20 rounded-card border border-border bg-transparent px-3 py-2 text-sm"
                        aria-label="Quantidade de envios"
                      />
                    )}
                    {form.endType === "ON_DATE" && (
                      <input type="date" value={form.endDate ?? ""} min={form.startDate} onChange={(e) => set("endDate", e.target.value || null)} className="focus-ring rounded-card border border-border bg-transparent px-3 py-2 text-sm" />
                    )}
                  </div>
                </div>
                <div>
                  <span className={labelClass}>Fim de semana</span>
                  <label className="flex items-center gap-2 text-sm">
                    <input type="checkbox" checked={form.skipSaturday} onChange={(e) => set("skipSaturday", e.target.checked)} /> Não enviar no sábado
                  </label>
                  <label className="mt-1 flex items-center gap-2 text-sm">
                    <input type="checkbox" checked={form.skipSunday} onChange={(e) => set("skipSunday", e.target.checked)} /> Não enviar no domingo
                  </label>
                </div>
              </div>
              <p className="mt-3 text-xs text-muted">O dia pulado (fim de semana marcado ou feriado do cadastro em Configurações › Feriados) vai para o próximo dia livre.</p>
              {upcoming.length > 0 && (
                <div className="mt-3 rounded-card bg-primary/5 p-3">
                  <p className="mb-1 text-xs font-semibold text-primary">Próximos envios</p>
                  <ul className="space-y-0.5 text-[13px]">
                    {upcoming.map((u) => (
                      <li key={u}>{formatWhen(u)}</li>
                    ))}
                  </ul>
                </div>
              )}
            </section>

            <section className="rounded-card border border-border p-4">
              <h3 className="mb-3 text-sm font-semibold">Dados da apresentação</h3>
              <div className="grid gap-3 sm:grid-cols-2">
                <label className="block">
                  <span className={labelClass}>Período</span>
                  <select value={form.period} onChange={(e) => set("period", e.target.value as ReportSchedulePeriod)} className={inputClass}>
                    {(Object.keys(REPORT_SCHEDULE_PERIOD_LABEL) as ReportSchedulePeriod[]).map((p) => (
                      <option key={p} value={p}>
                        {REPORT_SCHEDULE_PERIOD_LABEL[p]}
                      </option>
                    ))}
                  </select>
                  {autoPeriod && <span className="mt-1 block text-xs text-muted">Neste agendamento: {autoPeriod.toLowerCase()}.</span>}
                </label>
                <label className="block">
                  <span className={labelClass}>Atendente</span>
                  <select value={form.agentId ?? ""} onChange={(e) => set("agentId", e.target.value || null)} className={inputClass}>
                    <option value="">Todos os atendentes</option>
                    {agents?.map((a) => (
                      <option key={a.id} value={a.id}>
                        {a.displayName}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
              <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
                <ConnectionFilter value={form.connectionIds} onChange={(ids) => set("connectionIds", ids)} />
                <button
                  type="button"
                  onClick={downloadPreview}
                  disabled={downloading}
                  className="focus-ring flex items-center gap-1.5 rounded-card border border-border px-3 py-2 text-sm font-medium hover:bg-surface-alt disabled:opacity-60"
                >
                  <Download className="h-4 w-4" /> {downloading ? "Gerando..." : "Baixar prévia"}
                </button>
              </div>
              <p className="mt-2 text-xs text-muted">A apresentação sai com a visão de Gestor de quem salvar o agendamento (as conexões que essa pessoa acessa).</p>
            </section>

            <section className="rounded-card border border-border p-4">
              <h3 className="mb-1 text-sm font-semibold">Alerta de falha</h3>
              <p className="mb-3 text-xs text-muted">
                Quem criou o agendamento e os administradores sempre recebem o aviso dentro do sistema. Escolha também por onde mais avisar.
              </p>
              <span className={labelClass}>Por e-mail</span>
              <ChipsInput value={form.alerts.emails} onChange={(v) => set("alerts", { ...form.alerts, emails: v })} placeholder="E-mails que recebem o alerta" />

              <label className="mt-3 flex items-center gap-2 text-sm font-medium">
                <input
                  type="checkbox"
                  checked={Boolean(form.alerts.whatsapp)}
                  onChange={(e) => set("alerts", { ...form.alerts, whatsapp: e.target.checked ? { connectionId: connections?.[0]?.id ?? "", phones: [] } : null })}
                />
                Por WhatsApp
              </label>
              {form.alerts.whatsapp && (
                <div className="mt-2 grid gap-2 sm:grid-cols-[200px_1fr]">
                  <select
                    value={form.alerts.whatsapp.connectionId}
                    onChange={(e) => set("alerts", { ...form.alerts, whatsapp: { ...form.alerts.whatsapp!, connectionId: e.target.value } })}
                    className={inputClass}
                  >
                    {connections?.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.name}
                      </option>
                    ))}
                  </select>
                  <ChipsInput kind="phone" value={form.alerts.whatsapp.phones} onChange={(v) => set("alerts", { ...form.alerts, whatsapp: { ...form.alerts.whatsapp!, phones: v } })} placeholder="(65) 99999-9999" />
                </div>
              )}

              {sms?.available && (
                <>
                  <label className="mt-3 flex items-center gap-2 text-sm font-medium">
                    <input type="checkbox" checked={Boolean(form.alerts.sms)} onChange={(e) => set("alerts", { ...form.alerts, sms: e.target.checked ? { phones: [] } : null })} />
                    Por SMS <span className="text-xs font-normal text-muted">({sms.providerLabel})</span>
                  </label>
                  {form.alerts.sms && (
                    <div className="mt-2">
                      <ChipsInput kind="phone" value={form.alerts.sms.phones} onChange={(v) => set("alerts", { ...form.alerts, sms: { phones: v } })} placeholder="(65) 99999-9999" />
                    </div>
                  )}
                </>
              )}
            </section>

            <div>
              <p className="mb-2 text-sm font-medium">Pré-visualização do e-mail (com dados de exemplo)</p>
              <iframe title="Pré-visualização do e-mail" srcDoc={previewHtml} className="h-[420px] w-full rounded-card border border-border bg-white" sandbox="" />
            </div>
          </div>
        </div>

        <div className="flex flex-wrap items-center justify-end gap-2 border-t border-border px-5 py-4">
          {missing && <p className="mr-auto text-xs text-muted">Preencha o nome, pelo menos um destinatário, o assunto, o título e o texto.</p>}
          <button onClick={onClose} className="focus-ring rounded-card border border-border px-4 py-2 text-sm font-medium hover:bg-surface-alt">
            Cancelar
          </button>
          <button
            onClick={() => check.mutate()}
            disabled={missing || check.isPending || save.isPending}
            className="focus-ring rounded-card bg-primary px-4 py-2 text-sm font-semibold text-primary-fg disabled:opacity-60"
          >
            {save.isPending ? "Salvando..." : "Salvar agendamento"}
          </button>
        </div>
      </div>

      {warnings && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/40 px-4" onClick={(e) => e.stopPropagation()}>
          <div role="alertdialog" aria-modal="true" className="w-full max-w-md rounded-card border border-border bg-surface p-5 shadow-elevated">
            <h3 className="flex items-center gap-2 font-semibold">
              <AlertTriangle className="h-5 w-5 text-amber-500" /> Antes de salvar
            </h3>
            {warnings.conflicts.length > 0 && (
              <div className="mt-3 text-sm">
                <p>Já existe envio agendado no mesmo dia para os mesmos destinatários:</p>
                <ul className="mt-1.5 space-y-1">
                  {warnings.conflicts.map((c) => (
                    <li key={c.scheduleId} className="rounded-lg bg-amber-500/10 px-2.5 py-1.5 text-[13px]">
                      <strong>{c.name}</strong> em {formatDay(c.day)} — {c.recipients.join(", ")}
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {warnings.externalRecipients.length > 0 && (
              <p className="mt-3 text-sm">
                Destinatários de fora da empresa: <strong>{warnings.externalRecipients.join(", ")}</strong>. A apresentação leva nomes de clientes e de quem ainda não confirmou os avisos.
              </p>
            )}
            <p className="mt-3 text-xs text-muted">Isto é só um aviso: você pode salvar assim mesmo.</p>
            <div className="mt-4 flex justify-end gap-2">
              <button onClick={() => setWarnings(null)} className="focus-ring rounded-card border border-border px-4 py-2 text-sm font-medium hover:bg-surface-alt">
                Voltar e ajustar
              </button>
              <button
                onClick={() => {
                  setWarnings(null);
                  save.mutate();
                }}
                className="focus-ring rounded-card bg-primary px-4 py-2 text-sm font-semibold text-primary-fg"
              >
                Salvar mesmo assim
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function RunsModal({ schedule, onClose }: { schedule: ReportScheduleDTO; onClose: () => void }) {
  const { data } = useQuery({ queryKey: ["report-schedule-runs", schedule.id], queryFn: async () => (await api.get<ReportScheduleRunDTO[]>(`/report-schedules/${schedule.id}/runs`)).data });
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-4" onClick={onClose}>
      <div role="dialog" aria-modal="true" className="flex max-h-[85vh] w-full max-w-2xl flex-col rounded-card border border-border bg-surface shadow-elevated" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between border-b border-border px-5 py-4">
          <h2 className="font-semibold">Histórico de envios — {schedule.name}</h2>
          <button onClick={onClose} className="focus-ring rounded-lg p-1.5 text-muted hover:bg-surface-alt" aria-label="Fechar">
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="flex-1 overflow-y-auto p-5">
          {data?.length === 0 && <p className="text-sm text-muted">Nenhum envio ainda.</p>}
          <ul className="space-y-2">
            {data?.map((r) => (
              <li key={r.id} className="rounded-card border border-border p-3 text-sm">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="flex items-center gap-2">
                    {r.status === "SENT" ? <CheckCircle2 className="h-4 w-4 text-emerald-600" /> : <AlertTriangle className="h-4 w-4 text-amber-500" />}
                    <span className={clsx("rounded-full px-2 py-0.5 text-[11px] font-semibold", STATUS[r.status].className)}>{STATUS[r.status].label}</span>
                    {r.manual && <span className="text-xs text-muted">Enviar agora</span>}
                    {r.attempt > 1 && <span className="text-xs text-muted">{r.attempt}ª tentativa</span>}
                  </span>
                  <span className="text-xs text-muted">{formatWhen(r.createdAt)}</span>
                </div>
                <p className="mt-1 text-xs text-muted">Para: {r.recipients.join(", ")}</p>
                {r.rejected.length > 0 && <p className="mt-1 text-xs text-amber-700 dark:text-amber-300">Recusados: {r.rejected.join(", ")}</p>}
                {r.error && <p className="mt-1 text-xs text-red-600">{r.error}</p>}
              </li>
            ))}
          </ul>
        </div>
      </div>
    </div>
  );
}
