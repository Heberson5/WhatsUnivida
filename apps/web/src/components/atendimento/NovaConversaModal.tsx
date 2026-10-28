import { useEffect, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { AlertTriangle, CheckCircle2, Info, Loader2, Phone, Search, UserPlus, X, XCircle } from "lucide-react";
import { toast } from "sonner";
import {
  PERMISSION,
  normalizeTypedPhone,
  type ContactListItemDTO,
  type ConversationListItemDTO,
  type PhoneLookupDTO,
  type WhatsAppDeviceContactDTO,
} from "@whatsatendende/types";
import { api, getApiErrorMessage } from "../../lib/api";
import { formatPhone } from "../../lib/format-phone";
import { usePhoneSettings } from "../../hooks/usePhoneSettings";
import { useAuthStore } from "../../store/auth-store";

interface ConnectionOption {
  id: string;
  name: string;
}

/** One person to start a conversation with — from the system's Contatos, the linked phone's address book, or both. */
interface ContactOption {
  phone: string;
  name: string | null;
  connectionId: string | null;
  connectionName: string | null;
}

const SEARCH_DEBOUNCE_MS = 250;

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
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const canSearchContacts = Boolean(useAuthStore((s) => s.permissions?.[PERMISSION.CONTATOS_ACESSAR]));
  useEffect(() => {
    const timer = setTimeout(() => setDebouncedSearch(search.trim()), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [search]);

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

  // The system's Contatos, searched on the server as you type — works before a connection is picked (it says which one).
  const { data: systemContacts, isFetching: searchingSystem } = useQuery({
    queryKey: ["nova-conversa-contacts", debouncedSearch, connectionId],
    queryFn: async () =>
      (
        await api.get<{ items: ContactListItemDTO[] }>("/contacts", {
          params: { search: debouncedSearch || undefined, connectionId: connectionId ?? undefined, pageSize: 30, sort: "name", dir: "asc" },
        })
      ).data,
    enabled: canSearchContacts && (Boolean(connectionId) || debouncedSearch.length > 0),
    placeholderData: (previous) => previous,
  });

  const startMutation = useMutation({
    mutationFn: (payload: { phone: string; name: string | null; connectionId?: string | null }) =>
      api.post<ConversationListItemDTO>("/conversations/start", { connectionId: payload.connectionId ?? connectionId ?? undefined, phone: payload.phone, name: payload.name }),
    onSuccess: (res) => {
      toast.success("Conversa iniciada.");
      onStarted(res.data);
    },
    onError: (err) => toast.error(getApiErrorMessage(err)),
  });

  const { data: phoneSettings } = usePhoneSettings();
  const manualDigits = manualPhone.replace(/\D/g, "");
  // Validates a typed number against WhatsApp itself (one bounded lookup —
  // see PROMPT: "buscar no celular somente o que digitar, pelo número")
  // instead of silently letting a typo start a "conversation" with a
  // number that isn't even on WhatsApp. Only runs once the number looks
  // plausible, and never blocks starting while it's still pending/errored
  // — only an explicit "not found" holds the button back.
  const numberLookup = useQuery({
    queryKey: ["whatsapp-number-lookup", connectionId, manualDigits],
    queryFn: async () =>
      (await api.get<PhoneLookupDTO>(`/whatsapp/connections/${connectionId}/lookup-number`, { params: { phone: manualDigits } })).data,
    enabled: mode === "manual" && Boolean(connectionId) && manualDigits.length >= 10,
  });
  // Only a number WhatsApp confirms can start — or, on a WhatsApp Oficial connection with no QR Code connection to
  // ask through, one that can't be checked at all. WhatsApp not answering right now blocks it until it does.
  const numberConfirmedMissing = mode === "manual" && numberLookup.isSuccess && numberLookup.data.exists === false;
  const numberConfirmed = numberLookup.isSuccess && numberLookup.data.exists === true;
  const numberUnverifiable = numberLookup.isSuccess && numberLookup.data.unverifiable;
  const numberUnanswered = !numberLookup.isFetching && (numberLookup.isError || (numberLookup.isSuccess && numberLookup.data.exists === null && !numberLookup.data.unverifiable));
  const canStartManual = numberConfirmed || numberUnverifiable;
  // What the conversation will use: the number WhatsApp confirmed, or else the typed one after Configurações › Números de telefone.
  const numberToUse = numberConfirmed && numberLookup.data?.phone ? numberLookup.data.phone : phoneSettings ? normalizeTypedPhone(manualPhone, phoneSettings).phone : null;
  const defaultCountryCode = phoneSettings?.defaultCountryCodeEnabled ? phoneSettings.defaultCountryCode : null;

  const q = search.trim().toLowerCase();
  const searchDigits = q.replace(/\D/g, "");
  const connectionName = connections?.find((c) => c.id === connectionId)?.name ?? null;
  // Numbers are searched by digits, so "(11) 98765" and "11987" both match.
  const matches = (name: string | null, phone: string) => !q || (name ?? "").toLowerCase().includes(q) || (searchDigits.length > 0 && phone.includes(searchDigits));
  const byKey = new Map<string, ContactOption>();
  for (const c of systemContacts?.items ?? []) {
    if (c.channel !== "WHATSAPP" || !c.phone) continue;
    byKey.set(`${c.whatsappConnectionId}:${c.phone}`, { phone: c.phone, name: c.name, connectionId: c.whatsappConnectionId, connectionName: c.connectionName });
  }
  for (const c of contacts ?? []) {
    if (!matches(c.name, c.phone)) continue;
    const key = `${connectionId}:${c.phone}`;
    const known = byKey.get(key);
    // The name saved on the phone wins, as in the list of the phone's own contacts.
    byKey.set(key, { phone: c.phone, name: c.name ?? known?.name ?? null, connectionId, connectionName });
  }
  const filtered = [...byKey.values()].sort((a, b) => (a.name ?? a.phone).localeCompare(b.name ?? b.phone, "pt-BR", { sensitivity: "base" }));
  // A typed number that isn't in the list can still be started right away.
  const typedNumber = searchDigits.length >= 10 && searchDigits.length === q.replace(/[\s()+-]/g, "").length ? searchDigits : null;
  const listLoading = (Boolean(connectionId) && isLoading) || (searchingSystem && filtered.length === 0);

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
            Contatos
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
                placeholder="Digite o nome ou o número..."
                disabled={!connectionId && !canSearchContacts}
                autoFocus
                aria-label="Buscar contato por nome ou número"
                className="focus-ring w-full rounded-card border border-border bg-transparent py-2 pl-9 pr-3 text-sm disabled:opacity-50"
              />
            </div>
            <div className="min-h-[160px] flex-1 space-y-1 overflow-y-auto">
              {!connectionId && !q && (
                <p className="py-8 text-center text-sm text-muted">
                  {canSearchContacts ? "Digite o nome ou o número do contato, ou selecione uma conexão para ver a lista." : "Selecione uma conexão para ver os contatos."}
                </p>
              )}
              {listLoading && <p className="py-8 text-center text-sm text-muted">Carregando contatos...</p>}
              {(connectionId || q) && !listLoading && filtered.length === 0 && !typedNumber && (
                <p className="py-8 text-center text-sm text-muted">Nenhum contato encontrado. Se o número não está salvo, digite o número ou use a aba “Novo número”.</p>
              )}
              {typedNumber && !filtered.some((c) => c.phone.endsWith(typedNumber.slice(-8))) && (
                <button
                  onClick={() => {
                    setManualPhone(search.trim());
                    setMode("manual");
                  }}
                  className="focus-ring flex w-full items-center gap-3 rounded-card border border-dashed border-primary/40 px-3 py-2 text-left hover:bg-primary/5"
                >
                  <div className="flex h-9 w-9 items-center justify-center rounded-full bg-primary/10 text-primary">
                    <Phone className="h-4 w-4" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium">Iniciar conversa com {formatPhone(typedNumber)}</p>
                    <p className="text-xs text-muted">Número que não está nos contatos</p>
                  </div>
                </button>
              )}
              {filtered.map((c) => (
                <button
                  key={`${c.connectionId}:${c.phone}`}
                  onClick={() => startMutation.mutate({ phone: c.phone, name: c.name, connectionId: c.connectionId })}
                  disabled={startMutation.isPending}
                  className="focus-ring flex w-full items-center gap-3 rounded-card px-3 py-2 text-left hover:bg-surface-alt disabled:opacity-60"
                >
                  <div className="flex h-9 w-9 items-center justify-center rounded-full bg-surface-alt text-xs font-semibold text-muted">
                    {(c.name ?? c.phone).slice(0, 2).toUpperCase()}
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium">{c.name ?? formatPhone(c.phone)}</p>
                    <p className="truncate text-xs tabular-nums text-muted">
                      {c.name && formatPhone(c.phone)}
                      {!fixedConnectionId && c.connectionName && <span className="font-sans">{c.name ? " · " : ""}{c.connectionName}</span>}
                    </p>
                  </div>
                </button>
              ))}
            </div>
          </>
        ) : (
          <div className="space-y-3">
            <label className="block text-sm">
              <span className="mb-1 block font-medium">
                {!phoneSettings ? "Número" : defaultCountryCode ? "Número (DDI opcional)" : "Número (com DDI e DDD)"}
              </span>
              <input
                value={manualPhone}
                onChange={(e) => setManualPhone(e.target.value)}
                disabled={!connectionId}
                placeholder={!phoneSettings ? "" : defaultCountryCode ? "65 99999-9999" : "5511999999999"}
                className="focus-ring w-full rounded-card border border-border bg-transparent px-3 py-2 text-sm"
              />
              {defaultCountryCode && <p className="mt-1 text-xs text-muted">Sem o DDI, usamos +{defaultCountryCode}.</p>}
              {manualDigits.length >= 10 && connectionId && (
                <div className="mt-1.5 space-y-1 text-xs">
                  {numberToUse && numberToUse !== manualDigits && (
                    <p className="text-muted">
                      Será usado: <span className="font-medium tabular-nums text-[var(--color-text)]">{formatPhone(numberToUse)}</span>
                    </p>
                  )}
                  <p className="flex items-center gap-1.5">
                    {numberLookup.isFetching ? (
                      <>
                        <Loader2 className="h-3.5 w-3.5 animate-spin text-muted" /> <span className="text-muted">Verificando no WhatsApp...</span>
                      </>
                    ) : numberConfirmedMissing ? (
                      <>
                        <XCircle className="h-3.5 w-3.5 text-red-500" />{" "}
                        <span className="text-red-600">
                          Este número não está no WhatsApp
                          {numberLookup.data?.normalizedPhone ? ` (conferido: ${formatPhone(numberLookup.data.normalizedPhone)})` : ""}.
                        </span>
                      </>
                    ) : numberConfirmed ? (
                      <>
                        <CheckCircle2 className="h-3.5 w-3.5 text-green-500" />{" "}
                        <span className="text-green-700">
                          Número com WhatsApp
                          {numberLookup.data?.checkedByConnectionName ? ` (verificado pela conexão ${numberLookup.data.checkedByConnectionName})` : ""}.
                        </span>
                      </>
                    ) : numberUnverifiable ? (
                      <>
                        <Info className="h-3.5 w-3.5 shrink-0 text-muted" />{" "}
                        <span className="text-muted">Não há conexão de QR Code conectada para verificar o número. A conversa pode ser iniciada sem verificação.</span>
                      </>
                    ) : numberUnanswered ? (
                      <>
                        <AlertTriangle className="h-3.5 w-3.5 shrink-0 text-warning" />{" "}
                        <span className="text-warning">Não foi possível verificar o número agora.</span>
                        <button type="button" onClick={() => numberLookup.refetch()} className="focus-ring ml-1 font-semibold text-primary hover:underline">
                          Tentar de novo
                        </button>
                      </>
                    ) : null}
                  </p>
                </div>
              )}
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
              disabled={!manualPhone.trim() || !connectionId || startMutation.isPending || !canStartManual}
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
