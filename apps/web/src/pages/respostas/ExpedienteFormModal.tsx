import { useState, type FormEvent } from "react";
import { useQuery } from "@tanstack/react-query";
import { X } from "lucide-react";
import { WEEKDAY_KEYS, stateUtcOffsetMinutes, type WeekdayKey, type WorkScheduleDTO, type WorkScheduleHolidayDTO } from "@whatsatendende/types";
import { api } from "../../lib/api";
import { StateCitySelect } from "../../components/common/StateCitySelect";
import { insertTag } from "../dados/TagButtons";

const WEEKDAY_LABEL: Record<WeekdayKey, string> = { MON: "Segunda", TUE: "Terça", WED: "Quarta", THU: "Quinta", FRI: "Sexta", SAT: "Sábado", SUN: "Domingo" };
const DEFAULT_START = "08:00";
const DEFAULT_END = "18:00";
const CLIENT_TAGS = [
  { tag: "{{cliente}}", label: "nome do cliente" },
  { tag: "{{primeiro_nome}}", label: "primeiro nome do cliente" },
  { tag: "{{saudacao}}", label: "Bom dia, Boa tarde ou Boa noite, conforme o horário" },
];
const CLOSED_MESSAGE_PLACEHOLDER = "Olá, {{cliente}}! No momento estamos fora do horário de atendimento. Assim que abrirmos, responderemos você.";

interface DayValue {
  open: boolean;
  allDay: boolean;
  start: string;
  end: string;
}

interface PartialValue {
  /** Checked = closed all day (the default for a holiday); unchecked opens start–end on that date only. */
  allDayClosed: boolean;
  start: string;
  end: string;
}

export interface ExpedienteFormValues {
  name: string;
  state: string;
  city: string;
  days: WorkScheduleDTO["days"];
  partialHolidays: WorkScheduleDTO["partialHolidays"];
  closedMessage: string;
}

function toDayValues(schedule: WorkScheduleDTO | null): Record<WeekdayKey, DayValue> {
  return Object.fromEntries(
    WEEKDAY_KEYS.map((key) => {
      const window = schedule?.days[key];
      const weekday = key !== "SAT" && key !== "SUN";
      const value: DayValue = window
        ? { open: true, allDay: Boolean(window.allDay), start: window.allDay ? DEFAULT_START : window.start, end: window.allDay ? DEFAULT_END : window.end }
        : { open: !schedule && weekday, allDay: false, start: DEFAULT_START, end: DEFAULT_END };
      return [key, value];
    })
  ) as Record<WeekdayKey, DayValue>;
}

function formatDate(dateKey: string): string {
  const [year, month, day] = dateKey.split("-");
  return `${day}/${month}/${year}`;
}

function utcLabel(state: string): string {
  const hours = stateUtcOffsetMinutes(state) / 60;
  return `UTC−${hours}`;
}

/** Horário de expediente: dias da semana, feriados parciais da cidade e a mensagem de fora do expediente. */
export function ExpedienteFormModal({
  schedule,
  onClose,
  onSubmit,
}: {
  schedule: WorkScheduleDTO | null;
  onClose: () => void;
  onSubmit: (values: ExpedienteFormValues) => Promise<void>;
}) {
  const [name, setName] = useState(schedule?.name ?? "");
  const [state, setState] = useState<string | null>(schedule?.state ?? null);
  const [city, setCity] = useState<string | null>(schedule?.city ?? null);
  const [days, setDays] = useState(() => toDayValues(schedule));
  const [partials, setPartials] = useState<Record<string, PartialValue>>(() =>
    Object.fromEntries((schedule?.partialHolidays ?? []).map((h) => [h.date, { allDayClosed: false, start: h.start, end: h.end }]))
  );
  const [closedMessage, setClosedMessage] = useState(schedule?.closedMessage ?? "");
  const [closedMessageEl, setClosedMessageEl] = useState<HTMLTextAreaElement | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const { data: holidays } = useQuery({
    queryKey: ["work-schedule-holidays", state, city],
    queryFn: async () => (await api.get<WorkScheduleHolidayDTO[]>("/work-schedules/holidays", { params: { state, city } })).data,
    enabled: Boolean(state && city),
  });

  // Dates already saved as partial that the list no longer shows (a past date) stay editable.
  const listed = new Set((holidays ?? []).map((h) => h.date));
  const extraDates = Object.keys(partials).filter((date) => !listed.has(date) && !partials[date].allDayClosed);
  const holidayRows: WorkScheduleHolidayDTO[] = [...(holidays ?? []), ...extraDates.map((date) => ({ date, name: "Feriado" }))].sort((a, b) => a.date.localeCompare(b.date));

  function setDay(key: WeekdayKey, patch: Partial<DayValue>) {
    setDays((d) => ({ ...d, [key]: { ...d[key], ...patch } }));
  }

  function setPartial(date: string, patch: Partial<PartialValue>) {
    setPartials((p) => ({ ...p, [date]: { ...(p[date] ?? { allDayClosed: true, start: DEFAULT_START, end: DEFAULT_END }), ...patch } }));
  }

  function insertClientTag(tag: string) {
    insertTag(closedMessageEl, closedMessage, tag, setClosedMessage);
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    if (!state || !city) {
      setError("Escolha o estado e a cidade");
      return;
    }
    const openDays = WEEKDAY_KEYS.filter((key) => days[key].open);
    if (openDays.length === 0) {
      setError("Marque pelo menos um dia da semana");
      return;
    }
    if (openDays.some((key) => !days[key].allDay && days[key].start >= days[key].end)) {
      setError("Em cada dia, o início deve ser antes do término");
      return;
    }
    const partialDates = Object.keys(partials).filter((date) => !partials[date].allDayClosed);
    if (partialDates.some((date) => partials[date].start >= partials[date].end)) {
      setError("Em cada feriado parcial, o início deve ser antes do término");
      return;
    }
    setLoading(true);
    try {
      await onSubmit({
        name: name.trim(),
        state,
        city,
        days: Object.fromEntries(openDays.map((key) => [key, days[key].allDay ? { allDay: true } : { start: days[key].start, end: days[key].end }])),
        partialHolidays: partialDates.sort().map((date) => ({ date, start: partials[date].start, end: partials[date].end })),
        closedMessage: closedMessage.trim(),
      });
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Erro ao salvar o horário");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="drawer-backdrop">
      <form onSubmit={handleSubmit} className="drawer-panel max-w-xl overflow-y-auto p-5">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-base font-semibold">{schedule ? "Editar horário de expediente" : "Novo horário de expediente"}</h2>
          <button type="button" onClick={onClose} className="focus-ring rounded-full p-1 text-muted hover:bg-surface-alt" aria-label="Fechar">
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="flex-1 space-y-4 overflow-y-auto">
          <label className="block">
            <span className="mb-1 block text-sm font-medium">Nome</span>
            <input
              required
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={120}
              placeholder="Ex: Matriz — horário comercial"
              className="focus-ring w-full rounded-card border border-border bg-transparent px-3 py-2 text-sm"
            />
          </label>

          <div>
            <span className="mb-1 block text-sm font-medium">Cidade do expediente</span>
            <StateCitySelect
              state={state}
              city={city}
              onChange={(next) => {
                setState(next.state);
                setCity(next.city);
              }}
            />
            <p className="mt-1 text-xs text-muted">
              O estado define o fuso horário{state ? ` (${utcLabel(state)})` : ""}; a cidade define os feriados que valem.
            </p>
          </div>

          <div>
            <span className="mb-1 block text-sm font-medium">Dias e horários</span>
            <ul className="divide-y divide-border rounded-card border border-border">
              {WEEKDAY_KEYS.map((key) => {
                const day = days[key];
                return (
                  <li key={key} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2">
                    <label className="flex w-28 items-center gap-2 text-sm font-medium">
                      <input type="checkbox" checked={day.open} onChange={(e) => setDay(key, { open: e.target.checked })} className="h-4 w-4 accent-primary" />
                      {WEEKDAY_LABEL[key]}
                    </label>
                    {!day.open && <span className="text-xs text-muted">Fechado</span>}
                    {day.open && (
                      <>
                        <label className="flex items-center gap-1.5 text-xs">
                          <input type="checkbox" checked={day.allDay} onChange={(e) => setDay(key, { allDay: e.target.checked })} className="h-4 w-4 accent-primary" />
                          Atender 24h
                        </label>
                        {!day.allDay && (
                          <span className="ms-auto flex items-center gap-1.5 text-xs">
                            <input
                              type="time"
                              required
                              value={day.start}
                              onChange={(e) => setDay(key, { start: e.target.value })}
                              aria-label={`Início de ${WEEKDAY_LABEL[key]}`}
                              className="focus-ring rounded-card border border-border bg-transparent px-2 py-1 text-sm"
                            />
                            às
                            <input
                              type="time"
                              required
                              value={day.end}
                              onChange={(e) => setDay(key, { end: e.target.value })}
                              aria-label={`Término de ${WEEKDAY_LABEL[key]}`}
                              className="focus-ring rounded-card border border-border bg-transparent px-2 py-1 text-sm"
                            />
                          </span>
                        )}
                      </>
                    )}
                  </li>
                );
              })}
            </ul>
          </div>

          <div>
            <span className="mb-1 block text-sm font-medium">Feriados</span>
            <p className="mb-1.5 text-xs text-muted">
              Nos feriados da cidade o expediente fica fechado o dia todo. Para abrir só em uma data, desmarque “Dia todo” e informe o horário.
            </p>
            {!state || !city ? (
              <p className="rounded-card border border-dashed border-border px-3 py-3 text-center text-xs text-muted">Escolha a cidade para ver os feriados.</p>
            ) : holidayRows.length === 0 ? (
              <p className="rounded-card border border-dashed border-border px-3 py-3 text-center text-xs text-muted">Nenhum feriado cadastrado para esta cidade.</p>
            ) : (
              <ul className="max-h-64 divide-y divide-border overflow-y-auto rounded-card border border-border">
                {holidayRows.map((h) => {
                  const partial = partials[h.date] ?? { allDayClosed: true, start: DEFAULT_START, end: DEFAULT_END };
                  return (
                    <li key={h.date} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2">
                      <span className="min-w-0 flex-1 text-sm">
                        <span className="tabular-nums text-muted">{formatDate(h.date)}</span> — {h.name}
                      </span>
                      <label className="flex items-center gap-1.5 text-xs">
                        <input
                          type="checkbox"
                          checked={partial.allDayClosed}
                          onChange={(e) => setPartial(h.date, { allDayClosed: e.target.checked })}
                          className="h-4 w-4 accent-primary"
                        />
                        Dia todo (fechado)
                      </label>
                      {!partial.allDayClosed && (
                        <span className="flex items-center gap-1.5 text-xs">
                          <input
                            type="time"
                            value={partial.start}
                            onChange={(e) => setPartial(h.date, { start: e.target.value })}
                            aria-label={`Início em ${formatDate(h.date)}`}
                            className="focus-ring rounded-card border border-border bg-transparent px-2 py-1 text-sm"
                          />
                          às
                          <input
                            type="time"
                            value={partial.end}
                            onChange={(e) => setPartial(h.date, { end: e.target.value })}
                            aria-label={`Término em ${formatDate(h.date)}`}
                            className="focus-ring rounded-card border border-border bg-transparent px-2 py-1 text-sm"
                          />
                        </span>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
          </div>

          <div>
            <div className="mb-1 flex items-center justify-between">
              <span className="text-sm font-medium">Mensagem de fora do expediente</span>
              <div className="flex flex-wrap gap-1">
                {CLIENT_TAGS.map((t) => (
                  <button
                    key={t.tag}
                    type="button"
                    onClick={() => insertClientTag(t.tag)}
                    title={`Inserir o ${t.label}`}
                    className="focus-ring rounded-full bg-secondary/30 px-2 py-0.5 text-[11px] font-medium text-text hover:bg-secondary/50"
                  >
                    {t.tag}
                  </button>
                ))}
              </div>
            </div>
            <textarea
              required
              rows={4}
              value={closedMessage}
              ref={setClosedMessageEl}
              onChange={(e) => setClosedMessage(e.target.value)}
              maxLength={1024}
              placeholder={CLOSED_MESSAGE_PLACEHOLDER}
              className="focus-ring w-full resize-none rounded-card border border-border bg-transparent px-3 py-2 text-sm"
            />
            <p className="mt-1 text-xs text-muted">Enviada uma vez, quando o cliente escreve fora do horário. É obrigatória.</p>
          </div>
        </div>

        {error && <p className="mt-3 rounded-card bg-danger-soft px-3 py-2 text-sm text-danger">{error}</p>}
        <div className="mt-4 flex gap-2">
          <button type="button" onClick={onClose} className="focus-ring flex-1 rounded-card border border-border py-2 text-sm">
            Cancelar
          </button>
          <button
            type="submit"
            disabled={loading}
            className="focus-ring flex-1 rounded-card bg-primary py-2 text-sm font-semibold text-primary-fg hover:opacity-90 disabled:opacity-60"
          >
            {loading ? "Salvando..." : "Salvar"}
          </button>
        </div>
      </form>
    </div>
  );
}
