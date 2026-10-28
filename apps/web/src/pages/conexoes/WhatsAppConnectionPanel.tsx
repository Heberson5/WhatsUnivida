import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { format } from "date-fns";
import { BookUser, CheckCircle2, MessageCircle, Pencil, Plug, PlugZap, Plus, RefreshCw, Trash2, Users, X } from "lucide-react";
import { toast } from "sonner";
import { PERMISSION, type ConversationListItemDTO } from "@whatsatendende/types";
import { useAuthStore } from "../../store/auth-store";
import { api, getApiErrorMessage } from "../../lib/api";
import { getSocket } from "../../lib/socket";
import { WorkScheduleSelect } from "./WorkScheduleSelect";

const DEVICE_TIMEOUT_OPTIONS = [2, 5, 10, 15, 30, 60];

interface ConnectionSummary {
  id: string;
  name: string;
  color: string;
  connectionMode: "QRCODE" | "OFFICIAL_API";
  groupsEnabled: boolean;
  groupsCount: number;
  workScheduleId: string | null;
  deviceReplyTimeoutMinutes: number | null;
  state: "DISCONNECTED" | "CONNECTING" | "QR_PENDING" | "CODE_PENDING" | "CONNECTED";
  qrCodeDataUrl: string | null;
  pairingCode: string | null;
  pairingCodeExpiresAt: string | null;
  pairingPhoneNumber: string | null;
  connectedNumber: string | null;
  linkedNumber: string | null;
  lastConnectedAt: string | null;
  contactsSyncedAt: string | null;
  agentCount: number;
}

const STATE_LABEL: Record<string, string> = {
  DISCONNECTED: "Desconectado",
  CONNECTING: "Conectando",
  QR_PENDING: "Aguardando leitura do QR Code",
  CODE_PENDING: "Aguardando código de vinculação",
  CONNECTED: "Conectado",
};

const STATE_COLOR: Record<string, string> = {
  DISCONNECTED: "bg-danger-soft text-danger",
  CONNECTING: "bg-warning-soft text-warning",
  QR_PENDING: "bg-warning-soft text-warning",
  CODE_PENDING: "bg-warning-soft text-warning",
  CONNECTED: "bg-success-soft text-success",
};

// A curated set the admin can pick from with one click; the color input
// below still accepts any hex value for full control.
const COLOR_SWATCHES = ["#0097B4", "#7C3AED", "#F97316", "#059669", "#DC2626", "#2563EB", "#DB2777", "#65A30D"];

export function WhatsAppConnectionPanel() {
  const queryClient = useQueryClient();
  const permissions = useAuthStore((s) => s.permissions);
  const canAdicionar = permissions?.[PERMISSION.CONEXOES_WHATSAPP_ADICIONAR];
  const canEditar = permissions?.[PERMISSION.CONEXOES_WHATSAPP_EDITAR];
  const isAdmin = useAuthStore((s) => s.user?.role === "ADMIN");
  const canExcluir = permissions?.[PERMISSION.CONEXOES_WHATSAPP_EXCLUIR];
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [connectMode, setConnectMode] = useState<Record<string, "qr" | "code">>({});
  const [phoneInput, setPhoneInput] = useState<Record<string, string>>({});
  // The last pairing code shown per connection: a status read caught in the middle of WhatsApp's own reconnect
  // (it closes the socket right after handing out a code) comes without it — the code stays on screen
  // instead of flashing away. It goes once the phone links, or a new attempt starts.
  const [heldCodes, setHeldCodes] = useState<Record<string, HeldPairingCode>>({});

  const { data: connections } = useQuery({
    queryKey: ["whatsapp-connections"],
    queryFn: async () => (await api.get<ConnectionSummary[]>("/whatsapp/connections")).data,
    refetchInterval: (query) => {
      const list = query.state.data ?? [];
      const settling = list.some((c) => c.state === "CONNECTING" || c.state === "QR_PENDING" || c.state === "CODE_PENDING");
      return settling ? 2000 : false;
    },
  });

  useEffect(() => {
    if (!connections) return;
    setHeldCodes((prev) => {
      let next = prev;
      for (const c of connections) {
        const held = prev[c.id];
        if (c.pairingCode && (held?.code !== c.pairingCode || held.expiresAt !== c.pairingCodeExpiresAt)) {
          next = { ...next, [c.id]: { code: c.pairingCode, expiresAt: c.pairingCodeExpiresAt, phoneNumber: c.pairingPhoneNumber, lost: false } };
        } else if (!c.pairingCode && held && c.state === "CONNECTED") {
          next = withoutKey(next, c.id);
        } else if (!c.pairingCode && held && !held.lost && c.state === "DISCONNECTED") {
          next = { ...next, [c.id]: { ...held, lost: true } };
        }
      }
      return next;
    });
  }, [connections]);

  useEffect(() => {
    const socket = getSocket();
    if (!socket) return;
    const handler = () => queryClient.invalidateQueries({ queryKey: ["whatsapp-connections"] });
    const rejectionHandler = (payload: { scannedNumber: string; reason: "MISMATCH" | "ALREADY_LINKED"; expectedNumber?: string; otherConnectionName?: string }) => {
      const message =
        payload.reason === "ALREADY_LINKED"
          ? `Número já vinculado a outra conexão — vinculação recusada. O número ${payload.scannedNumber} já está vinculado à conexão "${payload.otherConnectionName}". Um mesmo número de WhatsApp não pode estar em duas conexões ao mesmo tempo — foi desconectado automaticamente.`
          : `Número diferente do original — vinculação recusada. Esta conexão já esteve vinculada ao número ${payload.expectedNumber}; o número ${payload.scannedNumber} foi desconectado automaticamente. Escaneie/vincule com o número original.`;
      toast.error(message, { duration: 10000 });
      queryClient.invalidateQueries({ queryKey: ["whatsapp-connections"] });
    };
    socket.on("whatsapp:status", handler);
    socket.on("whatsapp:pairing-rejected", rejectionHandler);
    return () => {
      socket.off("whatsapp:status", handler);
      socket.off("whatsapp:pairing-rejected", rejectionHandler);
    };
  }, [queryClient]);

  const createMutation = useMutation({
    mutationFn: (name: string) => api.post("/whatsapp/connections", { name }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["whatsapp-connections"] });
      setCreating(false);
      setNewName("");
      toast.success("Conexão criada.");
    },
    onError: (err) => toast.error(getApiErrorMessage(err)),
  });

  const renameMutation = useMutation({
    mutationFn: ({ id, name }: { id: string; name: string }) => api.patch(`/whatsapp/connections/${id}`, { name }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["whatsapp-connections"] });
      setRenamingId(null);
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

  const connectMutation = useMutation({
    mutationFn: ({ id, phoneNumber }: { id: string; phoneNumber?: string }) => api.post(`/whatsapp/connections/${id}/connect`, phoneNumber ? { phoneNumber } : {}),
    // A new attempt: the code kept from the previous one goes.
    onMutate: ({ id }) => setHeldCodes((prev) => withoutKey(prev, id)),
    onError: (err) => toast.error(getApiErrorMessage(err)),
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

  const deviceTimeoutMutation = useMutation({
    mutationFn: ({ id, minutes }: { id: string; minutes: number | null }) =>
      api.patch(`/whatsapp/connections/${id}`, { deviceReplyTimeoutMinutes: minutes }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["whatsapp-connections"] }),
    onError: (err) => toast.error(getApiErrorMessage(err)),
  });

  const colorMutation = useMutation({
    mutationFn: ({ id, color }: { id: string; color: string }) => api.patch(`/whatsapp/connections/${id}`, { color }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["whatsapp-connections"] }),
    onError: (err) => toast.error(getApiErrorMessage(err)),
  });
  const disconnectMutation = useMutation({
    mutationFn: (id: string) => api.post(`/whatsapp/connections/${id}/disconnect`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["whatsapp-connections"] }),
  });
  const syncContactsMutation = useMutation({
    mutationFn: async (id: string) => (await api.post<{ count: number; created: number }>(`/whatsapp/connections/${id}/sync-contacts`)).data,
    onSuccess: ({ count, created }) => {
      toast.success(
        `${count} ${count === 1 ? "contato carregado" : "contatos carregados"} do celular — ${
          created === 0 ? "nenhum novo; os que já estavam em Contatos ficaram como estão" : `${created} ${created === 1 ? "novo salvo" : "novos salvos"} em Contatos`
        }.`
      );
      queryClient.invalidateQueries({ queryKey: ["whatsapp-connections"] });
      queryClient.invalidateQueries({ queryKey: ["whatsapp-contacts"] });
      queryClient.invalidateQueries({ queryKey: ["contacts"] });
    },
    onError: (err) => toast.error(getApiErrorMessage(err)),
  });
  const reconnectMutation = useMutation({
    mutationFn: (id: string) => api.post(`/whatsapp/connections/${id}/reconnect`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["whatsapp-connections"] }),
  });

  // This endpoint is shared with the WhatsApp Oficial tab (same
  // WhatsAppConnection table) — only QRCODE rows belong on this screen,
  // whose controls (QR code, pairing code) make no sense for an
  // OFFICIAL_API row. See WhatsAppOfficialConnectionPanel.tsx for the mirror filter.
  const qrConnections = connections?.filter((c) => c.connectionMode === "QRCODE");
  // Same query (and key) as the menu's queue badge, so it's already cached.
  const { data: queue } = useQuery({
    queryKey: ["queue", "menu-badge"],
    queryFn: async () => (await api.get<ConversationListItemDTO[]>("/conversations/queue")).data,
  });
  const queueByConnection: Record<string, number> = {};
  for (const c of queue ?? []) queueByConnection[c.whatsappConnectionId] = (queueByConnection[c.whatsappConnectionId] ?? 0) + 1;

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h2 className="text-base font-semibold">Conexões de WhatsApp</h2>
          <p className="text-sm text-muted">Cada conexão é um número de WhatsApp independente. Nomeie-as e atribua atendentes a cada uma em Usuários.</p>
        </div>
        {canAdicionar && (
          <button
            onClick={() => setCreating(true)}
            className="focus-ring flex shrink-0 items-center gap-1.5 self-start rounded-card bg-primary px-3 py-2 text-sm font-semibold text-primary-fg hover:opacity-90"
          >
            <Plus className="h-4 w-4" /> Nova conexão
          </button>
        )}
      </div>

      {creating && canAdicionar && (
        <div className="shadow-soft flex max-w-md flex-col items-stretch gap-2 rounded-card border border-border bg-surface p-4 sm:max-w-lg sm:flex-row sm:items-center">
          <input
            autoFocus
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            placeholder="Nome da conexão (ex.: Suporte, Vendas)"
            className="focus-ring flex-1 rounded-card border border-border bg-transparent px-3 py-2 text-sm"
            onKeyDown={(e) => e.key === "Enter" && newName.trim() && createMutation.mutate(newName.trim())}
          />
          <button
            onClick={() => newName.trim() && createMutation.mutate(newName.trim())}
            disabled={!newName.trim() || createMutation.isPending}
            className="focus-ring rounded-card bg-primary px-3 py-2 text-sm font-semibold text-primary-fg disabled:opacity-60"
          >
            Criar
          </button>
          <button
            onClick={() => {
              setCreating(false);
              setNewName("");
            }}
            className="focus-ring rounded-card border border-border p-2 text-muted hover:bg-surface-alt"
            aria-label="Cancelar"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      )}

      {qrConnections?.length === 0 && !creating && (
        <div className="rounded-card border border-dashed border-border p-8 text-center text-sm text-muted">
          Nenhuma conexão de WhatsApp cadastrada ainda.
        </div>
      )}

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
        {qrConnections?.map((connection) => (
          <div
            key={connection.id}
            className={`shadow-soft flex flex-col rounded-card border bg-surface p-5 ${connection.state === "DISCONNECTED" ? "border-danger/40" : "border-border"}`}
          >
            <div className="mb-3 flex items-start justify-between gap-3">
              {renamingId === connection.id ? (
                <div className="flex flex-1 items-center gap-2">
                  <input
                    autoFocus
                    value={renameValue}
                    onChange={(e) => setRenameValue(e.target.value)}
                    className="focus-ring flex-1 rounded-card border border-border bg-transparent px-2 py-1 text-sm font-semibold"
                    onKeyDown={(e) => e.key === "Enter" && renameValue.trim() && renameMutation.mutate({ id: connection.id, name: renameValue.trim() })}
                  />
                  <button
                    onClick={() => renameValue.trim() && renameMutation.mutate({ id: connection.id, name: renameValue.trim() })}
                    className="focus-ring text-xs font-semibold text-primary"
                  >
                    Salvar
                  </button>
                  <button onClick={() => setRenamingId(null)} className="focus-ring text-xs text-muted">
                    Cancelar
                  </button>
                </div>
              ) : (
                <div className="flex min-w-0 flex-wrap items-center gap-2">
                  <span
                    className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-white"
                    style={{ backgroundColor: connection.color }}
                    title="Cor desta conexão"
                  >
                    <MessageCircle className="h-4 w-4" />
                  </span>
                  <span className="min-w-0">
                    <h3 className="truncate text-sm font-semibold">{connection.name}</h3>
                    <p className="text-xs text-muted">
                      {connection.connectedNumber ?? connection.linkedNumber ?? "Sem número vinculado"}
                      {queueByConnection[connection.id] ? ` · ${queueByConnection[connection.id]} na fila` : ""}
                    </p>
                  </span>
                  {canEditar && (
                    <button
                      onClick={() => {
                        setRenamingId(connection.id);
                        setRenameValue(connection.name);
                      }}
                      className="focus-ring rounded-full p-1 text-muted hover:bg-surface-alt"
                      aria-label={`Renomear ${connection.name}`}
                    >
                      <Pencil className="h-3.5 w-3.5" />
                    </button>
                  )}
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
              )}
              <div className="flex items-center gap-2">
                <span className={`inline-flex items-center gap-1.5 whitespace-nowrap rounded-full px-2.5 py-1 text-xs font-semibold ${STATE_COLOR[connection.state]}`}>
                  <span className="h-1.5 w-1.5 rounded-full bg-current" />
                  {STATE_LABEL[connection.state]}
                </span>
                {canEditar && (connection.state === "CONNECTING" || connection.state === "QR_PENDING" || connection.state === "CODE_PENDING") && (
                  <button
                    onClick={() => disconnectMutation.mutate(connection.id)}
                    className="focus-ring rounded-card border border-border px-2 py-1 text-xs font-medium text-muted hover:bg-surface-alt"
                    title="Cancela a tentativa de conexão em andamento"
                  >
                    Cancelar
                  </button>
                )}
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

            {connection.connectionMode === "QRCODE" && (
              <label className="mb-3 block">
                <span className="mb-1 block text-xs font-medium text-muted">Conversa iniciada pelo celular: se o cliente ficar sem resposta, vai para a fila após</span>
                <select
                  value={connection.deviceReplyTimeoutMinutes ?? ""}
                  disabled={!canEditar}
                  onChange={(e) => deviceTimeoutMutation.mutate({ id: connection.id, minutes: e.target.value ? Number(e.target.value) : null })}
                  className="focus-ring w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm"
                >
                  {DEVICE_TIMEOUT_OPTIONS.map((m) => (
                    <option key={m} value={m}>
                      {m} minutos
                    </option>
                  ))}
                  <option value="">Nunca (fica só no celular)</option>
                </select>
              </label>
            )}

            {connection.state === "CONNECTED" ? (
              <div className="space-y-3">
                <div className="flex items-center gap-2 rounded-card bg-success-soft px-4 py-3 text-success">
                  <CheckCircle2 className="h-5 w-5" />
                  <div>
                    <p className="text-sm font-medium">Número conectado: {connection.connectedNumber}</p>
                    {connection.lastConnectedAt && (
                      <p className="text-xs opacity-80">Desde {format(new Date(connection.lastConnectedAt), "dd/MM/yyyy HH:mm")}</p>
                    )}
                  </div>
                </div>
                <div className="rounded-card border border-border px-3 py-2.5">
                  <p className="text-sm font-medium">Contatos salvos no celular</p>
                  <p className="text-xs text-muted">
                    {connection.contactsSyncedAt
                      ? `Última carga em ${format(new Date(connection.contactsSyncedAt), "dd/MM/yyyy HH:mm")}.`
                      : "Ainda não foram carregados."}{" "}
                    Carregam sozinhos toda segunda-feira à meia-noite; use o botão para carregar agora.
                  </p>
                  {canEditar && (
                    <button
                      onClick={() => syncContactsMutation.mutate(connection.id)}
                      disabled={syncContactsMutation.isPending}
                      className="focus-ring mt-2 flex items-center gap-1.5 rounded-card border border-border px-3 py-1.5 text-sm font-medium hover:bg-surface-alt disabled:opacity-60"
                    >
                      <BookUser className="h-4 w-4" />
                      {syncContactsMutation.isPending && syncContactsMutation.variables === connection.id ? "Carregando..." : "Carregar contatos agora"}
                    </button>
                  )}
                </div>
                {isAdmin && <GroupsToggle connection={connection} />}
                {canEditar && (
                  <div className="flex gap-2">
                    <button
                      onClick={() => reconnectMutation.mutate(connection.id)}
                      className="focus-ring flex items-center gap-1.5 rounded-card border border-border px-4 py-2 text-sm font-medium hover:bg-surface-alt"
                    >
                      <RefreshCw className="h-4 w-4" /> Reconectar
                    </button>
                    <button
                      onClick={() => disconnectMutation.mutate(connection.id)}
                      className="focus-ring flex items-center gap-1.5 rounded-card border border-danger/30 px-4 py-2 text-sm font-medium text-red-600 hover:bg-danger-soft"
                    >
                      <Plug className="h-4 w-4" /> Desconectar
                    </button>
                  </div>
                )}
              </div>
            ) : (
              <div className="space-y-4">
                {connection.linkedNumber && (
                  <p className="rounded-card bg-secondary/30 px-3 py-2 text-xs text-text">
                    Esta conexão já esteve vinculada ao número <strong>{connection.linkedNumber}</strong>. Vincule novamente com o mesmo
                    número — um número diferente é recusado automaticamente, para não misturar o histórico desta conexão com outra conta.
                  </p>
                )}
                {connection.qrCodeDataUrl ? (
                  <div className="flex flex-col items-center gap-3 rounded-card border border-dashed border-border p-6">
                    {connection.qrCodeDataUrl.startsWith("data:") ? (
                      <img src={connection.qrCodeDataUrl} alt={`QR Code de ${connection.name}`} className="h-48 w-48" />
                    ) : (
                      <div className="flex h-48 w-48 items-center justify-center break-all bg-surface-alt p-4 text-center text-[10px] text-muted">
                        {connection.qrCodeDataUrl}
                        <br />
                        (simulação — provider mock)
                      </div>
                    )}
                    <p className="text-center text-sm text-muted">Abra o WhatsApp no celular, toque em Aparelhos conectados e escaneie o código.</p>
                  </div>
                ) : heldCodes[connection.id] && !heldCodes[connection.id].lost && connection.state !== "QR_PENDING" ? (
                  <PairingCodeCard
                    held={heldCodes[connection.id]}
                    canRegenerate={Boolean(canEditar && heldCodes[connection.id].phoneNumber)}
                    regenerating={connectMutation.isPending && connectMutation.variables?.id === connection.id}
                    onRegenerate={() => connectMutation.mutate({ id: connection.id, phoneNumber: heldCodes[connection.id].phoneNumber ?? undefined })}
                  />
                ) : heldCodes[connection.id]?.lost ? (
                  <div className="space-y-2 rounded-card border border-dashed border-warning/50 bg-warning-soft/40 p-4 text-center text-sm">
                    <p>O WhatsApp encerrou esta tentativa antes do código ser digitado no celular.</p>
                    {canEditar && heldCodes[connection.id].phoneNumber && (
                      <button
                        onClick={() => connectMutation.mutate({ id: connection.id, phoneNumber: heldCodes[connection.id].phoneNumber ?? undefined })}
                        disabled={connectMutation.isPending}
                        className="focus-ring inline-flex items-center gap-1.5 rounded-card bg-primary px-3 py-1.5 text-xs font-semibold text-primary-fg disabled:opacity-60"
                      >
                        <RefreshCw className="h-3.5 w-3.5" /> Gerar novo código
                      </button>
                    )}
                  </div>
                ) : (
                  <div className="rounded-card border border-dashed border-border p-6 text-center text-sm text-muted">
                    {connection.state === "CONNECTING" ? "Gerando..." : "Nenhuma sessão ativa."}
                  </div>
                )}

                {canEditar && !(heldCodes[connection.id] && !heldCodes[connection.id].lost) && (
                <div className="flex gap-1 rounded-card border border-border p-1 text-xs font-medium">
                  <button
                    onClick={() => setConnectMode((m) => ({ ...m, [connection.id]: "qr" }))}
                    className={`flex-1 rounded-card py-1.5 ${(connectMode[connection.id] ?? "qr") === "qr" ? "bg-primary text-primary-fg" : "text-muted"}`}
                  >
                    QR Code
                  </button>
                  <button
                    onClick={() => setConnectMode((m) => ({ ...m, [connection.id]: "code" }))}
                    className={`flex-1 rounded-card py-1.5 ${connectMode[connection.id] === "code" ? "bg-primary text-primary-fg" : "text-muted"}`}
                  >
                    Conectar com número
                  </button>
                </div>
                )}

                {canEditar && !(heldCodes[connection.id] && !heldCodes[connection.id].lost) && (connectMode[connection.id] === "code" ? (
                  <div className="flex gap-2">
                    <input
                      value={phoneInput[connection.id] ?? ""}
                      onChange={(e) => setPhoneInput((p) => ({ ...p, [connection.id]: e.target.value }))}
                      placeholder="Número com DDI e DDD (ex.: 5511999999999)"
                      className="focus-ring flex-1 rounded-card border border-border bg-transparent px-3 py-2 text-sm"
                    />
                    <button
                      onClick={() => connectMutation.mutate({ id: connection.id, phoneNumber: phoneInput[connection.id] })}
                      disabled={connectMutation.isPending || connection.state === "CONNECTING" || !(phoneInput[connection.id] ?? "").trim()}
                      className="focus-ring flex shrink-0 items-center justify-center gap-2 rounded-card bg-primary px-4 py-2 text-sm font-semibold text-primary-fg disabled:opacity-60"
                    >
                      <PlugZap className="h-4 w-4" /> Gerar código
                    </button>
                  </div>
                ) : (
                  <button
                    onClick={() => connectMutation.mutate({ id: connection.id })}
                    disabled={connectMutation.isPending || connection.state === "CONNECTING"}
                    className="focus-ring flex w-full items-center justify-center gap-2 rounded-card bg-primary py-2.5 text-sm font-semibold text-primary-fg disabled:opacity-60"
                  >
                    <PlugZap className="h-4 w-4" /> Conectar WhatsApp
                  </button>
                ))}
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

/** Atendimento's Grupos tab for this number — administrators only; off by default. */
function GroupsToggle({ connection }: { connection: ConnectionSummary }) {
  const queryClient = useQueryClient();
  const toggle = useMutation({
    mutationFn: (enabled: boolean) => api.patch(`/whatsapp/connections/${connection.id}/groups`, { enabled }),
    onSuccess: (_res, enabled) => {
      queryClient.invalidateQueries({ queryKey: ["whatsapp-connections"] });
      queryClient.invalidateQueries({ queryKey: ["groups"] });
      toast.success(enabled ? "Grupos ligados: já aparecem na aba Grupos do Atendimento." : "Grupos desligados para este número.");
    },
    onError: (err) => toast.error(getApiErrorMessage(err)),
  });
  const on = connection.groupsEnabled;
  return (
    <div className="rounded-card border border-border px-3 py-2.5" data-groups-toggle>
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-sm font-medium">Grupos do WhatsApp</p>
          <p className="text-xs text-muted">
            {on
              ? "Os grupos deste número aparecem na aba Grupos do Atendimento, para todos que atendem esta conexão. Cada pessoa tem a sua leitura."
              : "Desligado: as mensagens de grupos deste número não entram no sistema."}
          </p>
        </div>
        <button
          role="switch"
          aria-checked={on}
          aria-label="Receber grupos do WhatsApp"
          disabled={toggle.isPending}
          onClick={() => toggle.mutate(!on)}
          className={"focus-ring relative mt-0.5 inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors disabled:opacity-60 " + (on ? "bg-primary" : "bg-border")}
        >
          <span className={"inline-block h-4 w-4 rounded-full bg-white shadow transition-transform " + (on ? "translate-x-4" : "translate-x-0.5")} />
        </button>
      </div>
      {on && (
        <p className="mt-1.5 text-[11.5px] text-muted">
          {connection.groupsCount} {connection.groupsCount === 1 ? "grupo encontrado" : "grupos encontrados"} neste número · quem vê e quem responde é definido em Perfis de acesso.
        </p>
      )}
    </div>
  );
}

interface HeldPairingCode {
  code: string;
  expiresAt: string | null;
  phoneNumber: string | null;
  /** The attempt ended (WhatsApp gave up) while this code was on screen. */
  lost: boolean;
}

/**
 * The pairing code, as WhatsApp Web shows it: it stays on screen with the time it is still valid for, and when it
 * expires the next one takes its place — no blank in between.
 */
function PairingCodeCard({
  held,
  canRegenerate,
  regenerating,
  onRegenerate,
}: {
  held: HeldPairingCode;
  canRegenerate: boolean;
  regenerating: boolean;
  onRegenerate: () => void;
}) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  const secondsLeft = held.expiresAt ? Math.max(0, Math.ceil((new Date(held.expiresAt).getTime() - now) / 1000)) : null;
  const clock = secondsLeft === null ? null : `${Math.floor(secondsLeft / 60)}:${String(secondsLeft % 60).padStart(2, "0")}`;

  async function copy() {
    try {
      await navigator.clipboard.writeText(held.code.replace("-", ""));
      toast.success("Código copiado.");
    } catch {
      toast.error("Não foi possível copiar — digite o código no celular.");
    }
  }

  return (
    <div className="flex flex-col items-center gap-3 rounded-card border border-dashed border-border p-5" data-testid="pairing-code">
      <p className="text-xs font-semibold uppercase tracking-wide text-muted">Código de conexão</p>
      <div className="flex gap-1" role="text" aria-label={`Código ${held.code}`}>
        {held.code.split("").map((ch, i) =>
          ch === "-" ? (
            <span key={i} className="self-center px-0.5 text-xl font-bold text-muted" aria-hidden>
              –
            </span>
          ) : (
            <span key={i} className="flex h-10 w-7 items-center justify-center rounded-md border border-border bg-surface-alt font-mono text-xl font-bold text-primary" aria-hidden>
              {ch}
            </span>
          )
        )}
      </div>
      {clock !== null && (
        <p className="text-center text-xs text-muted" aria-live="polite">
          {secondsLeft! > 0 ? (
            <>
              Válido por mais <strong className="tabular-nums text-[var(--color-text)]">{clock}</strong> — quando acabar, um novo código aparece aqui no lugar deste.
            </>
          ) : (
            "Trocando pelo próximo código..."
          )}
        </p>
      )}
      <div className="flex flex-wrap justify-center gap-2">
        <button onClick={copy} className="focus-ring rounded-card border border-border px-3 py-1.5 text-xs font-medium hover:bg-surface-alt">
          Copiar código
        </button>
        {canRegenerate && (
          <button
            onClick={onRegenerate}
            disabled={regenerating}
            className="focus-ring rounded-card border border-border px-3 py-1.5 text-xs font-medium hover:bg-surface-alt disabled:opacity-60"
          >
            {regenerating ? "Gerando..." : "Gerar novo código"}
          </button>
        )}
      </div>
      <ol className="list-decimal space-y-0.5 pl-5 text-left text-sm text-muted">
        <li>No celular, abra o WhatsApp &gt; Aparelhos conectados &gt; Conectar um aparelho.</li>
        <li>Toque em Conectar com número de telefone.</li>
        <li>Digite este código no celular.</li>
      </ol>
    </div>
  );
}

function withoutKey<T>(record: Record<string, T>, key: string): Record<string, T> {
  const copy = { ...record };
  delete copy[key];
  return copy;
}
