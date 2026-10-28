import { useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { CheckCircle2, Plus, Trash2, XCircle } from "lucide-react";
import { api, getApiErrorMessage } from "../../lib/api";
import { WorkScheduleSelect } from "./WorkScheduleSelect";
import { MetaCredentialsGuideButton } from "./MetaCredentialsGuide";

interface MetaSettings {
  appId: string;
  webhookVerifyToken: string | null;
  hasAppSecret: boolean;
  hasPageAccessToken: boolean;
  hasIgAccessToken: boolean;
}

interface MetaConnectionRow {
  id: string;
  channel: "INSTAGRAM" | "MESSENGER";
  name: string;
  color: string;
  status: "DISCONNECTED" | "CONNECTED";
  externalPageId: string | null;
  workScheduleId: string | null;
}

/**
 * One App ID/Secret/token pair covers BOTH Instagram and Messenger (same
 * Meta App) — this panel is instantiated once per channel tab in
 * ConexoesPage, but the credentials form always edits the same shared
 * settings; only the token field shown and the connections list are
 * channel-specific. See PROMPT: "prepare tudo para integrar com Instagram
 * e Facebook" — this is the UI half of that; it still needs the user's own
 * Meta App/Page set up on developers.facebook.com before anything actually
 * connects.
 */
export function MetaConnectionPanel({ channel }: { channel: "INSTAGRAM" | "MESSENGER" }) {
  const queryClient = useQueryClient();
  const { data: settings } = useQuery({
    queryKey: ["meta-settings"],
    queryFn: async () => (await api.get<MetaSettings>("/settings/meta")).data,
  });
  const { data: connections } = useQuery({
    queryKey: ["meta-connections"],
    queryFn: async () => (await api.get<MetaConnectionRow[]>("/meta/connections")).data,
  });

  const [appId, setAppId] = useState("");
  const [appSecret, setAppSecret] = useState("");
  const [accessToken, setAccessToken] = useState("");
  const [webhookVerifyToken, setWebhookVerifyToken] = useState("");
  const initialized = useRef(false);
  if (settings && !initialized.current) {
    initialized.current = true;
    setAppId(settings.appId);
    setWebhookVerifyToken(settings.webhookVerifyToken ?? "");
  }

  const hasToken = channel === "INSTAGRAM" ? settings?.hasIgAccessToken : settings?.hasPageAccessToken;
  const tokenField = channel === "INSTAGRAM" ? "igAccessToken" : "pageAccessToken";
  const tokenLabel = channel === "INSTAGRAM" ? "Token de acesso do Instagram" : "Token de acesso da Página";
  const channelLabel = channel === "INSTAGRAM" ? "Instagram" : "Facebook Messenger";
  const webhookUrl = `${window.location.origin}/api/meta/webhook`;

  const saveMutation = useMutation({
    mutationFn: () =>
      api.patch("/settings/meta", {
        appId,
        appSecret: appSecret || undefined,
        [tokenField]: accessToken || undefined,
        webhookVerifyToken: webhookVerifyToken || null,
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["meta-settings"] });
      queryClient.invalidateQueries({ queryKey: ["meta-connections"] });
      setAppSecret("");
      setAccessToken("");
      toast.success("Credenciais salvas.");
    },
    onError: (err) => toast.error(getApiErrorMessage(err)),
  });

  const [newName, setNewName] = useState("");
  const [newExternalId, setNewExternalId] = useState("");
  const createMutation = useMutation({
    mutationFn: () => api.post("/meta/connections", { channel, name: newName, externalPageId: newExternalId }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["meta-connections"] });
      setNewName("");
      setNewExternalId("");
      toast.success("Conexão adicionada.");
    },
    onError: (err) => toast.error(getApiErrorMessage(err)),
  });
  const workScheduleMutation = useMutation({
    mutationFn: ({ id, workScheduleId }: { id: string; workScheduleId: string | null }) => api.patch(`/meta/connections/${id}`, { workScheduleId }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["meta-connections"] });
      queryClient.invalidateQueries({ queryKey: ["work-schedules"] });
    },
    onError: (err) => toast.error(getApiErrorMessage(err)),
  });
  const deleteMutation = useMutation({
    mutationFn: (id: string) => api.delete(`/meta/connections/${id}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["meta-connections"] });
      toast.success("Conexão removida.");
    },
    onError: (err) => toast.error(getApiErrorMessage(err)),
  });

  const channelConnections = connections?.filter((c) => c.channel === channel) ?? [];

  return (
    <div className="max-w-2xl space-y-6">
      <div className="shadow-soft rounded-card border border-border bg-surface p-5">
        <div className="mb-1 flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-base font-semibold">Credenciais do App da Meta</h2>
          <MetaCredentialsGuideButton webhookUrl={webhookUrl} />
        </div>
        <p className="mb-4 text-xs text-muted">
          Criadas em developers.facebook.com — o mesmo App cobre Instagram e Messenger. Cole a URL abaixo na
          configuração de Webhooks desse App.
        </p>
        <div className="mb-4 rounded-card border border-border bg-surface-alt px-3 py-2 font-mono text-xs">{webhookUrl}</div>

        <div className="space-y-3">
          <label className="block">
            <span className="mb-1 block text-sm font-medium">App ID</span>
            <input value={appId} onChange={(e) => setAppId(e.target.value)} className="focus-ring w-full rounded-card border border-border bg-transparent px-3 py-2 text-sm" />
          </label>
          <label className="block">
            <span className="mb-1 block text-sm font-medium">App Secret {settings?.hasAppSecret && <span className="text-muted">(já configurado)</span>}</span>
            <input
              type="password"
              autoComplete="new-password"
              value={appSecret}
              onChange={(e) => setAppSecret(e.target.value)}
              placeholder={settings?.hasAppSecret ? "•••••••• (deixe em branco para manter)" : ""}
              className="focus-ring w-full rounded-card border border-border bg-transparent px-3 py-2 text-sm"
            />
          </label>
          <label className="block">
            <span className="mb-1 block text-sm font-medium">{tokenLabel} {hasToken && <span className="text-muted">(já configurado)</span>}</span>
            <input
              type="password"
              autoComplete="new-password"
              value={accessToken}
              onChange={(e) => setAccessToken(e.target.value)}
              placeholder={hasToken ? "•••••••• (deixe em branco para manter)" : ""}
              className="focus-ring w-full rounded-card border border-border bg-transparent px-3 py-2 text-sm"
            />
          </label>
          <label className="block">
            <span className="mb-1 block text-sm font-medium">Verify Token do webhook</span>
            <input
              value={webhookVerifyToken}
              onChange={(e) => setWebhookVerifyToken(e.target.value)}
              placeholder="uma string qualquer, escolhida por você"
              className="focus-ring w-full rounded-card border border-border bg-transparent px-3 py-2 text-sm"
            />
          </label>
        </div>

        <button
          onClick={() => saveMutation.mutate()}
          disabled={saveMutation.isPending}
          className="focus-ring mt-4 rounded-card bg-primary px-4 py-2 text-sm font-semibold text-primary-fg disabled:opacity-60"
        >
          {saveMutation.isPending ? "Salvando..." : "Salvar credenciais"}
        </button>
      </div>

      <div className="shadow-soft rounded-card border border-border bg-surface p-5">
        <h2 className="mb-1 text-base font-semibold">Conexões de {channelLabel}</h2>
        <p className="mb-4 text-xs text-muted">
          {channel === "INSTAGRAM" ? "ID da conta comercial do Instagram vinculada." : "ID da Página do Facebook vinculada."}
        </p>

        <div className="mb-4 space-y-2">
          {channelConnections.map((c) => (
            <div key={c.id} className="rounded-card border border-border px-3 py-2">
              <div className="flex items-center gap-3">
              <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ backgroundColor: c.color }} />
              <span className="flex-1 text-sm font-medium">{c.name}</span>
              <span className="font-mono text-xs text-muted">{c.externalPageId}</span>
              <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${c.status === "CONNECTED" ? "bg-green-100 text-green-700" : "bg-gray-100 text-gray-600"}`}>
                {c.status === "CONNECTED" ? <CheckCircle2 className="mr-1 inline h-3 w-3" /> : <XCircle className="mr-1 inline h-3 w-3" />}
                {c.status === "CONNECTED" ? "Conectado" : "Desconectado"}
              </span>
              <button onClick={() => deleteMutation.mutate(c.id)} className="focus-ring rounded-full p-1.5 text-muted hover:bg-danger-soft hover:text-danger">
                <Trash2 className="h-4 w-4" />
              </button>
              </div>
              <div className="mt-2">
                <WorkScheduleSelect
                  value={c.workScheduleId}
                  label={`Horário de expediente de ${c.name}`}
                  onChange={(workScheduleId) => workScheduleMutation.mutate({ id: c.id, workScheduleId })}
                />
              </div>
            </div>
          ))}
          {channelConnections.length === 0 && <p className="text-sm text-muted">Nenhuma conexão cadastrada ainda.</p>}
        </div>

        <div className="flex flex-wrap items-end gap-2">
          <label className="min-w-[10rem] flex-1">
            <span className="mb-1 block text-xs font-medium">Nome</span>
            <input value={newName} onChange={(e) => setNewName(e.target.value)} className="focus-ring w-full rounded-card border border-border bg-transparent px-3 py-2 text-sm" />
          </label>
          <label className="min-w-[12rem] flex-1">
            <span className="mb-1 block text-xs font-medium">{channel === "INSTAGRAM" ? "ID da conta do Instagram" : "ID da Página"}</span>
            <input value={newExternalId} onChange={(e) => setNewExternalId(e.target.value)} className="focus-ring w-full rounded-card border border-border bg-transparent px-3 py-2 text-sm" />
          </label>
          <button
            onClick={() => createMutation.mutate()}
            disabled={createMutation.isPending || !newName.trim() || !newExternalId.trim()}
            className="focus-ring flex items-center gap-1 rounded-card border border-border px-3 py-2 text-sm font-medium hover:bg-surface-alt disabled:opacity-60"
          >
            <Plus className="h-4 w-4" />
            Adicionar
          </button>
        </div>
      </div>
    </div>
  );
}
