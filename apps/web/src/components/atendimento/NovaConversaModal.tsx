import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Search, UserPlus, X } from "lucide-react";
import { toast } from "sonner";
import type { ConversationListItemDTO, WhatsAppDeviceContactDTO } from "@whatsunivida/types";
import { api, getApiErrorMessage } from "../../lib/api";

interface ConnectionOption {
  id: string;
  name: string;
}

/** Start a new conversation from a contact saved on the connection's linked phone — see PROMPT: "adicionar uma nova conversa através dos contatos salvos no celular de cada instância". */
export function NovaConversaModal({
  fixedConnectionId,
  onClose,
  onStarted,
}: {
  /** The agent's own connection, when they have one — hides the connection picker. Null/undefined means the caller (MANAGER/ADMIN) must pick one. */
  fixedConnectionId: string | null | undefined;
  onClose: () => void;
  onStarted: (conversation: ConversationListItemDTO) => void;
}) {
  const [connectionId, setConnectionId] = useState<string | null>(fixedConnectionId ?? null);
  const [search, setSearch] = useState("");
  const [manualPhone, setManualPhone] = useState("");
  const [manualName, setManualName] = useState("");
  const [mode, setMode] = useState<"contacts" | "manual">("contacts");

  const { data: connections } = useQuery({
    queryKey: ["whatsapp-connections"],
    queryFn: async () => (await api.get<ConnectionOption[]>("/whatsapp/connections")).data,
    enabled: !fixedConnectionId,
  });

  const { data: contacts, isLoading } = useQuery({
    queryKey: ["whatsapp-contacts", connectionId],
    queryFn: async () => (await api.get<WhatsAppDeviceContactDTO[]>(`/whatsapp/connections/${connectionId}/contacts`)).data,
    enabled: Boolean(connectionId),
  });

  const startMutation = useMutation({
    mutationFn: (payload: { phone: string; name: string | null }) =>
      api.post<ConversationListItemDTO>("/conversations/start", { connectionId: connectionId ?? undefined, phone: payload.phone, name: payload.name }),
    onSuccess: (res) => {
      toast.success("Conversa iniciada.");
      onStarted(res.data);
    },
    onError: (err) => toast.error(getApiErrorMessage(err)),
  });

  const filtered = (contacts ?? []).filter((c) => {
    const q = search.trim().toLowerCase();
    if (!q) return true;
    return (c.name ?? "").toLowerCase().includes(q) || c.phone.includes(q);
  });

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-4">
      <div className="flex max-h-[80vh] w-full max-w-md flex-col rounded-card border border-border bg-surface p-5 shadow-elevated">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-base font-semibold">Nova conversa</h2>
          <button onClick={onClose} className="focus-ring rounded-full p-1 text-muted hover:bg-surface-alt" aria-label="Fechar">
            <X className="h-5 w-5" />
          </button>
        </div>

        {!fixedConnectionId && (
          <label className="mb-3 block text-sm">
            <span className="mb-1 block font-medium">Conexão de WhatsApp</span>
            <select
              value={connectionId ?? ""}
              onChange={(e) => setConnectionId(e.target.value || null)}
              className="focus-ring w-full rounded-card border border-border bg-transparent px-3 py-2 text-sm"
            >
              <option value="">Selecione...</option>
              {connections?.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </label>
        )}

        <div className="mb-3 flex gap-1 rounded-card border border-border p-1 text-xs font-medium">
          <button
            onClick={() => setMode("contacts")}
            className={`flex-1 rounded-card py-1.5 ${mode === "contacts" ? "bg-primary text-primary-fg" : "text-muted"}`}
          >
            Contatos salvos
          </button>
          <button
            onClick={() => setMode("manual")}
            className={`flex-1 rounded-card py-1.5 ${mode === "manual" ? "bg-primary text-primary-fg" : "text-muted"}`}
          >
            Novo número
          </button>
        </div>

        {mode === "contacts" ? (
          <>
            <div className="relative mb-3">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted" />
              <input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Buscar por nome ou telefone..."
                disabled={!connectionId}
                className="focus-ring w-full rounded-card border border-border bg-transparent py-2 pl-9 pr-3 text-sm disabled:opacity-50"
              />
            </div>
            <div className="min-h-[160px] flex-1 space-y-1 overflow-y-auto">
              {!connectionId && <p className="py-8 text-center text-sm text-muted">Selecione uma conexão para ver os contatos.</p>}
              {connectionId && isLoading && <p className="py-8 text-center text-sm text-muted">Carregando contatos...</p>}
              {connectionId && !isLoading && filtered.length === 0 && (
                <p className="py-8 text-center text-sm text-muted">Nenhum contato encontrado. A conexão precisa estar conectada.</p>
              )}
              {filtered.map((c) => (
                <button
                  key={c.phone}
                  onClick={() => startMutation.mutate({ phone: c.phone, name: c.name })}
                  disabled={startMutation.isPending}
                  className="focus-ring flex w-full items-center gap-3 rounded-card px-3 py-2 text-left hover:bg-surface-alt disabled:opacity-60"
                >
                  <div className="flex h-9 w-9 items-center justify-center rounded-full bg-surface-alt text-xs font-semibold text-muted">
                    {(c.name ?? c.phone).slice(0, 2).toUpperCase()}
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium">{c.name ?? c.phone}</p>
                    <p className="text-xs text-muted">{c.phone}</p>
                  </div>
                </button>
              ))}
            </div>
          </>
        ) : (
          <div className="space-y-3">
            <label className="block text-sm">
              <span className="mb-1 block font-medium">Número (com DDI e DDD)</span>
              <input
                value={manualPhone}
                onChange={(e) => setManualPhone(e.target.value)}
                placeholder="5511999999999"
                className="focus-ring w-full rounded-card border border-border bg-transparent px-3 py-2 text-sm"
              />
            </label>
            <label className="block text-sm">
              <span className="mb-1 block font-medium">Nome (opcional)</span>
              <input
                value={manualName}
                onChange={(e) => setManualName(e.target.value)}
                className="focus-ring w-full rounded-card border border-border bg-transparent px-3 py-2 text-sm"
              />
            </label>
            <button
              onClick={() => manualPhone.trim() && startMutation.mutate({ phone: manualPhone.trim(), name: manualName.trim() || null })}
              disabled={!manualPhone.trim() || !connectionId || startMutation.isPending}
              className="focus-ring flex w-full items-center justify-center gap-2 rounded-card bg-primary py-2.5 text-sm font-semibold text-primary-fg disabled:opacity-60"
            >
              <UserPlus className="h-4 w-4" /> {startMutation.isPending ? "Iniciando..." : "Iniciar conversa"}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
