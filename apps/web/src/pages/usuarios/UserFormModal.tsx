import { useEffect, useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { X } from "lucide-react";
import type { UserDTO, Role, ManagerConnectionAccessDTO, AccessSchedule, WeekdayKey } from "@whatsunivida/types";
import { WEEKDAY_KEYS } from "@whatsunivida/types";
import { api, getApiErrorMessage } from "../../lib/api";
import { StateCitySelect } from "../../components/common/StateCitySelect";

const WEEKDAY_LABELS: Record<WeekdayKey, string> = {
  MON: "Segunda",
  TUE: "Terça",
  WED: "Quarta",
  THU: "Quinta",
  FRI: "Sexta",
  SAT: "Sábado",
  SUN: "Domingo",
};

export interface UserFormValues {
  fullName: string;
  displayName: string;
  email: string;
  password?: string;
  confirmPassword?: string;
  role: Role;
  whatsappConnectionId: string | null;
  workState: string | null;
  workCity: string | null;
  accessSchedule: AccessSchedule | null;
}

interface ConnectionOption {
  id: string;
  name: string;
}

export function UserFormModal({
  user,
  onClose,
  onSubmit,
}: {
  user: UserDTO | null;
  onClose: () => void;
  onSubmit: (values: UserFormValues) => Promise<void>;
}) {
  const { data: connections } = useQuery({
    queryKey: ["whatsapp-connections"],
    queryFn: async () => (await api.get<ConnectionOption[]>("/whatsapp/connections")).data,
  });

  const [values, setValues] = useState<UserFormValues>({
    fullName: user?.fullName ?? "",
    displayName: user?.displayName ?? "",
    email: user?.email ?? "",
    password: "",
    confirmPassword: "",
    role: user?.role ?? "AGENT",
    whatsappConnectionId: user?.whatsappConnectionId ?? null,
    workState: user?.workState ?? null,
    workCity: user?.workCity ?? null,
    accessSchedule: user?.accessSchedule ?? null,
  });
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [changingPassword, setChangingPassword] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    const wantsPasswordChange = !user || changingPassword;
    if (wantsPasswordChange && (values.password || values.confirmPassword) && values.password !== values.confirmPassword) {
      setError("As senhas não coincidem");
      return;
    }
    if (!user && !values.password) {
      setError("Informe uma senha");
      return;
    }
    if (values.role === "AGENT" && !values.whatsappConnectionId) {
      setError("Selecione a conexão de WhatsApp deste atendente");
      return;
    }
    setLoading(true);
    try {
      const payload = wantsPasswordChange ? values : { ...values, password: undefined, confirmPassword: undefined };
      await onSubmit(payload);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Erro ao salvar usuário");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-4 py-8">
      {/* flex-col + max-h-full on the form itself (not just this wrapper) is
          what keeps the header/footer always visible: the form's own height
          is capped to the available viewport space, and only the middle
          section scrolls — otherwise a form this long (horário por dia da
          semana, cidade, permissões de conexão...) grows taller than the
          screen with nothing to shrink it, pushing the X/Cancelar/Salvar
          buttons out of view with no way to reach them. */}
      <form onSubmit={handleSubmit} className="flex max-h-full w-full max-w-md flex-col overflow-hidden rounded-card border border-border bg-surface shadow-elevated">
        <div className="flex shrink-0 items-center justify-between border-b border-border p-5 pb-4">
          <h2 className="text-base font-semibold">{user ? "Editar usuário" : "Novo usuário"}</h2>
          <button type="button" onClick={onClose} className="focus-ring rounded-full p-1 text-muted hover:bg-surface-alt" aria-label="Fechar">
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="flex-1 space-y-3 overflow-y-auto p-5">
          <Field label="Nome completo">
            <input required value={values.fullName} onChange={(e) => setValues((v) => ({ ...v, fullName: e.target.value }))} className="focus-ring w-full rounded-card border border-border bg-transparent px-3 py-2 text-sm" />
          </Field>
          <Field label="Nome de exibição">
            <input required value={values.displayName} onChange={(e) => setValues((v) => ({ ...v, displayName: e.target.value }))} className="focus-ring w-full rounded-card border border-border bg-transparent px-3 py-2 text-sm" />
          </Field>
          <Field label="E-mail">
            <input required type="email" value={values.email} onChange={(e) => setValues((v) => ({ ...v, email: e.target.value }))} className="focus-ring w-full rounded-card border border-border bg-transparent px-3 py-2 text-sm" />
          </Field>
          <Field label="Perfil">
            <select
              value={values.role}
              onChange={(e) => setValues((v) => ({ ...v, role: e.target.value as Role }))}
              className="focus-ring w-full rounded-card border border-border bg-transparent px-3 py-2 text-sm"
            >
              <option value="AGENT">Atendente</option>
              <option value="MANAGER">Gestor</option>
              <option value="ADMIN">Administrador</option>
            </select>
          </Field>

          {values.role === "AGENT" && (
            <Field label="Conexão de WhatsApp">
              <select
                required
                value={values.whatsappConnectionId ?? ""}
                onChange={(e) => setValues((v) => ({ ...v, whatsappConnectionId: e.target.value || null }))}
                className="focus-ring w-full rounded-card border border-border bg-transparent px-3 py-2 text-sm"
              >
                <option value="" disabled>
                  Selecione...
                </option>
                {connections?.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
              {connections?.length === 0 && (
                <p className="mt-1 text-xs text-muted">Nenhuma conexão cadastrada — crie uma em Configurações → WhatsApp primeiro.</p>
              )}
            </Field>
          )}

          <Field label="Cidade onde trabalha">
            <StateCitySelect
              state={values.workState}
              city={values.workCity}
              onChange={({ state, city }) => setValues((v) => ({ ...v, workState: state, workCity: city }))}
            />
            <p className="mt-1 text-xs text-muted">
              Usada para bloquear o acesso automaticamente em feriados estaduais/municipais desta cidade — deixe em branco se não quiser esse bloqueio.
            </p>
          </Field>

          <AccessScheduleField
            value={values.accessSchedule}
            onChange={(accessSchedule) => setValues((v) => ({ ...v, accessSchedule }))}
          />

          {user && values.role === "MANAGER" && <ManagerConnectionAccessEditor managerId={user.id} />}

          {!user && (
            <>
              {values.role === "MANAGER" && (
                <p className="rounded-card bg-secondary/30 px-3 py-2 text-xs text-secondary-fg">
                  Depois de criar este gestor, edite-o novamente para escolher quais conexões (além das que ele mesmo cadastrar) ele poderá ver/editar e receber conversas.
                </p>
              )}
              <Field label="Senha">
                <input required type="password" minLength={8} value={values.password} onChange={(e) => setValues((v) => ({ ...v, password: e.target.value }))} className="focus-ring w-full rounded-card border border-border bg-transparent px-3 py-2 text-sm" />
              </Field>
              <Field label="Confirmar senha">
                <input required type="password" minLength={8} value={values.confirmPassword} onChange={(e) => setValues((v) => ({ ...v, confirmPassword: e.target.value }))} className="focus-ring w-full rounded-card border border-border bg-transparent px-3 py-2 text-sm" />
              </Field>
            </>
          )}

          {user && (
            <div className="rounded-card border border-border p-3">
              <label className="flex items-center gap-2 text-sm font-medium">
                <input
                  type="checkbox"
                  checked={changingPassword}
                  onChange={(e) => {
                    setChangingPassword(e.target.checked);
                    if (!e.target.checked) setValues((v) => ({ ...v, password: "", confirmPassword: "" }));
                  }}
                  className="focus-ring h-4 w-4 rounded border-border"
                />
                Trocar senha
              </label>
              {changingPassword && (
                <div className="mt-3 space-y-3">
                  <Field label="Nova senha">
                    <input
                      required
                      type="password"
                      minLength={8}
                      value={values.password}
                      onChange={(e) => setValues((v) => ({ ...v, password: e.target.value }))}
                      className="focus-ring w-full rounded-card border border-border bg-transparent px-3 py-2 text-sm"
                    />
                  </Field>
                  <Field label="Confirmar nova senha">
                    <input
                      required
                      type="password"
                      minLength={8}
                      value={values.confirmPassword}
                      onChange={(e) => setValues((v) => ({ ...v, confirmPassword: e.target.value }))}
                      className="focus-ring w-full rounded-card border border-border bg-transparent px-3 py-2 text-sm"
                    />
                  </Field>
                </div>
              )}
            </div>
          )}
        </div>

        <div className="shrink-0 border-t border-border p-5 pt-4">
          {error && <p className="mb-3 rounded-card bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}
          <div className="flex gap-2">
            <button type="button" onClick={onClose} className="focus-ring flex-1 rounded-card border border-border py-2 text-sm">
              Cancelar
            </button>
            <button type="submit" disabled={loading} className="focus-ring flex-1 rounded-card bg-primary py-2 text-sm font-semibold text-primary-fg disabled:opacity-60">
              {loading ? "Salvando..." : "Salvar"}
            </button>
          </div>
        </div>
      </form>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 block text-sm font-medium">{label}</span>
      {children}
    </label>
  );
}

/**
 * Per-weekday allowed access window — see PROMPT: "horário que é permitido
 * acessar... pode variar, portanto precisa ser por cada dia da semana...
 * Caso o campo de horário esteja em branco, será considerado 24h (sem
 * bloqueio)". A day's row starts unchecked (= unrestricted, the default for
 * every day); checking it reveals start/end time inputs for that day only.
 */
function AccessScheduleField({ value, onChange }: { value: AccessSchedule | null; onChange: (next: AccessSchedule | null) => void }) {
  const schedule = value ?? {};

  function setDay(day: WeekdayKey, window: { start: string; end: string } | null) {
    const next = { ...schedule };
    if (window) next[day] = window;
    else delete next[day];
    onChange(Object.keys(next).length > 0 ? next : null);
  }

  return (
    <div className="rounded-card border border-border p-3">
      <p className="text-sm font-medium">Horário de acesso permitido</p>
      <p className="mt-0.5 text-xs text-muted">Dias não marcados ficam liberados 24h. Fora do horário marcado, o acesso é bloqueado.</p>
      <div className="mt-3 space-y-1.5">
        {WEEKDAY_KEYS.map((day) => {
          const window = schedule[day];
          const restricted = Boolean(window);
          return (
            <div key={day} className="flex items-center gap-2">
              <label className="flex w-28 shrink-0 items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={restricted}
                  onChange={(e) => setDay(day, e.target.checked ? { start: "08:00", end: "18:00" } : null)}
                  className="focus-ring h-4 w-4 rounded border-border"
                />
                {WEEKDAY_LABELS[day]}
              </label>
              {restricted && window && (
                <div className="flex flex-1 items-center gap-1.5">
                  <input
                    type="time"
                    value={window.start}
                    onChange={(e) => setDay(day, { ...window, start: e.target.value })}
                    className="focus-ring w-full rounded-card border border-border bg-transparent px-2 py-1 text-sm"
                  />
                  <span className="text-xs text-muted">até</span>
                  <input
                    type="time"
                    value={window.end}
                    onChange={(e) => setDay(day, { ...window, end: e.target.value })}
                    className="focus-ring w-full rounded-card border border-border bg-transparent px-2 py-1 text-sm"
                  />
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

/**
 * ADMIN-only editor for which connections a MANAGER can see/edit and
 * receive new conversations from — see PROMPT: "no acesso do
 * administrador, poderá designar qual conexão os gestores poderão
 * ver/editar e também poderão receber novas conversas de quais conexões".
 * A connection this manager created themselves always shows both checked
 * and disabled (implicit full access — see WhatsAppConnection.createdByUserId);
 * every other connection defaults to unchecked until explicitly granted here.
 */
function ManagerConnectionAccessEditor({ managerId }: { managerId: string }) {
  const queryClient = useQueryClient();
  const queryKey = ["manager-connection-access", managerId];
  const { data, isLoading } = useQuery({
    queryKey,
    queryFn: async () => (await api.get<ManagerConnectionAccessDTO[]>(`/whatsapp/managers/${managerId}/access`)).data,
  });
  const [rows, setRows] = useState<ManagerConnectionAccessDTO[]>([]);
  useEffect(() => {
    if (data) setRows(data);
  }, [data]);

  const saveMutation = useMutation({
    mutationFn: async () =>
      (
        await api.put<ManagerConnectionAccessDTO[]>(`/whatsapp/managers/${managerId}/access`, {
          entries: rows.filter((r) => !r.owned).map((r) => ({ whatsappConnectionId: r.whatsappConnectionId, canManage: r.canManage, canReceiveConversations: r.canReceiveConversations })),
        })
      ).data,
    onSuccess: (saved) => {
      setRows(saved);
      queryClient.setQueryData(queryKey, saved);
      toast.success("Permissões de conexão atualizadas.");
    },
    onError: (err) => toast.error(getApiErrorMessage(err, "Erro ao salvar as permissões de conexão")),
  });

  function toggle(connectionId: string, field: "canManage" | "canReceiveConversations") {
    setRows((prev) => prev.map((r) => (r.whatsappConnectionId === connectionId ? { ...r, [field]: !r[field] } : r)));
  }

  return (
    <div className="rounded-card border border-border p-3">
      <p className="text-sm font-medium">Conexões que este gestor pode acessar</p>
      <p className="mt-0.5 text-xs text-muted">
        Por padrão, um gestor só vê as conexões que ele mesmo cadastrar. Marque abaixo para liberar outras.
      </p>
      {isLoading ? (
        <p className="mt-2 text-xs text-muted">Carregando...</p>
      ) : rows.length === 0 ? (
        <p className="mt-2 text-xs text-muted">Nenhuma conexão cadastrada ainda.</p>
      ) : (
        <div className="mt-3 space-y-1.5">
          <div className="grid grid-cols-[1fr_auto_auto] items-center gap-2 text-[11px] font-medium text-muted">
            <span>Conexão</span>
            <span className="w-16 text-center">Ver/editar</span>
            <span className="w-16 text-center">Receber conversas</span>
          </div>
          {rows.map((row) => (
            <div key={row.whatsappConnectionId} className="grid grid-cols-[1fr_auto_auto] items-center gap-2 rounded-card px-1 py-1 text-sm hover:bg-surface-alt">
              <span className="flex items-center gap-1.5 truncate">
                <span className="h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: row.whatsappConnectionColor }} />
                <span className="truncate">{row.whatsappConnectionName}</span>
                {row.owned && <span className="shrink-0 rounded-full bg-secondary/40 px-1.5 py-0.5 text-[10px] text-secondary-fg">própria</span>}
              </span>
              <span className="w-16 text-center">
                <input
                  type="checkbox"
                  checked={row.canManage}
                  disabled={row.owned}
                  onChange={() => toggle(row.whatsappConnectionId, "canManage")}
                  className="focus-ring h-4 w-4 rounded border-border disabled:opacity-60"
                />
              </span>
              <span className="w-16 text-center">
                <input
                  type="checkbox"
                  checked={row.canReceiveConversations}
                  disabled={row.owned}
                  onChange={() => toggle(row.whatsappConnectionId, "canReceiveConversations")}
                  className="focus-ring h-4 w-4 rounded border-border disabled:opacity-60"
                />
              </span>
            </div>
          ))}
        </div>
      )}
      <button
        type="button"
        onClick={() => saveMutation.mutate()}
        disabled={saveMutation.isPending || isLoading}
        className="focus-ring mt-3 rounded-card border border-border px-3 py-1.5 text-xs font-semibold hover:bg-surface-alt disabled:opacity-60"
      >
        {saveMutation.isPending ? "Salvando..." : "Salvar permissões de conexão"}
      </button>
    </div>
  );
}
