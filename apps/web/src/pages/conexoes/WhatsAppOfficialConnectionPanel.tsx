import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CheckCircle2, KeyRound, Pencil, Plug, Plus, Trash2, Users, X } from "lucide-react";
import { toast } from "sonner";
import { PERMISSION } from "@whatsatendende/types";
import { useAuthStore } from "../../store/auth-store";
import { api, getApiErrorMessage } from "../../lib/api";
import { WorkScheduleSelect } from "./WorkScheduleSelect";

interface OfficialConnectionSummary {
  id: string;
  name: string;
  color: string;
  connectionMode: "QRCODE" | "OFFICIAL_API";
  state: "DISCONNECTED" | "CONNECTING" | "CONNECTED";
  connectedNumber: string | null;
  agentCount: number;
  workScheduleId: string | null;
  phoneNumberId: string | null;
  wabaId: string | null;
  hasAccessToken: boolean;
  hasAppSecret: boolean;
  webhookVerifyToken: string | null;
  displayPhoneNumber: string | null;
  businessName: string | null;
}

const STATE_LABEL: Record<string, string> = {
  DISCONNECTED: "Aguardando credenciais",
  CONNECTING: "Testando conexão...",
  CONNECTED: "Conectado",
};

const STATE_COLOR: Record<string, string> = {
  DISCONNECTED: "bg-gray-100 text-gray-600",
  CONNECTING: "bg-secondary/40 text-text",
  CONNECTED: "bg-green-100 text-green-700",
};

const COLOR_SWATCHES = ["#0097B4", "#7C3AED", "#F97316", "#059669", "#DC2626", "#2563EB", "#DB2777", "#65A30D"];

interface OfficialFormValues {
  phoneNumberId: string;
  wabaId: string;
  accessToken: string;
  appSecret: string;
  webhookVerifyToken: string;
}

const EMPTY_FORM: OfficialFormValues = { phoneNumberId: "", wabaId: "", accessToken: "", appSecret: "", webhookVerifyToken: "" };

export function WhatsAppOfficialConnectionPanel() {
  const queryClient = useQueryClient();
  const permissions = useAuthStore((s) => s.permissions);
  const canAdicionar = permissions?.[PERMISSION.CONEXOES_WHATSAPP_ADICIONAR];
  const canEditar = permissions?.[PERMISSION.CONEXOES_WHATSAPP_EDITAR];
  const canExcluir = permissions?.[PERMISSION.CONEXOES_WHATSAPP_EXCLUIR];

  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");
  const [newForm, setNewForm] = useState<OfficialFormValues>(EMPTY_FORM);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editForm, setEditForm] = useState<OfficialFormValues>(EMPTY_FORM);

  const { data: connections } = useQuery({
    queryKey: ["whatsapp-connections"],
    queryFn: async () => (await api.get<OfficialConnectionSummary[]>("/whatsapp/connections")).data,
    refetchInterval: (query) => ((query.state.data ?? []).some((c) => c.state === "CONNECTING") ? 2000 : false),
  });
  // Same shared endpoint as WhatsAppConnectionPanel.tsx — see its own mirror filter comment.
  const officialConnections = connections?.filter((c) => c.connectionMode === "OFFICIAL_API");

  const createMutation = useMutation({
    mutationFn: (payload: { name: string; official: OfficialFormValues }) =>
      api.post("/whatsapp/connections", {
        name: payload.name,
        official: {
          phoneNumberId: payload.official.phoneNumberId,
          wabaId: payload.official.wabaId,
          accessToken: payload.official.accessToken,
          appSecret: payload.official.appSecret || undefined,
          webhookVerifyToken: payload.official.webhookVerifyToken || undefined,
        },
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["whatsapp-connections"] });
      setCreating(false);
      setNewName("");
      setNewForm(EMPTY_FORM);
      toast.success("Conexão oficial criada.");
    },
    onError: (err) => toast.error(getApiErrorMessage(err)),
  });

  const updateMutation = useMutation({
    mutationFn: ({ id, official }: { id: string; official: OfficialFormValues }) =>
      api.patch(`/whatsapp/connections/${id}`, {
        official: {
          phoneNumberId: official.phoneNumberId,
          wabaId: official.wabaId,
          accessToken: official.accessToken || undefined,
          appSecret: official.appSecret || undefined,
          webhookVerifyToken: official.webhookVerifyToken || undefined,
        },
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["whatsapp-connections"] });
      setEditingId(null);
      toast.success("Credenciais salvas. Teste a conexão para validar.");
    },
    onError: (err) => toast.error(getApiErrorMessage(err)),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => api.delete(`/whatsapp/connections/${id}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["whatsapp-connections"] });
      toast.success("Conexão excluída.");
    },
    onError: (err) => toast.error(getApiErrorMessage(err)),
  });

  const testMutation = useMutation({
    mutationFn: (id: string) => api.post(`/whatsapp/connections/${id}/connect`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["whatsapp-connections"] }),
    onError: (err) => toast.error(getApiErrorMessage(err)),
  });

  const disconnectMutation = useMutation({
    mutationFn: (id: string) => api.post(`/whatsapp/connections/${id}/disconnect`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["whatsapp-connections"] }),
  });

  const workScheduleMutation = useMutation({
    mutationFn: ({ id, workScheduleId }: { id: string; workScheduleId: string | null }) => api.patch(`/whatsapp/connections/${id}`, { workScheduleId }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["whatsapp-connections"] });
      queryClient.invalidateQueries({ queryKey: ["work-schedules"] });
    },
    onError: (err) => toast.error(getApiErrorMessage(err)),
  });

  const colorMutation = useMutation({
    mutationFn: ({ id, color }: { id: string; color: string }) => api.patch(`/whatsapp/connections/${id}`, { color }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["whatsapp-connections"] }),
    onError: (err) => toast.error(getApiErrorMessage(err)),
  });

  const webhookUrl = `${window.location.origin}/api/whatsapp/oficial/webhook`;

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h2 className="text-base font-semibold">Conexões via API Oficial (Meta Cloud API)</h2>
          <p className="text-sm text-muted">
            Cada conexão é um número aprovado na sua WhatsApp Business Account. Nomeie-as e atribua atendentes a cada
            uma em Usuários — exatamente como nas conexões por QR Code.
          </p>
        </div>
        {canAdicionar && (
          <button
            onClick={() => setCreating(true)}
            className="focus-ring flex shrink-0 items-center gap-1.5 self-start rounded-card bg-primary px-3 py-2 text-sm font-semibold text-primary-fg hover:opacity-90"
          >
            <Plus className="h-4 w-4" /> Nova conexão oficial
          </button>
        )}
      </div>

      <div className="rounded-card border border-border bg-surface-alt px-3 py-2 text-xs text-muted">
        URL de callback do webhook (cole no App da Meta): <span className="font-mono">{webhookUrl}</span>
      </div>

      {creating && canAdicionar && (
        <div className="shadow-soft max-w-lg space-y-3 rounded-card border border-border bg-surface p-4">
          <input
            autoFocus
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            placeholder="Nome da conexão (ex.: Vendas, Suporte)"
            className="focus-ring w-full rounded-card border border-border bg-transparent px-3 py-2 text-sm"
          />
          <OfficialFieldset values={newForm} onChange={setNewForm} />
          <div className="flex gap-2">
            <button
              onClick={() => newName.trim() && createMutation.mutate({ name: newName.trim(), official: newForm })}
              disabled={!newName.trim() || !newForm.phoneNumberId || !newForm.wabaId || !newForm.accessToken || createMutation.isPending}
              className="focus-ring flex-1 rounded-card bg-primary py-2 text-sm font-semibold text-primary-fg disabled:opacity-60"
            >
              Criar conexão
            </button>
            <button
              onClick={() => {
                setCreating(false);
                setNewName("");
                setNewForm(EMPTY_FORM);
              }}
              className="focus-ring rounded-card border border-border p-2 text-muted hover:bg-surface-alt"
              aria-label="Cancelar"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        </div>
      )}

      {officialConnections?.length === 0 && !creating && (
        <div className="rounded-card border border-dashed border-border p-8 text-center text-sm text-muted">
          Nenhuma conexão oficial cadastrada ainda.
        </div>
      )}

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
        {officialConnections?.map((connection) => (
          <div key={connection.id} className="shadow-soft flex flex-col rounded-card border border-border bg-surface p-5">
            <div className="mb-3 flex items-center justify-between gap-3">
              <div className="flex flex-wrap items-center gap-2">
                <span className="h-3 w-3 shrink-0 rounded-full" style={{ backgroundColor: connection.color }} title="Cor desta conexão" />
                <h3 className="text-sm font-semibold">{connection.name}</h3>
                <span className="flex items-center gap-1 rounded-full bg-primary/10 px-2 py-0.5 text-[10px] font-bold text-primary">
                  <KeyRound className="h-3 w-3" /> API Oficial
                </span>
                <span className="flex items-center gap-1 text-xs text-muted">
                  <Users className="h-3.5 w-3.5" /> {connection.agentCount}
                </span>
                {canEditar && (
                  <div className="flex items-center gap-1">
                    {COLOR_SWATCHES.map((swatch) => (
                      <button
                        key={swatch}
                        onClick={() => colorMutation.mutate({ id: connection.id, color: swatch })}
                        className="h-4 w-4 rounded-full ring-offset-1 focus-ring"
                        style={{ backgroundColor: swatch, boxShadow: connection.color === swatch ? `0 0 0 2px ${swatch}` : undefined }}
                        title={swatch}
                        aria-label={`Usar a cor ${swatch} para ${connection.name}`}
                      />
                    ))}
                  </div>
                )}
              </div>
              <div className="flex items-center gap-2">
                <span className={`rounded-full px-3 py-1 text-xs font-semibold ${STATE_COLOR[connection.state]}`}>{STATE_LABEL[connection.state]}</span>
                {canExcluir && connection.state !== "CONNECTED" && (
                  <button
                    onClick={() => deleteMutation.mutate(connection.id)}
                    disabled={connection.agentCount > 0}
                    title={connection.agentCount > 0 ? "Reatribua os atendentes antes de excluir" : "Excluir conexão"}
                    className="focus-ring rounded-full p-1.5 text-muted hover:bg-danger-soft hover:text-danger disabled:cursor-not-allowed disabled:opacity-40"
                    aria-label={`Excluir ${connection.name}`}
                  >
                    <Trash2 className="h-4 w-4" />
                  </button>
                )}
              </div>
            </div>

            <div className="mb-3">
              <WorkScheduleSelect
                value={connection.workScheduleId}
                disabled={!canEditar}
                label={`Horário de expediente de ${connection.name}`}
                onChange={(workScheduleId) => workScheduleMutation.mutate({ id: connection.id, workScheduleId })}
              />
            </div>

            {editingId === connection.id ? (
              <div className="space-y-3">
                <OfficialFieldset values={editForm} onChange={setEditForm} hasAccessToken={connection.hasAccessToken} hasAppSecret={connection.hasAppSecret} />
                <div className="flex gap-2">
                  <button
                    onClick={() => updateMutation.mutate({ id: connection.id, official: editForm })}
                    disabled={updateMutation.isPending}
                    className="focus-ring flex-1 rounded-card bg-primary py-2 text-sm font-semibold text-primary-fg disabled:opacity-60"
                  >
                    Salvar credenciais
                  </button>
                  <button onClick={() => setEditingId(null)} className="focus-ring rounded-card border border-border px-3 py-2 text-sm text-muted hover:bg-surface-alt">
                    Cancelar
                  </button>
                </div>
              </div>
            ) : (
              <div className="space-y-3">
                {connection.state === "CONNECTED" ? (
                  <div className="flex items-center gap-2 rounded-card bg-success-soft px-4 py-3 text-success">
                    <CheckCircle2 className="h-5 w-5" />
                    <div>
                      <p className="text-sm font-medium">Número: {connection.displayPhoneNumber ?? connection.connectedNumber}</p>
                      {connection.businessName && <p className="text-xs opacity-80">{connection.businessName}</p>}
                    </div>
                  </div>
                ) : (
                  <div className="rounded-card border border-dashed border-border p-4 text-center text-xs text-muted">
                    {connection.hasAccessToken ? "Credenciais salvas — teste a conexão para validar." : "Informe o Phone Number ID e o token de acesso para ativar."}
                  </div>
                )}

                <dl className="space-y-1 text-xs text-muted">
                  <div className="flex justify-between gap-2">
                    <dt>Phone Number ID</dt>
                    <dd className="font-mono text-text">{connection.phoneNumberId}</dd>
                  </div>
                  <div className="flex justify-between gap-2">
                    <dt>WABA ID</dt>
                    <dd className="font-mono text-text">{connection.wabaId}</dd>
                  </div>
                </dl>

                {canEditar && (
                  <div className="flex gap-2">
                    <button
                      onClick={() => testMutation.mutate(connection.id)}
                      disabled={testMutation.isPending || connection.state === "CONNECTING"}
                      className="focus-ring flex flex-1 items-center justify-center gap-1.5 rounded-card bg-primary py-2 text-sm font-semibold text-primary-fg disabled:opacity-60"
                    >
                      <CheckCircle2 className="h-4 w-4" /> Testar conexão
                    </button>
                    <button
                      onClick={() => {
                        setEditingId(connection.id);
                        setEditForm({
                          phoneNumberId: connection.phoneNumberId ?? "",
                          wabaId: connection.wabaId ?? "",
                          accessToken: "",
                          appSecret: "",
                          webhookVerifyToken: connection.webhookVerifyToken ?? "",
                        });
                      }}
                      className="focus-ring flex items-center gap-1.5 rounded-card border border-border px-3 py-2 text-sm font-medium hover:bg-surface-alt"
                    >
                      <Pencil className="h-4 w-4" /> Credenciais
                    </button>
                    {connection.state === "CONNECTED" && (
                      <button
                        onClick={() => disconnectMutation.mutate(connection.id)}
                        className="focus-ring flex items-center gap-1.5 rounded-card border border-danger/30 px-3 py-2 text-sm font-medium text-red-600 hover:bg-danger-soft"
                        title="Marca a conexão como desconectada (não revoga o token na Meta)"
                      >
                        <Plug className="h-4 w-4" />
                      </button>
                    )}
                  </div>
                )}
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

function OfficialFieldset({
  values,
  onChange,
  hasAccessToken,
  hasAppSecret,
}: {
  values: OfficialFormValues;
  onChange: (next: OfficialFormValues) => void;
  hasAccessToken?: boolean;
  hasAppSecret?: boolean;
}) {
  return (
    <div className="space-y-2">
      <label className="block">
        <span className="mb-1 block text-xs font-medium">Phone Number ID</span>
        <input
          value={values.phoneNumberId}
          onChange={(e) => onChange({ ...values, phoneNumberId: e.target.value })}
          className="focus-ring w-full rounded-card border border-border bg-transparent px-3 py-2 text-sm"
        />
      </label>
      <label className="block">
        <span className="mb-1 block text-xs font-medium">WhatsApp Business Account ID (WABA)</span>
        <input
          value={values.wabaId}
          onChange={(e) => onChange({ ...values, wabaId: e.target.value })}
          className="focus-ring w-full rounded-card border border-border bg-transparent px-3 py-2 text-sm"
        />
      </label>
      <label className="block">
        <span className="mb-1 block text-xs font-medium">Token de acesso {hasAccessToken && <span className="text-muted">(já configurado)</span>}</span>
        <input
          type="password"
          autoComplete="new-password"
          value={values.accessToken}
          onChange={(e) => onChange({ ...values, accessToken: e.target.value })}
          placeholder={hasAccessToken ? "•••••••• (deixe em branco para manter)" : ""}
          className="focus-ring w-full rounded-card border border-border bg-transparent px-3 py-2 text-sm"
        />
      </label>
      <label className="block">
        <span className="mb-1 block text-xs font-medium">
          App Secret {hasAppSecret && <span className="text-muted">(já configurado)</span>} <span className="text-muted">— usado para validar o webhook</span>
        </span>
        <input
          type="password"
          autoComplete="new-password"
          value={values.appSecret}
          onChange={(e) => onChange({ ...values, appSecret: e.target.value })}
          placeholder={hasAppSecret ? "•••••••• (deixe em branco para manter)" : ""}
          className="focus-ring w-full rounded-card border border-border bg-transparent px-3 py-2 text-sm"
        />
      </label>
      <label className="block">
        <span className="mb-1 block text-xs font-medium">Verify Token do webhook</span>
        <input
          value={values.webhookVerifyToken}
          onChange={(e) => onChange({ ...values, webhookVerifyToken: e.target.value })}
          placeholder="uma string qualquer, escolhida por você"
          className="focus-ring w-full rounded-card border border-border bg-transparent px-3 py-2 text-sm"
        />
      </label>
    </div>
  );
}
