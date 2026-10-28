import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { AlertTriangle, ChevronDown, X } from "lucide-react";
import { api } from "../../lib/api";

interface AgentOption {
  id: string;
  displayName: string;
  presence: "ONLINE" | "AWAY" | "OFFLINE";
  photoUrl: string | null;
  whatsappConnectionName: string | null;
}

function AgentAvatar({ agent }: { agent: AgentOption }) {
  return agent.photoUrl ? (
    <img src={agent.photoUrl} alt="" className="h-6 w-6 shrink-0 rounded-full object-cover" />
  ) : (
    <div className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-surface-alt text-[10px] font-semibold text-muted">
      {agent.displayName.slice(0, 2).toUpperCase()}
    </div>
  );
}

const PRESENCE_DOT: Record<string, string> = { ONLINE: "bg-green-500", AWAY: "bg-yellow-500", OFFLINE: "bg-gray-400" };
const PRESENCE_LABEL: Record<string, string> = { ONLINE: "Online", AWAY: "Ausente", OFFLINE: "Offline" };

export function TransferModal({
  onClose,
  onConfirm,
}: {
  onClose: () => void;
  onConfirm: (agentId: string, note: string) => Promise<void>;
}) {
  const { data: agents } = useQuery({
    queryKey: ["transfer-targets"],
    queryFn: async () => (await api.get<AgentOption[]>("/agents/transfer-targets")).data,
  });
  const [selected, setSelected] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const [loading, setLoading] = useState(false);
  // Set only once the agent has clicked "Transferir" on an offline target —
  // this second confirmation step is the alert required before transferring
  // to someone who isn't online.
  const [confirmingOffline, setConfirmingOffline] = useState(false);
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) setDropdownOpen(false);
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  const selectedAgent = agents?.find((a) => a.id === selected) ?? null;

  async function doTransfer() {
    if (!selected) return;
    setLoading(true);
    try {
      await onConfirm(selected, note);
      onClose();
    } finally {
      setLoading(false);
    }
  }

  function handleConfirmClick() {
    if (!selectedAgent) return;
    if (selectedAgent.presence !== "ONLINE" && !confirmingOffline) {
      setConfirmingOffline(true);
      return;
    }
    doTransfer();
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-4">
      <div className="w-full max-w-md rounded-card border border-border bg-surface p-5 shadow-elevated">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-base font-semibold">Transferir atendimento</h2>
          <button onClick={onClose} className="focus-ring rounded-full p-1 text-muted hover:bg-surface-alt" aria-label="Fechar">
            <X className="h-5 w-5" />
          </button>
        </div>

        <label className="mb-1 block text-sm font-medium">Transferir para</label>
        <div ref={dropdownRef} className="relative">
          <button
            type="button"
            onClick={() => setDropdownOpen((o) => !o)}
            className="focus-ring flex w-full items-center gap-2 rounded-card border border-border bg-surface px-3 py-2 text-left text-sm"
          >
            {selectedAgent ? (
              <>
                <AgentAvatar agent={selectedAgent} />
                <span className={`h-2 w-2 shrink-0 rounded-full ${PRESENCE_DOT[selectedAgent.presence]}`} />
                <span className="flex-1 truncate">{selectedAgent.displayName}</span>
                <span className="shrink-0 text-xs text-muted">
                  {PRESENCE_LABEL[selectedAgent.presence]}
                  {selectedAgent.whatsappConnectionName ? ` · ${selectedAgent.whatsappConnectionName}` : ""}
                </span>
              </>
            ) : (
              <span className="flex-1 text-muted">Selecione um atendente...</span>
            )}
            <ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted" />
          </button>

          {dropdownOpen && (
            <div className="shadow-soft absolute left-0 top-full z-20 mt-1 max-h-56 w-full overflow-y-auto rounded-card border border-border bg-surface p-1">
              {agents?.length === 0 && <p className="px-2 py-2 text-sm text-muted">Nenhum outro atendente disponível.</p>}
              {agents?.map((agent) => (
                <button
                  key={agent.id}
                  type="button"
                  onClick={() => {
                    setSelected(agent.id);
                    setConfirmingOffline(false);
                    setDropdownOpen(false);
                  }}
                  className={`focus-ring flex w-full items-center gap-3 rounded-card px-2.5 py-2 text-left hover:bg-surface-alt ${selected === agent.id ? "bg-primary/5" : ""}`}
                >
                  <AgentAvatar agent={agent} />
                  <span className={`h-2 w-2 shrink-0 rounded-full ${PRESENCE_DOT[agent.presence]}`} />
                  <span className="flex-1 truncate text-sm">{agent.displayName}</span>
                  <span className="shrink-0 text-xs text-muted">
                    {PRESENCE_LABEL[agent.presence]}
                    {agent.whatsappConnectionName ? ` · ${agent.whatsappConnectionName}` : ""}
                  </span>
                </button>
              ))}
            </div>
          )}
        </div>

        <label className="mt-4 block text-sm font-medium">Observação (opcional)</label>
        <textarea
          value={note}
          onChange={(e) => setNote(e.target.value)}
          rows={3}
          maxLength={500}
          className="focus-ring mt-1 w-full rounded-card border border-border bg-transparent px-3 py-2 text-sm"
          placeholder="Motivo da transferência..."
        />

        {confirmingOffline && selectedAgent && (
          <div className="mt-3 flex items-start gap-2 rounded-card bg-secondary/30 px-3 py-2 text-sm text-secondary-fg">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
            <span>
              <strong>{selectedAgent.displayName}</strong> está offline agora. Se não fizer login em até 2 horas, o
              atendimento volta automaticamente para você. Tem certeza que deseja transferir mesmo assim?
            </span>
          </div>
        )}

        <div className="mt-4 flex gap-2">
          <button onClick={onClose} className="focus-ring flex-1 rounded-card border border-border py-2 text-sm">
            Cancelar
          </button>
          <button
            onClick={handleConfirmClick}
            disabled={!selected || loading}
            className="focus-ring flex-1 rounded-card bg-primary py-2 text-sm font-semibold text-primary-fg disabled:opacity-60"
          >
            {loading ? "Transferindo..." : confirmingOffline ? "Sim, transferir mesmo assim" : "Confirmar transferência"}
          </button>
        </div>
      </div>
    </div>
  );
}
