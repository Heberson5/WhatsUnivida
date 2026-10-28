import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import clsx from "clsx";
import { formatDistanceToNow } from "date-fns";
import { ptBR } from "date-fns/locale";
import { AlertTriangle, Copy, MoreHorizontal, Pencil, Plug, Plus, Search, Trash2, Workflow } from "lucide-react";
import { toast } from "sonner";
import { PERMISSION, type FlowListItemDTO } from "@whatsatendende/types";
import { useAuthStore } from "../../store/auth-store";
import { api, getApiErrorMessage } from "../../lib/api";
import { FlowFormModal } from "./FlowFormModal";
import { FLOW_TEMPLATES, NODE_META, type FlowTemplate } from "./flowMeta";

type StatusFilter = "all" | "active" | "inactive";

/** Small drawing of the flow's graph, scaled to fit the card. */
function FlowThumbnail({ preview }: { preview: FlowListItemDTO["preview"] }) {
  const W = 260;
  const H = 96;
  const NODE_W = 44;
  const NODE_H = 16;
  if (preview.nodes.length === 0) return <div className="h-24 rounded-lg bg-surface-alt" />;
  const xs = preview.nodes.map((n) => n.x);
  const ys = preview.nodes.map((n) => n.y);
  const minX = Math.min(...xs);
  const minY = Math.min(...ys);
  const spanX = Math.max(...xs) - minX || 1;
  const spanY = Math.max(...ys) - minY || 1;
  const pad = 10;
  const scale = Math.min((W - NODE_W - pad * 2) / spanX, (H - NODE_H - pad * 2) / spanY, 0.35);
  const pos = preview.nodes.map((n) => ({ x: pad + (n.x - minX) * scale, y: pad + (n.y - minY) * scale, type: n.type }));
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="h-24 w-full rounded-lg bg-surface-alt" aria-hidden>
      {preview.edges.map(([a, b], i) => {
        const s = pos[a];
        const t = pos[b];
        const x1 = s.x + NODE_W;
        const y1 = s.y + NODE_H / 2;
        const x2 = t.x;
        const y2 = t.y + NODE_H / 2;
        const mid = (x1 + x2) / 2;
        return <path key={i} d={`M${x1} ${y1} C${mid} ${y1},${mid} ${y2},${x2} ${y2}`} fill="none" stroke="var(--color-border)" strokeWidth={1.5} />;
      })}
      {pos.map((p, i) => (
        <g key={i}>
          <rect x={p.x} y={p.y} width={NODE_W} height={NODE_H} rx={4} fill="var(--color-surface)" stroke="var(--color-border)" />
          <rect x={p.x} y={p.y} width={4} height={NODE_H} rx={2} fill={NODE_META[p.type].color} />
        </g>
      ))}
    </svg>
  );
}

function CardMenu({
  flow,
  canAdicionar,
  canEditar,
  canExcluir,
  onDuplicate,
  onRename,
  onDelete,
}: {
  flow: FlowListItemDTO;
  canAdicionar: boolean;
  canEditar: boolean;
  canExcluir: boolean;
  onDuplicate: () => void;
  onRename: () => void;
  onDelete: () => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const handle = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", handle);
    return () => document.removeEventListener("mousedown", handle);
  }, [open]);
  if (!canAdicionar && !canEditar && !canExcluir) return null;
  const pick = (action: () => void) => () => {
    setOpen(false);
    action();
  };
  return (
    <div className="relative" ref={ref}>
      <button
        onClick={(e) => {
          e.stopPropagation();
          setOpen((o) => !o);
        }}
        className="focus-ring rounded-lg p-1.5 text-muted hover:bg-surface-alt"
        aria-label={`Mais ações de ${flow.name}`}
        aria-haspopup="menu"
        aria-expanded={open}
      >
        <MoreHorizontal className="h-4 w-4" />
      </button>
      {open && (
        <div role="menu" className="absolute bottom-9 right-0 z-20 w-44 rounded-card border border-border bg-surface p-1 shadow-elevated" onClick={(e) => e.stopPropagation()}>
          {canAdicionar && (
            <button role="menuitem" onClick={pick(onDuplicate)} className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-sm hover:bg-surface-alt">
              <Copy className="h-4 w-4" /> Duplicar
            </button>
          )}
          {canEditar && (
            <button role="menuitem" onClick={pick(onRename)} className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-sm hover:bg-surface-alt">
              <Pencil className="h-4 w-4" /> Renomear
            </button>
          )}
          {canExcluir && (
            <button role="menuitem" onClick={pick(onDelete)} className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-sm text-danger hover:bg-danger-soft">
              <Trash2 className="h-4 w-4" /> Excluir
            </button>
          )}
        </div>
      )}
    </div>
  );
}

/** Lista de fluxos — cartões com miniatura, filtro e avisos do que impede ativar. */
export default function FluxoPage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const permissions = useAuthStore((s) => s.permissions);
  const canAdicionar = Boolean(permissions?.[PERMISSION.FLUXO_ADICIONAR]);
  const canEditar = Boolean(permissions?.[PERMISSION.FLUXO_EDITAR]);
  const canExcluir = Boolean(permissions?.[PERMISSION.FLUXO_EXCLUIR]);
  const [creating, setCreating] = useState<{ template?: { key: FlowTemplate; name: string } } | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<FlowListItemDTO | null>(null);
  const [renameTarget, setRenameTarget] = useState<FlowListItemDTO | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<StatusFilter>("all");

  const { data: flows, isLoading } = useQuery({
    queryKey: ["flows"],
    queryFn: async () => (await api.get<FlowListItemDTO[]>("/flows")).data,
  });

  const toggleActiveMutation = useMutation({
    mutationFn: ({ id, active }: { id: string; active: boolean }) => api.patch(`/flows/${id}`, { active }),
    onSuccess: (_res, { active }) => {
      queryClient.invalidateQueries({ queryKey: ["flows"] });
      toast.success(active ? "Fluxo ativado." : "Fluxo desativado.");
    },
    onError: (err) => toast.error(getApiErrorMessage(err)),
  });

  const duplicateMutation = useMutation({
    mutationFn: (id: string) => api.post<FlowListItemDTO>(`/flows/${id}/duplicate`),
    onSuccess: (res) => {
      queryClient.invalidateQueries({ queryKey: ["flows"] });
      toast.success(`“${res.data.name}” criado.`);
    },
    onError: (err) => toast.error(getApiErrorMessage(err)),
  });

  const renameMutation = useMutation({
    mutationFn: ({ id, name }: { id: string; name: string }) => api.patch(`/flows/${id}`, { name }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["flows"] });
      setRenameTarget(null);
    },
    onError: (err) => toast.error(getApiErrorMessage(err)),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => api.delete(`/flows/${id}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["flows"] });
      toast.success("Fluxo excluído.");
      setDeleteTarget(null);
    },
    onError: (err) => toast.error(getApiErrorMessage(err)),
  });

  const all = flows ?? [];
  const q = search.trim().toLowerCase();
  const visible = all.filter(
    (f) =>
      (!q || f.name.toLowerCase().includes(q) || (f.description ?? "").toLowerCase().includes(q)) &&
      (filter === "all" || (filter === "active") === f.active)
  );
  const counts = { all: all.length, active: all.filter((f) => f.active).length, inactive: all.filter((f) => !f.active).length };

  return (
    <div className="flex h-full flex-col overflow-hidden p-3 sm:p-6">
      <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold tracking-tight">Fluxo</h1>
          <p className="text-sm text-muted">Atendimento automático das suas conexões de WhatsApp (QR Code ou API Oficial). Nenhum fluxo funciona até você ativá-lo.</p>
        </div>
        {canAdicionar && (
          <button
            onClick={() => setCreating({})}
            className="focus-ring flex shrink-0 items-center gap-1.5 rounded-card bg-primary px-4 py-2 text-sm font-semibold text-primary-fg hover:opacity-90"
          >
            <Plus className="h-4 w-4" /> Novo fluxo
          </button>
        )}
      </div>

      {all.length > 0 && (
        <div className="mb-4 flex flex-wrap items-center gap-2">
          <label className="flex min-w-[220px] items-center gap-2 rounded-card border border-border bg-surface px-3 py-2 text-sm focus-within:border-primary/50">
            <Search className="h-4 w-4 shrink-0 text-muted" />
            <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Buscar fluxo" className="min-w-0 flex-1 bg-transparent outline-none placeholder:text-muted" />
          </label>
          {(
            [
              { value: "all", label: "Todos" },
              { value: "active", label: "Ativos" },
              { value: "inactive", label: "Inativos" },
            ] as const
          ).map((f) => (
            <button
              key={f.value}
              onClick={() => setFilter(f.value)}
              aria-pressed={filter === f.value}
              className={clsx(
                "focus-ring rounded-full border px-3 py-1 text-xs font-medium",
                filter === f.value ? "border-primary bg-primary/10 text-primary" : "border-border bg-surface text-muted hover:text-[var(--color-text)]"
              )}
            >
              {f.label} · {counts[f.value]}
            </button>
          ))}
        </div>
      )}

      <div className="flex-1 overflow-auto">
        {isLoading && <p className="py-10 text-center text-sm text-muted">Carregando...</p>}

        {!isLoading && all.length === 0 && (
          <div className="mx-auto max-w-2xl rounded-card border border-dashed border-border bg-surface p-8 text-center">
            <Workflow className="mx-auto h-10 w-10 text-primary" />
            <h2 className="mt-3 text-base font-semibold">Crie seu primeiro fluxo</h2>
            <p className="mx-auto mt-1 max-w-md text-sm text-muted">
              Um fluxo responde o cliente automaticamente e leva a conversa para o atendente certo. Comece em branco ou a partir de um modelo.
            </p>
            {canAdicionar && (
              <div className="mt-5 grid gap-3 text-left sm:grid-cols-2">
                {FLOW_TEMPLATES.map((t) => (
                  <button
                    key={t.key}
                    onClick={() => setCreating({ template: { key: t.key, name: t.name } })}
                    className="focus-ring rounded-card border border-border bg-surface-alt p-4 hover:border-primary/50"
                  >
                    <p className="text-sm font-semibold">{t.name}</p>
                    <p className="mt-1 text-xs text-muted">{t.description}</p>
                    <p className="mt-2 text-xs font-semibold text-primary">Usar modelo →</p>
                  </button>
                ))}
              </div>
            )}
          </div>
        )}

        {!isLoading && all.length > 0 && visible.length === 0 && <p className="py-10 text-center text-sm text-muted">Nenhum fluxo com esse filtro.</p>}

        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
          {visible.map((flow) => (
            <div
              key={flow.id}
              role="button"
              tabIndex={0}
              onClick={() => navigate(`/fluxo/${flow.id}`)}
              onKeyDown={(e) => e.key === "Enter" && navigate(`/fluxo/${flow.id}`)}
              className="shadow-soft focus-ring flex cursor-pointer flex-col gap-3 rounded-card border border-border bg-surface p-4 transition-colors hover:border-primary/40"
            >
              <FlowThumbnail preview={flow.preview} />
              <div className="flex items-start gap-2">
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-semibold">{flow.name}</p>
                  <p className="truncate text-xs text-muted">{flow.description || `${flow.nodeCount} ${flow.nodeCount === 1 ? "passo" : "passos"}`}</p>
                </div>
                <span
                  className={clsx(
                    "shrink-0 rounded-full px-2 py-0.5 text-[11px] font-semibold",
                    flow.active ? "bg-success-soft text-success" : "border border-border bg-surface-alt text-muted"
                  )}
                >
                  {flow.active ? "Ativo" : "Rascunho"}
                </span>
              </div>
              <div className="flex flex-wrap gap-1.5 text-[11px]">
                {flow.connectionNames.length > 0 ? (
                  flow.connectionNames.map((name) => (
                    <span key={name} className="inline-flex items-center gap-1 rounded-full border border-border px-2 py-0.5 text-muted">
                      <Plug className="h-3 w-3" /> {name}
                    </span>
                  ))
                ) : (
                  <span className="text-muted">Sem conexão vinculada</span>
                )}
              </div>
              {flow.issues.length > 0 && (
                <p className="flex items-start gap-1.5 rounded-lg bg-warning-soft px-2.5 py-1.5 text-xs text-warning" title={flow.issues.map((i) => i.message).join("\n")}>
                  <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                  <span>
                    {flow.issues[0].message}
                    {flow.issues.length > 1 && ` (e mais ${flow.issues.length - 1})`}
                  </span>
                </p>
              )}
              <div className="mt-auto flex items-center gap-2 border-t border-border pt-3">
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    if (canEditar) toggleActiveMutation.mutate({ id: flow.id, active: !flow.active });
                  }}
                  disabled={!canEditar || toggleActiveMutation.isPending || (!flow.active && flow.issues.length > 0)}
                  role="switch"
                  aria-checked={flow.active}
                  aria-label={flow.active ? "Desativar fluxo" : "Ativar fluxo"}
                  title={!flow.active && flow.issues.length > 0 ? "Corrija os avisos para poder ativar" : flow.active ? "Desativar fluxo" : "Ativar fluxo"}
                  className={clsx(
                    "focus-ring relative h-6 w-11 shrink-0 rounded-full transition-colors disabled:cursor-not-allowed disabled:opacity-50",
                    flow.active ? "bg-green-500" : "bg-border"
                  )}
                >
                  <span className={clsx("absolute left-1 top-1 h-4 w-4 rounded-full bg-white shadow transition-transform", flow.active ? "translate-x-5" : "translate-x-0")} />
                </button>
                <span className="flex-1 truncate text-xs text-muted">editado {formatDistanceToNow(new Date(flow.updatedAt), { locale: ptBR, addSuffix: true })}</span>
                <CardMenu
                  flow={flow}
                  canAdicionar={canAdicionar}
                  canEditar={canEditar}
                  canExcluir={canExcluir}
                  onDuplicate={() => duplicateMutation.mutate(flow.id)}
                  onRename={() => {
                    setRenameTarget(flow);
                    setRenameValue(flow.name);
                  }}
                  onDelete={() => setDeleteTarget(flow)}
                />
              </div>
            </div>
          ))}
        </div>
      </div>

      {creating && (
        <FlowFormModal
          template={creating.template}
          onClose={() => setCreating(null)}
          onCreated={(id) => {
            setCreating(null);
            navigate(`/fluxo/${id}`);
          }}
        />
      )}

      {renameTarget && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-4">
          <form
            onSubmit={(e) => {
              e.preventDefault();
              if (renameValue.trim()) renameMutation.mutate({ id: renameTarget.id, name: renameValue.trim() });
            }}
            className="w-full max-w-sm rounded-card border border-border bg-surface p-5 shadow-elevated"
          >
            <h2 className="text-base font-semibold">Renomear fluxo</h2>
            <input
              autoFocus
              value={renameValue}
              onChange={(e) => setRenameValue(e.target.value)}
              maxLength={120}
              aria-label="Nome do fluxo"
              className="focus-ring mt-3 w-full rounded-card border border-border bg-transparent px-3 py-2 text-sm"
            />
            <div className="mt-4 flex gap-2">
              <button type="button" onClick={() => setRenameTarget(null)} className="focus-ring flex-1 rounded-card border border-border py-2 text-sm">
                Cancelar
              </button>
              <button
                type="submit"
                disabled={!renameValue.trim() || renameMutation.isPending}
                className="focus-ring flex-1 rounded-card bg-primary py-2 text-sm font-semibold text-primary-fg disabled:opacity-60"
              >
                Salvar
              </button>
            </div>
          </form>
        </div>
      )}

      {deleteTarget && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-4">
          <div className="w-full max-w-sm rounded-card border border-border bg-surface p-5 shadow-elevated">
            <h2 className="text-base font-semibold">Excluir fluxo?</h2>
            <p className="mt-2 text-sm text-muted">
              "{deleteTarget.name}" e todos os seus nós serão removidos permanentemente. Esta ação não pode ser desfeita.
            </p>
            <div className="mt-5 flex gap-2">
              <button onClick={() => setDeleteTarget(null)} className="focus-ring flex-1 rounded-card border border-border py-2 text-sm">
                Cancelar
              </button>
              <button
                onClick={() => deleteMutation.mutate(deleteTarget.id)}
                disabled={deleteMutation.isPending}
                className="focus-ring flex-1 rounded-card bg-red-600 py-2 text-sm font-semibold text-white disabled:opacity-60"
              >
                {deleteMutation.isPending ? "Excluindo..." : "Excluir"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
