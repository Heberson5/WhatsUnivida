import { useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { formatDistanceToNow } from "date-fns";
import { ptBR } from "date-fns/locale";
import clsx from "clsx";
import { ArrowRightLeft, CheckCircle2, ChevronLeft, ChevronRight, Eye, GitMerge, Hand, Inbox, Search, Undo2, X } from "lucide-react";
import { COLUMN_SCREENS, OVERSIGHT_PAGE_SIZES, PERMISSION, type ConversationListItemDTO, type ConversationStatus, type OversightPageDTO, type OversightPageSize } from "@whatsatendende/types";
import { api, getApiErrorMessage } from "../../lib/api";
import { contactDisplayName } from "../../lib/contact-display";
import { useAuthStore } from "../../store/auth-store";
import { PeriodFilter, type PeriodValue } from "../../components/common/PeriodFilter";
import { ConnectionFilter } from "../../components/common/ConnectionFilter";
import { ReadOnlyConversationDrawer } from "../../components/gestao/ReadOnlyConversationDrawer";
import { MergeConversationModal } from "../../components/gestao/MergeConversationModal";
import { GestaoTransferModal } from "../../components/gestao/GestaoTransferModal";
import { ChatPanel } from "../../components/atendimento/ChatPanel";
import { useNow } from "../../hooks/useNow";
import { formatActivity } from "../../lib/formatActivity";
import { businessMinutesSince, businessWaitLabel, PAUSED_LABEL, waitPaused } from "../../lib/business-wait";
import { STATUS_COLOR, STATUS_LABEL } from "../../lib/conversationStatus";
import { toastWithUndo } from "../../lib/undoToast";
import { ColumnViewMenu } from "../../components/common/ColumnViewMenu";
import { useColumnView } from "../../hooks/useColumnView";
import { ContactPhoto } from "../../components/common/ContactPhoto";
import { useIsPhone } from "../../hooks/useIsPhone";

// Same "still active" scope the backend enforces (see
// assignConversationFromGestao/returnConversationToQueue) — CLOSED/ABANDONED
// are terminal, nothing to route there anymore.
const ROUTABLE_STATUSES = new Set<ConversationStatus>(["IN_FLOW", "NEW", "WAITING", "FLOW_ABANDONED", "IN_PROGRESS", "TRANSFERRED", "HANDLED_EXTERNALLY"]);
const INTERVENABLE_STATUSES = new Set<ConversationStatus>(["IN_PROGRESS", "TRANSFERRED"]);
const SEARCH_DEBOUNCE_MS = 400;
const ALREADY_QUEUED_STATUSES = new Set<ConversationStatus>(["NEW", "WAITING"]);

// Filter chips (each one a group of statuses), with live counts.
const STATUS_CHIPS: { key: string; label: string; statuses: ConversationStatus[] }[] = [
  { key: "flow", label: "No fluxo", statuses: ["IN_FLOW"] },
  { key: "queue", label: "Na fila", statuses: ["NEW", "WAITING"] },
  { key: "inProgress", label: "Em atendimento", statuses: ["IN_PROGRESS", "TRANSFERRED"] },
  { key: "external", label: "Pelo celular", statuses: ["HANDLED_EXTERNALLY"] },
  { key: "closed", label: "Encerradas", statuses: ["CLOSED"] },
  { key: "abandoned", label: "Abandonadas", statuses: ["ABANDONED", "FLOW_ABANDONED"] },
];

// "Linhas por página" is remembered in this browser.
const PAGE_SIZE_KEY = "gestao-page-size";
function savedPageSize(): OversightPageSize {
  try {
    const saved = Number(localStorage.getItem(PAGE_SIZE_KEY));
    return (OVERSIGHT_PAGE_SIZES as readonly number[]).includes(saved) ? (saved as OversightPageSize) : 50;
  } catch {
    return 50;
  }
}

// Waiting this long (queue, or customer without a reply) turns amber, then red.
const WAIT_WARNING_MINUTES = 5;
const WAIT_DANGER_MINUTES = 15;

interface AttendantOption {
  id: string;
  displayName: string;
  role: "AGENT" | "MANAGER" | "ADMIN";
  isSelf: boolean;
}

// Managers and administrators attend customers too, so they are in the filter, each under their own heading. The
// server leaves the administrators out for a manager.
const ATTENDANT_GROUPS = [
  { role: "AGENT", label: "Atendentes" },
  { role: "MANAGER", label: "Gestores" },
  { role: "ADMIN", label: "Administradores" },
] as const;

export default function GestaoPage() {
  const [period, setPeriod] = useState<PeriodValue>({ period: "today" });
  const [agentId, setAgentId] = useState("all");
  const [status, setStatus] = useState("all");
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [bulkTransferring, setBulkTransferring] = useState(false);
  const now = useNow();
  const columnView = useColumnView("gestao");
  const isPhone = useIsPhone();
  const [search, setSearch] = useState("");
  // Searching inside the messages is heavier — wait for a pause in the typing.
  const [debouncedSearch, setDebouncedSearch] = useState("");
  useEffect(() => {
    const timer = setTimeout(() => setDebouncedSearch(search.trim()), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [search]);
  const [connectionIds, setConnectionIds] = useState<string[]>([]);
  // From the Dashboard's "Conversas que chegam ao longo do dia": only the conversations the customer opened in the
  // period — at this hour, when a bar was clicked. Shown as a chip that removes it.
  const [arrival, setArrival] = useState<{ hour: number | null } | null>(null);
  const [selected, setSelected] = useState<ConversationListItemDTO | null>(null);
  const [merging, setMerging] = useState<ConversationListItemDTO | null>(null);
  const [transferring, setTransferring] = useState<ConversationListItemDTO[] | null>(null);
  const [closing, setClosing] = useState<ConversationListItemDTO | null>(null);
  const isAdmin = useAuthStore((s) => s.user?.role === "ADMIN");
  // Transferir/Enviar p/ fila hit /conversations/:id/gestao-transfer and
  // /gestao-return-to-queue, both gated backend-side by GESTAO_GERENCIAR on
  // top of the GESTAO_ACESSAR umbrella already required to reach this page
  // — see PROMPT: "Mapeie todos os menus e o que tem dentro dos menus e
  // inclua nas permissões".
  const canManage = useAuthStore((s) => s.permissions?.[PERMISSION.GESTAO_GERENCIAR]);
  const canIntervene = useAuthStore((s) => s.permissions?.[PERMISSION.GESTAO_INTERVIR]);
  const myId = useAuthStore((s) => s.user?.id);
  // Gestão › Intervir: the conversation open with this manager replying in place of the agent.
  const [interveningSnapshot, setInterveningSnapshot] = useState<ConversationListItemDTO | null>(null);
  const interveningId = interveningSnapshot?.id ?? null;
  const queryClient = useQueryClient();

  // Deep link from the Dashboard's Aguardando/Em atendimento/Encerradas
  // cards (?status=a,b&period=...&from=...&to=...) — status may carry more
  // than one value (Em atendimento = IN_PROGRESS + TRANSFERRED), joined
  // with a comma since this page's own filter is a single <select>; it just
  // won't show a matching option when more than one status came in, same
  // as "Todos os status" would. See PROMPT: "direcionado para a tela de
  // gestão, já aplicado o filtro do período do dashboard e o filtro do card".
  const [searchParams, setSearchParams] = useSearchParams();
  useEffect(() => {
    const statusParam = searchParams.get("status");
    const periodParam = searchParams.get("period");
    // ?open=<id> from the Ctrl+K palette: open that conversation read-only.
    const openParam = searchParams.get("open");
    const openedByParam = searchParams.get("openedBy");
    if (openParam) {
      api
        .get<ConversationListItemDTO>(`/conversations/${openParam}`)
        .then((res) => setSelected(res.data))
        .catch((err) => toast.error(getApiErrorMessage(err)));
    }
    if (!statusParam && !periodParam && !openParam && !openedByParam) return;
    if (statusParam) setStatus(statusParam);
    if (openedByParam === "customer") {
      const hour = searchParams.get("hour");
      setArrival({ hour: hour === null ? null : Number(hour) });
      setStatus("all");
      setAgentId(searchParams.get("agentId") ?? "all");
      setConnectionIds(searchParams.get("connectionId")?.split(",").filter(Boolean) ?? []);
    }
    if (periodParam) {
      setPeriod({
        period: periodParam as PeriodValue["period"],
        from: searchParams.get("from") ?? undefined,
        to: searchParams.get("to") ?? undefined,
      });
    } else if (statusParam) {
      // The Dashboard's "Aguardando" card carries no period on purpose — it is what is waiting
      // right now, whatever day it arrived — so it must not be narrowed to the page's default "Hoje".
      setPeriod({ period: "all" });
    }
    setSearchParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        next.delete("status");
        next.delete("period");
        next.delete("from");
        next.delete("to");
        next.delete("open");
        for (const key of ["openedBy", "hour", "agentId", "connectionId"]) next.delete(key);
        return next;
      },
      { replace: true }
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams]);

  const { data: attendants } = useQuery({
    queryKey: ["gestao-attendants"],
    queryFn: async () => (await api.get<AttendantOption[]>("/agents/attendants")).data,
  });

  const returnToQueueMutation = useMutation({
    mutationFn: (conversationId: string) => api.post(`/conversations/${conversationId}/gestao-return-to-queue`),
    onSuccess: (_res, conversationId) => {
      toastWithUndo("Conversa enviada para a fila.", conversationId, queryClient);
      queryClient.invalidateQueries({ queryKey: ["oversight"] });
    },
    onError: (err) => toast.error(getApiErrorMessage(err)),
  });

  const interveneMutation = useMutation({
    mutationFn: async (conversationId: string) => (await api.post<ConversationListItemDTO>(`/conversations/${conversationId}/intervene`)).data,
    onSuccess: (conversation) => {
      setInterveningSnapshot(conversation);
      queryClient.invalidateQueries({ queryKey: ["oversight"] });
    },
    onError: (err) => toast.error(getApiErrorMessage(err)),
  });

  const endInterventionMutation = useMutation({
    mutationFn: (conversationId: string) => api.post(`/conversations/${conversationId}/intervention/end`),
    onSuccess: () => {
      toast.success("Conversa devolvida ao atendente.");
      setInterveningSnapshot(null);
      queryClient.invalidateQueries({ queryKey: ["oversight"] });
    },
    onError: (err) => toast.error(getApiErrorMessage(err)),
  });

  const closeMutation = useMutation({
    mutationFn: ({ conversationId, sendClosingMessage }: { conversationId: string; sendClosingMessage: boolean }) =>
      api.post(`/conversations/${conversationId}/gestao-close`, { sendClosingMessage }),
    onSuccess: (_res, { conversationId }) => {
      toastWithUndo("Atendimento encerrado.", conversationId, queryClient);
      queryClient.invalidateQueries({ queryKey: ["oversight"] });
      setClosing(null);
      if (conversationId === interveningId) setInterveningSnapshot(null);
    },
    onError: (err) => toast.error(getApiErrorMessage(err)),
  });

  // Page by page, with the status filter, the total and each chip's count worked out by the API: a capped list
  // filtered here used to hide an open conversation older than the newest 200 that the Dashboard still counted.
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState<OversightPageSize>(savedPageSize);
  const filterKey = JSON.stringify([period, agentId, debouncedSearch, connectionIds, status, pageSize, arrival]);
  useEffect(() => setPage(1), [filterKey]);
  const { data: pageData, isLoading } = useQuery({
    queryKey: ["oversight", "page", period, agentId, debouncedSearch, connectionIds, status, page, pageSize, arrival],
    placeholderData: (previous) => previous,
    queryFn: async () =>
      (
        await api.get<OversightPageDTO>("/conversations/oversight/page", {
          params: {
            status: status === "all" ? undefined : status,
            page,
            pageSize,
            // The period itself — the API turns "hoje", "este mês"... into dates in this browser's time zone
            // (same rule as the Dashboard and Relatórios); only "personalizado" carries from/to, and
            // "Todo o período" sends nothing. Leaving `period` out used to list everything under "Hoje".
            period: period.period === "all" ? undefined : period.period,
            tzOffsetMinutes: new Date().getTimezoneOffset(),
            from: period.from,
            to: period.to,
            agentId: agentId === "all" ? undefined : agentId,
            q: debouncedSearch || undefined,
            connectionId: connectionIds.length ? connectionIds : undefined,
            openedByCustomer: arrival ? "1" : undefined,
            arrivalHour: arrival?.hour ?? undefined,
          },
        })
      ).data,
  });

  const conversations = pageData?.items;
  // The live row (it refreshes on every oversight update), so the panel follows the conversation as it changes.
  const intervening = interveningSnapshot ? ((conversations ?? []).find((c) => c.id === interveningSnapshot.id) ?? interveningSnapshot) : null;

  const visible = conversations ?? [];
  const statusCounts = pageData?.statusCounts ?? {};
  const countFor = (statuses: ConversationStatus[]) => statuses.reduce((sum, s) => sum + (statusCounts[s] ?? 0), 0);
  const allCount = Object.values(statusCounts).reduce<number>((sum, n) => sum + (n ?? 0), 0);
  const total = pageData?.total ?? 0;
  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  const selectable = visible.filter((c) => canManage && ROUTABLE_STATUSES.has(c.status));
  const selectedRows = visible.filter((c) => selectedIds.has(c.id));
  const allSelected = selectable.length > 0 && selectable.every((c) => selectedIds.has(c.id));

  function toggleRow(id: string) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  // Counted inside the connection's Horário de expediente only, like the Atendimento cards.
  function waitInfo(c: ConversationListItemDTO): { label: string; minutes: number; paused: boolean } | null {
    const paused = waitPaused(c.businessClock, now);
    if (c.status === "NEW" || c.status === "WAITING") {
      const minutes = businessMinutesSince(c.businessClock, c.enteredQueueAt, now);
      return { label: businessWaitLabel(c.businessClock, c.enteredQueueAt, now), minutes, paused };
    }
    // "Atendido pelo celular" too: the customer's new messages stay on that row and never reach the
    // queue, so this is how a manager sees someone has been left waiting on the phone.
    if (c.awaitingReplySince && (c.status === "IN_PROGRESS" || c.status === "TRANSFERRED" || c.status === "HANDLED_EXTERNALLY")) {
      const minutes = businessMinutesSince(c.businessClock, c.awaitingReplySince, now);
      return { label: `sem resposta há ${businessWaitLabel(c.businessClock, c.awaitingReplySince, now)}`, minutes, paused };
    }
    return null;
  }

  function waitClass(wait: ReturnType<typeof waitInfo>) {
    if (!wait) return "text-muted";
    if (wait.minutes >= WAIT_DANGER_MINUTES) return "font-semibold text-danger";
    if (wait.minutes >= WAIT_WARNING_MINUTES) return "font-semibold text-warning";
    return "text-muted";
  }

  function clientAvatar(c: ConversationListItemDTO, size: string) {
    return c.contact.photoUrl ? (
      <ContactPhoto photoUrl={c.contact.photoUrl} name={contactDisplayName(c.contact)} phone={c.contact.phone}>
        <img src={c.contact.photoUrl} alt="" className={`${size} shrink-0 rounded-full object-cover`} />
      </ContactPhoto>
    ) : (
      <div className={`flex ${size} shrink-0 items-center justify-center rounded-full bg-surface-alt text-xs font-semibold text-muted`}>
        {contactDisplayName(c.contact).slice(0, 2).toUpperCase()}
      </div>
    );
  }

  function statusBadge(c: ConversationListItemDTO) {
    return <span className={`whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-semibold ${STATUS_COLOR[c.status]}`}>{STATUS_LABEL[c.status]}</span>;
  }

  // The agent/connection/waiting/lastActivity values — the table puts them in cells, the phone card under labels.
  function detailContent(key: string, c: ConversationListItemDTO, wait: ReturnType<typeof waitInfo>) {
    switch (key) {
      case "agent":
        return (
          <>
            {c.assignedAgentName ?? <span className="text-muted">—</span>}
            {c.intervention && (
              <span className="mt-0.5 flex items-center gap-1 whitespace-nowrap text-[11px] font-medium text-amber-600 dark:text-amber-400">
                <Hand className="h-3 w-3" /> Intervenção · {c.intervention.name}
              </span>
            )}
          </>
        );
      case "connection":
        return (
          <span className="inline-flex items-center gap-1.5 whitespace-nowrap text-xs text-muted">
            <span className="h-2 w-2 rounded-sm" style={{ backgroundColor: c.whatsappConnectionColor }} />
            {c.whatsappConnectionName}
          </span>
        );
      case "waiting":
        return (
          <span
            className={clsx("text-xs tabular-nums", waitClass(wait))}
            title={`Entrou na fila ${formatDistanceToNow(new Date(c.enteredQueueAt), { locale: ptBR, addSuffix: true })}${c.acceptedAt ? ` · aceita ${formatDistanceToNow(new Date(c.acceptedAt), { locale: ptBR, addSuffix: true })}` : ""}`}
          >
            {wait?.label ?? "—"}
            {wait?.paused && <span className="ml-1 font-normal text-muted">{PAUSED_LABEL}</span>}
          </span>
        );
      case "lastActivity":
        return (
          <>
            {c.searchMatch ? (
              <div className="truncate font-medium text-[var(--color-text)]" title={c.searchMatch}>
                <Search className="me-1 inline h-3 w-3 text-primary" aria-label="Encontrado na conversa" />
                {c.searchMatch}
              </div>
            ) : (
              <div className="truncate">{c.lastMessagePreview ?? "—"}</div>
            )}
            <div className="text-[11px] opacity-75">{formatActivity(c.lastMessageAt, now)}</div>
          </>
        );
      default:
        return null;
    }
  }

  // One cell per column of COLUMN_SCREENS.gestao — the ⋮ menu picks which show and in what order.
  function renderCell(key: string, c: ConversationListItemDTO, wait: ReturnType<typeof waitInfo>) {
    switch (key) {
      case "client":
        return (
          <td key="client" className="px-3 py-3">
            <div className="flex items-center gap-2.5">
              {clientAvatar(c, "h-8 w-8")}
              <div className="min-w-0">
                <div className="truncate font-medium">{contactDisplayName(c.contact)}</div>
                {c.contact.phone && <div className="text-xs text-muted">{c.contact.phone}</div>}
              </div>
            </div>
          </td>
        );
      case "status":
        return (
          <td key="status" className="px-3 py-3">
            {statusBadge(c)}
          </td>
        );
      case "waiting":
        return (
          <td key="waiting" className="whitespace-nowrap px-3 py-3">
            {detailContent(key, c, wait)}
          </td>
        );
      case "lastActivity":
        return (
          <td key="lastActivity" className="max-w-[220px] px-3 py-3 text-xs text-muted">
            {detailContent(key, c, wait)}
          </td>
        );
      default:
        return (
          <td key={key} className="px-3 py-3">
            {detailContent(key, c, wait)}
          </td>
        );
    }
  }

  // Per-row actions, only those this conversation and the user's permissions allow. The phone card shows them with
  // their names; the table row as icons.
  function rowActions(c: ConversationListItemDTO, card: boolean) {
    const iconClass = card
      ? "focus-ring inline-flex items-center gap-1 rounded-lg border border-border px-2 py-1.5 text-xs text-muted hover:bg-surface-alt hover:text-primary"
      : "focus-ring rounded-lg p-1.5 text-muted hover:bg-surface-alt hover:text-primary";
    const labelClass = card ? "" : "sr-only";
    return (
      <div className={card ? "flex flex-wrap items-center justify-end gap-1.5" : "flex items-center justify-end gap-0.5 whitespace-nowrap"}>
        {canManage && ROUTABLE_STATUSES.has(c.status) && (
          <button
            onClick={() => setTransferring([c])}
            className={iconClass}
            title="Transferir para outro atendente"
          >
            <ArrowRightLeft className="h-4 w-4" />
            <span className={labelClass}>Transferir</span>
          </button>
        )}
        {canManage && ROUTABLE_STATUSES.has(c.status) && !ALREADY_QUEUED_STATUSES.has(c.status) && (
          <button
            onClick={() => returnToQueueMutation.mutate(c.id)}
            disabled={returnToQueueMutation.isPending}
            className={clsx(iconClass, "disabled:opacity-50")}
            title="Enviar de volta para a fila, sem atendente"
          >
            <Inbox className="h-4 w-4" />
            <span className={labelClass}>Enviar para a fila</span>
          </button>
        )}
        {canManage && ROUTABLE_STATUSES.has(c.status) && (
          <button
            onClick={() => setClosing(c)}
            className={iconClass}
            title="Encerrar este atendimento"
          >
            <CheckCircle2 className="h-4 w-4" />
            <span className={labelClass}>Encerrar</span>
          </button>
        )}
        {isAdmin && (
          <button
            onClick={() => setMerging(c)}
            className={iconClass}
            title="Mesclar esta conversa duplicada com outra"
          >
            <GitMerge className="h-4 w-4" />
            <span className={labelClass}>Mesclar</span>
          </button>
        )}
        {canIntervene && INTERVENABLE_STATUSES.has(c.status) && c.assignedAgentId && c.assignedAgentId !== myId && (
          <button
            onClick={() => (c.intervention?.userId === myId ? setInterveningSnapshot(c) : interveneMutation.mutate(c.id))}
            disabled={Boolean(c.intervention && c.intervention.userId !== myId) || interveneMutation.isPending}
            className={clsx(
              "focus-ring inline-flex items-center gap-1 rounded-lg px-2 py-1 text-xs font-semibold disabled:cursor-not-allowed disabled:opacity-50", card ? "border border-amber-400/50 py-1.5" : "ml-1",
              c.intervention?.userId === myId ? "bg-amber-500 text-white hover:bg-amber-600" : "text-amber-600 hover:bg-amber-500/10 dark:text-amber-400"
            )}
            title={
              c.intervention && c.intervention.userId !== myId
                ? `${c.intervention.name} já está intervindo nesta conversa`
                : "Assumir as respostas desta conversa — o atendente passa a só acompanhar e deixar notas"
            }
          >
            <Hand className="h-3.5 w-3.5" /> {c.intervention?.userId === myId ? "Abrir intervenção" : "Intervir"}
          </button>
        )}
        <button
    onClick={() => setSelected(c)}
    className={clsx("focus-ring inline-flex items-center gap-1 rounded-lg px-2 py-1 text-xs font-semibold text-primary hover:bg-primary/10", card ? "border border-primary/30 py-1.5" : "ml-1")}
  >
          <Eye className="h-3.5 w-3.5" /> Visualizar
        </button>
      </div>
    );
  }

  const bulkReturnMutation = useMutation({
    mutationFn: async (rows: ConversationListItemDTO[]) => {
      const targets = rows.filter((c) => !ALREADY_QUEUED_STATUSES.has(c.status));
      const results = await Promise.allSettled(targets.map((c) => api.post(`/conversations/${c.id}/gestao-return-to-queue`)));
      return { ok: results.filter((r) => r.status === "fulfilled").length, failed: results.filter((r) => r.status === "rejected").length };
    },
    onSuccess: ({ ok, failed }) => {
      if (ok) toast.success(`${ok} ${ok === 1 ? "conversa enviada" : "conversas enviadas"} para a fila.`);
      if (failed) toast.error(`${failed} não puderam ser enviadas para a fila.`);
      setSelectedIds(new Set());
      queryClient.invalidateQueries({ queryKey: ["oversight"] });
    },
    onError: (err) => toast.error(getApiErrorMessage(err)),
  });

  return (
    // On a phone the whole page scrolls and each conversation is a card; from md up, the table in its own scroll box.
    <div className="flex h-full flex-col overflow-y-auto p-3 sm:p-6 md:overflow-hidden">
      <div className="mb-3 grid grid-cols-2 gap-2 md:flex md:flex-wrap md:items-center">
        <PeriodFilter value={period} onChange={setPeriod} allowAll />

        <select
          value={agentId}
          onChange={(e) => setAgentId(e.target.value)}
          aria-label="Filtrar por atendente"
          className="focus-ring min-w-0 rounded-card border border-border bg-surface px-3 py-2 text-sm"
        >
          <option value="all">Todos os atendentes</option>
          {ATTENDANT_GROUPS.map(({ role, label }) => {
            const people = (attendants ?? []).filter((a) => a.role === role);
            return people.length > 0 ? (
              <optgroup key={role} label={label}>
                {people.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.isSelf ? `${a.displayName} (você)` : a.displayName}
                  </option>
                ))}
              </optgroup>
            ) : null;
          })}
        </select>

        <label className="col-span-2 flex min-w-[200px] flex-1 items-center gap-2 rounded-card border border-border bg-surface px-3 py-2 text-sm focus-within:border-primary/50">
          <Search className="h-4 w-4 shrink-0 text-muted" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Buscar por nome, telefone ou texto da conversa..."
            className="min-w-0 flex-1 bg-transparent outline-none placeholder:text-muted"
          />
        </label>

        <div className="col-span-2 md:col-auto">
          <ConnectionFilter value={connectionIds} onChange={setConnectionIds} />
        </div>
      </div>

      {arrival && (
        <div className="mb-2 flex">
          <span className="inline-flex items-center gap-1.5 rounded-full border border-primary bg-primary/10 py-1 pl-3 pr-1 text-xs font-medium text-primary">
            Abertas pelo cliente{arrival.hour !== null ? ` às ${String(arrival.hour).padStart(2, "0")}h` : ""} (do Dashboard)
            <button type="button" onClick={() => setArrival(null)} className="focus-ring rounded-full p-0.5 hover:bg-primary/20" aria-label="Remover filtro do Dashboard" title="Remover filtro">
              <X className="h-3.5 w-3.5" />
            </button>
          </span>
        </div>
      )}

      <div className="-mx-3 mb-3 flex shrink-0 gap-1.5 overflow-x-auto px-3 md:mx-0 md:flex-wrap md:px-0" role="group" aria-label="Filtrar por status">
        {[{ key: "all", label: "Todas", statuses: [] as ConversationStatus[] }, ...STATUS_CHIPS].map((chip) => {
          const value = chip.key === "all" ? "all" : chip.statuses.join(",");
          const count = chip.key === "all" ? allCount : countFor(chip.statuses);
          const active = status === value;
          return (
            <button
              key={chip.key}
              onClick={() => {
                setStatus(value);
                setSelectedIds(new Set());
              }}
              aria-pressed={active}
              className={clsx(
                "focus-ring shrink-0 whitespace-nowrap rounded-full border px-3 py-1 text-xs font-medium",
                active ? "border-primary bg-primary/10 text-primary" : "border-border bg-surface text-muted hover:text-[var(--color-text)]",
                chip.key === "queue" && count > 0 && !active && "border-warning/40 text-warning"
              )}
            >
              {chip.label} · {count}
            </button>
          );
        })}
      </div>

      {selectedRows.length > 0 && (
        // Phone: pinned to the bottom of the screen (order-last) so it stays at hand while scrolling the cards.
        <div className="sticky bottom-0 z-10 order-last mt-3 flex flex-wrap items-center gap-2 rounded-card bg-[var(--color-text)] px-3 py-2 text-sm text-surface shadow-elevated md:static md:order-none md:mb-3 md:mt-0 md:shadow-none">
          <span className="font-medium">
            {selectedRows.length} {selectedRows.length === 1 ? "selecionada" : "selecionadas"}
          </span>
          <span className="flex-1" />
          <button
            onClick={() => setBulkTransferring(true)}
            className="focus-ring flex items-center gap-1.5 rounded-lg border border-white/20 bg-white/10 px-2.5 py-1 text-xs font-medium"
          >
            <ArrowRightLeft className="h-3.5 w-3.5" /> Transferir
          </button>
          <button
            onClick={() => bulkReturnMutation.mutate(selectedRows)}
            disabled={bulkReturnMutation.isPending || selectedRows.every((c) => ALREADY_QUEUED_STATUSES.has(c.status))}
            className="focus-ring flex items-center gap-1.5 rounded-lg border border-white/20 bg-white/10 px-2.5 py-1 text-xs font-medium disabled:opacity-50"
          >
            <Inbox className="h-3.5 w-3.5" /> {bulkReturnMutation.isPending ? "Enviando..." : "Devolver para a fila"}
          </button>
          <button onClick={() => setSelectedIds(new Set())} className="focus-ring rounded-lg p-1 hover:bg-white/10" aria-label="Limpar seleção">
            <X className="h-4 w-4" />
          </button>
        </div>
      )}

      {isPhone ? (
      <div className="space-y-2.5">
        {isLoading && <p className="py-8 text-center text-sm text-muted">Carregando...</p>}
        {!isLoading && visible.length === 0 && <p className="py-8 text-center text-sm text-muted">Nenhuma conversa encontrada para os filtros selecionados.</p>}
        {visible.map((c) => {
          const wait = waitInfo(c);
          const isSelected = selectedIds.has(c.id);
          const details = columnView.visibleKeys.filter((key) => key !== "client" && key !== "status");
          return (
            <div
              key={c.id}
              role="button"
              tabIndex={0}
              onClick={() => setSelected(c)}
              onKeyDown={(e) => e.key === "Enter" && e.target === e.currentTarget && setSelected(c)}
              className={clsx(
                "focus-ring shadow-soft cursor-pointer rounded-card border bg-surface p-3",
                isSelected ? "border-primary bg-primary/[0.05]" : "border-border"
              )}
            >
              <div className="flex items-start gap-2.5">
                {canManage && ROUTABLE_STATUSES.has(c.status) && (
                  <input
                    type="checkbox"
                    aria-label={`Selecionar ${contactDisplayName(c.contact)}`}
                    checked={isSelected}
                    onClick={(e) => e.stopPropagation()}
                    onChange={() => toggleRow(c.id)}
                    className="mt-2.5 h-4 w-4 shrink-0 accent-[var(--color-primary)]"
                  />
                )}
                <div onClick={(e) => e.stopPropagation()}>{clientAvatar(c, "h-9 w-9")}</div>
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-semibold">{contactDisplayName(c.contact)}</div>
                  {c.contact.phone && <div className="truncate text-xs text-muted">{c.contact.phone}</div>}
                </div>
                {columnView.visibleKeys.includes("status") && <div className="shrink-0">{statusBadge(c)}</div>}
              </div>
              {details.length > 0 && (
                <dl className="mt-2.5 grid grid-cols-2 gap-x-3 gap-y-2 text-xs">
                  {details.map((key) => (
                    <div key={key} className={clsx("min-w-0", key === "lastActivity" && "col-span-2")}>
                      <dt className="text-muted">{COLUMN_SCREENS.gestao.columns.find((col) => col.key === key)?.label}</dt>
                      <dd className="min-w-0 text-[var(--color-text)]">{detailContent(key, c, wait)}</dd>
                    </div>
                  ))}
                </dl>
              )}
              <div className="mt-2.5 border-t border-border pt-2.5" onClick={(e) => e.stopPropagation()}>
                {rowActions(c, true)}
              </div>
            </div>
          );
        })}
      </div>

      ) : (
      <div className="shadow-soft flex-1 overflow-auto rounded-card border border-border bg-surface">
        <table className="w-full text-sm">
          <thead className="sticky top-0 bg-surface-alt text-left text-xs uppercase tracking-wide text-muted">
            <tr>
              <th className="w-16 py-3 pl-2 pr-4">
                <div className="flex items-center gap-1.5">
                  <ColumnViewMenu view={columnView} />
                  {canManage && (
                    <input
                      type="checkbox"
                      aria-label="Selecionar todas"
                      checked={allSelected}
                      disabled={selectable.length === 0}
                      onChange={() => setSelectedIds(allSelected ? new Set() : new Set(selectable.map((c) => c.id)))}
                      className="h-4 w-4 accent-[var(--color-primary)]"
                    />
                  )}
                </div>
              </th>
              {columnView.visibleKeys.map((key) => (
                <th key={key} className="px-3 py-3">
                  {COLUMN_SCREENS.gestao.columns.find((col) => col.key === key)?.label}
                </th>
              ))}
              <th className="px-4 py-3" />
            </tr>
          </thead>
          <tbody>
            {isLoading && (
              <tr>
                <td colSpan={columnView.visibleKeys.length + 2} className="px-4 py-8 text-center text-muted">
                  Carregando...
                </td>
              </tr>
            )}
            {!isLoading && visible.length === 0 && (
              <tr>
                <td colSpan={columnView.visibleKeys.length + 2} className="px-4 py-8 text-center text-muted">
                  Nenhuma conversa encontrada para os filtros selecionados.
                </td>
              </tr>
            )}
            {visible.map((c) => {
              const wait = waitInfo(c);
              const isSelected = selectedIds.has(c.id);
              return (
              <tr key={c.id} className={clsx("border-t border-border", isSelected ? "bg-primary/[0.07]" : "hover:bg-surface-alt")}>
                <td className="py-3 pl-9 pr-4">
                  {canManage && ROUTABLE_STATUSES.has(c.status) && (
                    <input
                      type="checkbox"
                      aria-label={`Selecionar ${contactDisplayName(c.contact)}`}
                      checked={isSelected}
                      onChange={() => toggleRow(c.id)}
                      className="h-4 w-4 accent-[var(--color-primary)]"
                    />
                  )}
                </td>
                {columnView.visibleKeys.map((key) => renderCell(key, c, wait))}
                <td className="px-4 py-3 text-right">
                  {rowActions(c, false)}
                </td>
              </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      )}

      <div className="mt-2 flex flex-wrap items-center justify-end gap-x-4 gap-y-2 text-xs text-muted">
        <span>
          Mostrando {visible.length.toLocaleString("pt-BR")} de {total.toLocaleString("pt-BR")} {total === 1 ? "conversa" : "conversas"}
        </span>
        <span className="flex items-center gap-2">
          <label className="flex items-center gap-2">
            Linhas por página
            <select
              value={pageSize}
              onChange={(e) => {
                const next = Number(e.target.value) as OversightPageSize;
                setPageSize(next);
                try {
                  localStorage.setItem(PAGE_SIZE_KEY, String(next));
                } catch {
                  // storage blocked: kept until the page reloads
                }
              }}
              className="focus-ring h-8 w-[84px] min-w-[84px] rounded-lg border border-border bg-surface pl-2.5 pr-7 text-sm text-[var(--color-text)]"
            >
              {OVERSIGHT_PAGE_SIZES.map((size) => (
                <option key={size} value={size}>
                  {size}
                </option>
              ))}
            </select>
          </label>
          <span aria-hidden="true">·</span>
          <button
            type="button"
            onClick={() => setPage((p) => Math.max(1, p - 1))}
            disabled={page <= 1}
            aria-label="Página anterior"
            className="focus-ring flex h-8 w-8 items-center justify-center rounded-lg border border-border bg-surface text-[var(--color-text)] hover:bg-surface-alt disabled:opacity-40"
          >
            <ChevronLeft className="h-4 w-4" />
          </button>
          <span className="min-w-[92px] text-center text-sm text-[var(--color-text)]">
            Página {Math.min(page, pageCount)} de {pageCount}
          </span>
          <button
            type="button"
            onClick={() => setPage((p) => Math.min(pageCount, p + 1))}
            disabled={page >= pageCount}
            aria-label="Próxima página"
            className="focus-ring flex h-8 w-8 items-center justify-center rounded-lg border border-border bg-surface text-[var(--color-text)] hover:bg-surface-alt disabled:opacity-40"
          >
            <ChevronRight className="h-4 w-4" />
          </button>
        </span>
      </div>

      {selected && <ReadOnlyConversationDrawer key={selected.id} conversation={selected} onClose={() => setSelected(null)} />}

      {intervening && (
        <div className="fixed inset-0 z-40 flex justify-end bg-black/30" onClick={() => setInterveningSnapshot(null)}>
          <div className="flex h-full w-full max-w-3xl flex-col bg-surface shadow-elevated" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true" aria-label="Intervenção na conversa">
            <div className="flex items-center gap-2 border-b border-amber-300 bg-amber-50 px-4 py-2 text-xs text-amber-900 dark:border-amber-500/40 dark:bg-amber-500/10 dark:text-amber-100">
              <Hand className="h-3.5 w-3.5 shrink-0" />
              <span className="flex-1">
                Você está intervindo nesta conversa. {intervening.assignedAgentName ?? "O atendente"} acompanha e pode deixar notas, mas só você responde ao cliente.
              </span>
              <button onClick={() => setInterveningSnapshot(null)} className="focus-ring rounded-full p-1 hover:bg-amber-100 dark:hover:bg-amber-500/20" aria-label="Fechar">
                <X className="h-4 w-4" />
              </button>
            </div>
            <div className="min-h-0 flex-1">
              <ChatPanel
                key={intervening.id}
                conversation={intervening}
                onClosed={() => setInterveningSnapshot(null)}
                headerActions={
                  <>
                    <button
                      onClick={() => endInterventionMutation.mutate(intervening.id)}
                      disabled={endInterventionMutation.isPending}
                      className="focus-ring flex items-center gap-1.5 rounded-card border border-amber-400 px-2 py-1.5 text-xs font-semibold text-amber-700 hover:bg-amber-50 disabled:opacity-60 dark:text-amber-300 dark:hover:bg-amber-500/10 sm:px-3"
                      title={`Devolver a conversa para ${intervening.assignedAgentName ?? "o atendente"}`}
                    >
                      <Undo2 className="h-3.5 w-3.5" /> <span className="hidden sm:inline">Devolver</span>
                    </button>
                    {canManage && (
                      <button
                        onClick={() => setTransferring([intervening])}
                        className="focus-ring flex items-center gap-1.5 rounded-card border border-border px-2 py-1.5 text-xs font-medium hover:bg-surface-alt sm:px-3"
                      >
                        <ArrowRightLeft className="h-3.5 w-3.5" /> <span className="hidden sm:inline">Transferir</span>
                      </button>
                    )}
                    {canManage && (
                      <button
                        onClick={() => setClosing(intervening)}
                        className="focus-ring flex items-center gap-1.5 rounded-card bg-primary px-2 py-1.5 text-xs font-semibold text-primary-fg hover:opacity-90 sm:px-3"
                      >
                        <CheckCircle2 className="h-3.5 w-3.5" /> <span className="hidden sm:inline">Encerrar</span>
                      </button>
                    )}
                  </>
                }
              />
            </div>
          </div>
        </div>
      )}

      {merging && (
        <MergeConversationModal
          conversation={merging}
          onClose={() => setMerging(null)}
          onMerged={() => setMerging(null)}
        />
      )}

      {(transferring || bulkTransferring) && (
        <GestaoTransferModal
          conversations={transferring ?? selectedRows}
          onClose={() => {
            setTransferring(null);
            setBulkTransferring(false);
          }}
          onTransferred={() => {
            if (bulkTransferring) setSelectedIds(new Set());
            if (transferring?.some((c) => c.id === interveningId)) setInterveningSnapshot(null);
            setTransferring(null);
            setBulkTransferring(false);
          }}
        />
      )}

      {closing && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-4">
          <div className="w-full max-w-sm rounded-card border border-border bg-surface p-5 shadow-elevated">
            <h2 className="text-base font-semibold">Encerrar atendimento?</h2>
            <p className="mt-2 text-sm text-muted">
              Encerrar a conversa com {contactDisplayName(closing.contact)}. Deseja enviar a mensagem de encerramento
              configurada para o cliente?
            </p>
            <div className="mt-4 flex flex-col gap-2">
              <button
                onClick={() => closeMutation.mutate({ conversationId: closing.id, sendClosingMessage: true })}
                disabled={closeMutation.isPending}
                className="focus-ring rounded-card bg-primary py-2 text-sm font-semibold text-primary-fg disabled:opacity-60"
              >
                {closeMutation.isPending ? "Encerrando..." : "Encerrar e enviar mensagem"}
              </button>
              <button
                onClick={() => closeMutation.mutate({ conversationId: closing.id, sendClosingMessage: false })}
                disabled={closeMutation.isPending}
                className="focus-ring rounded-card border border-border py-2 text-sm font-medium disabled:opacity-60"
              >
                Encerrar sem enviar mensagem
              </button>
              <p className="-mt-1 text-center text-xs text-muted">Sem mensagem, a pesquisa de satisfação também não é enviada.</p>
              <button
                onClick={() => setClosing(null)}
                disabled={closeMutation.isPending}
                className="focus-ring py-2 text-sm text-muted disabled:opacity-60"
              >
                Cancelar
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
