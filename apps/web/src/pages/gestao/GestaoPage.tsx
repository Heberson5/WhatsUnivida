import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { formatDistanceToNow } from "date-fns";
import { ptBR } from "date-fns/locale";
import { Eye, GitMerge } from "lucide-react";
import type { ConversationListItemDTO } from "@whatsunivida/types";
import { api } from "../../lib/api";
import { useAuthStore } from "../../store/auth-store";
import { PeriodFilter, type PeriodValue } from "../../components/common/PeriodFilter";
import { ConnectionFilter } from "../../components/common/ConnectionFilter";
import { ReadOnlyConversationDrawer } from "../../components/gestao/ReadOnlyConversationDrawer";
import { MergeConversationModal } from "../../components/gestao/MergeConversationModal";

const STATUS_LABEL: Record<string, string> = {
  NEW: "Nova",
  WAITING: "Aguardando",
  IN_PROGRESS: "Em atendimento",
  TRANSFERRED: "Transferida",
  CLOSED: "Encerrada",
  ABANDONED: "Abandonada",
  HANDLED_EXTERNALLY: "Atendido pelo celular",
};

const STATUS_COLOR: Record<string, string> = {
  NEW: "bg-secondary/50 text-secondary-fg",
  WAITING: "bg-secondary/50 text-secondary-fg",
  IN_PROGRESS: "bg-primary/15 text-primary",
  TRANSFERRED: "bg-purple-100 text-purple-700",
  CLOSED: "bg-gray-100 text-gray-600",
  ABANDONED: "bg-red-100 text-red-700",
  HANDLED_EXTERNALLY: "bg-yellow-100 text-yellow-700",
};

interface AgentOption {
  id: string;
  displayName: string;
}

export default function GestaoPage() {
  const [period, setPeriod] = useState<PeriodValue>({ period: "today" });
  const [agentId, setAgentId] = useState("all");
  const [status, setStatus] = useState("all");
  const [search, setSearch] = useState("");
  const [connectionIds, setConnectionIds] = useState<string[]>([]);
  const [selected, setSelected] = useState<ConversationListItemDTO | null>(null);
  const [merging, setMerging] = useState<ConversationListItemDTO | null>(null);
  const isAdmin = useAuthStore((s) => s.user?.role === "ADMIN");

  const { data: agents } = useQuery({
    queryKey: ["agents"],
    queryFn: async () => (await api.get<AgentOption[]>("/agents")).data,
  });

  const { data: conversations, isLoading } = useQuery({
    queryKey: ["oversight", period, agentId, status, search, connectionIds],
    queryFn: async () =>
      (
        await api.get<ConversationListItemDTO[]>("/conversations/oversight", {
          params: {
            from: period.from,
            to: period.to,
            agentId: agentId === "all" ? undefined : agentId,
            status: status === "all" ? undefined : status,
            q: search || undefined,
            connectionId: connectionIds.length ? connectionIds : undefined,
          },
        })
      ).data,
  });

  return (
    <div className="flex h-full flex-col overflow-hidden p-3 sm:p-6">
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <PeriodFilter value={period} onChange={setPeriod} />

        <select value={agentId} onChange={(e) => setAgentId(e.target.value)} className="focus-ring rounded-card border border-border bg-surface px-3 py-2 text-sm">
          <option value="all">Todos os atendentes</option>
          {agents?.map((a) => (
            <option key={a.id} value={a.id}>
              {a.displayName}
            </option>
          ))}
        </select>

        <select value={status} onChange={(e) => setStatus(e.target.value)} className="focus-ring rounded-card border border-border bg-surface px-3 py-2 text-sm">
          <option value="all">Todos os status</option>
          {Object.entries(STATUS_LABEL).map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </select>

        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Buscar por nome ou telefone..."
          className="focus-ring flex-1 min-w-[200px] rounded-card border border-border bg-surface px-3 py-2 text-sm"
        />

        <ConnectionFilter value={connectionIds} onChange={setConnectionIds} />
      </div>

      <div className="shadow-soft flex-1 overflow-auto rounded-card border border-border bg-surface">
        <table className="w-full text-sm">
          <thead className="sticky top-0 bg-surface-alt text-left text-xs uppercase tracking-wide text-muted">
            <tr>
              <th className="px-4 py-3">Cliente</th>
              <th className="px-4 py-3">Atendente</th>
              <th className="px-4 py-3">Conexão</th>
              <th className="px-4 py-3">Status</th>
              <th className="px-4 py-3">Entrada na fila</th>
              <th className="px-4 py-3">Aceite</th>
              <th className="px-4 py-3" />
            </tr>
          </thead>
          <tbody>
            {isLoading && (
              <tr>
                <td colSpan={7} className="px-4 py-8 text-center text-muted">
                  Carregando...
                </td>
              </tr>
            )}
            {!isLoading && conversations?.length === 0 && (
              <tr>
                <td colSpan={7} className="px-4 py-8 text-center text-muted">
                  Nenhuma conversa encontrada para os filtros selecionados.
                </td>
              </tr>
            )}
            {conversations?.map((c) => (
              <tr key={c.id} className="border-t border-border hover:bg-surface-alt">
                <td className="px-4 py-3">
                  <div className="flex items-center gap-2.5">
                    {c.contact.photoUrl ? (
                      <img src={c.contact.photoUrl} alt="" className="h-8 w-8 shrink-0 rounded-full object-cover" />
                    ) : (
                      <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-surface-alt text-xs font-semibold text-muted">
                        {(c.contact.name || c.contact.phone).slice(0, 2).toUpperCase()}
                      </div>
                    )}
                    <div className="min-w-0">
                      <div className="truncate font-medium">{c.contact.name || c.contact.phone}</div>
                      <div className="text-xs text-muted">{c.contact.phone}</div>
                    </div>
                  </div>
                </td>
                <td className="px-4 py-3">{c.assignedAgentName ?? "-"}</td>
                <td className="px-4 py-3 text-muted">{c.whatsappConnectionName}</td>
                <td className="px-4 py-3">
                  <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${STATUS_COLOR[c.status]}`}>{STATUS_LABEL[c.status]}</span>
                </td>
                <td className="px-4 py-3 text-muted">{formatDistanceToNow(new Date(c.enteredQueueAt), { locale: ptBR, addSuffix: true })}</td>
                <td className="px-4 py-3 text-muted">{c.acceptedAt ? formatDistanceToNow(new Date(c.acceptedAt), { locale: ptBR, addSuffix: true }) : "-"}</td>
                <td className="px-4 py-3 text-right">
                  <div className="flex items-center justify-end gap-3">
                    {isAdmin && (
                      <button
                        onClick={() => setMerging(c)}
                        className="focus-ring inline-flex items-center gap-1 text-xs font-medium text-muted hover:text-primary hover:underline"
                        title="Mesclar esta conversa duplicada com outra"
                      >
                        <GitMerge className="h-3.5 w-3.5" /> Mesclar
                      </button>
                    )}
                    <button onClick={() => setSelected(c)} className="focus-ring inline-flex items-center gap-1 text-xs font-medium text-primary hover:underline">
                      <Eye className="h-3.5 w-3.5" /> Visualizar
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {selected && <ReadOnlyConversationDrawer conversation={selected} onClose={() => setSelected(null)} />}

      {merging && (
        <MergeConversationModal
          conversation={merging}
          onClose={() => setMerging(null)}
          onMerged={() => setMerging(null)}
        />
      )}
    </div>
  );
}
