import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import clsx from "clsx";
import {
  AlertTriangle,
  ArrowLeft,
  Image,
  Maximize2,
  MapPin,
  Minus,
  PanelLeftClose,
  PanelLeftOpen,
  Plug,
  Plus,
  Redo2,
  Save,
  Search,
  Trash2,
  Undo2,
  X,
} from "lucide-react";
import {
  PERMISSION,
  validateFlowGraph,
  type FlowDetailDTO,
  type FlowEdgeDTO,
  type FlowIssue,
  type FlowNodeData,
  type FlowNodeDTO,
  type FlowNodeType,
  type FlowBusinessHoursData,
  type WorkScheduleOptionDTO,
  type FlowImage,
  type FlowStartData,
  FLOW_ABANDON_AFTER_MINUTES_DEFAULT,
  FLOW_HOURS_CLOSED,
  FLOW_HOURS_OPEN,
  FLOW_MENU_DEFAULT_PROMPT,
  FLOW_MENU_NAV_OPTIONS,
  flowMenuNavOptions,
  renderFlowMenuText,
  type FlowMenuNavigation,
} from "@whatsatendende/types";
import { useAuthStore } from "../../store/auth-store";
import { api, getApiErrorMessage } from "../../lib/api";
import { NODE_META } from "./flowMeta";

interface OfficialConnectionOption {
  id: string;
  name: string;
  connectionMode: "QRCODE" | "OFFICIAL_API";
}

interface AgentOption {
  id: string;
  displayName: string;
  presence: "ONLINE" | "AWAY" | "OFFLINE";
  pauseReasonName?: string | null;
  whatsappConnectionName?: string | null;
}

const NODE_WIDTH = 230;
const HEADER_HEIGHT = 34;
const MIN_ZOOM = 0.3;
const MAX_ZOOM = 1.6;
const HISTORY_LIMIT = 80;
// Consecutive edits to the same field within this window become one undo step.
const HISTORY_COALESCE_MS = 800;
const PRESENCE_DOT: Record<string, string> = { ONLINE: "bg-green-500", AWAY: "bg-amber-500", OFFLINE: "bg-gray-400" };
const VARIABLES = [
  { tag: "{{cliente}}", label: "Nome do cliente" },
  { tag: "{{opcao}}", label: "Última opção que o cliente escolheu" },
];
const PREVIEW_VARS = (text: string) => text.replaceAll("{{cliente}}", "Carlos").replaceAll("{{opcao}}", "Tangará da Serra");
const MAX_MENU_PROMPT = 4096;

const PALETTE: { category: string; items: { type: FlowNodeType; defaultData: FlowNodeData; hint: string }[] }[] = [
  {
    category: "Mensagens",
    items: [
      { type: "TEXT_MESSAGE", defaultData: { text: "" }, hint: "Envia um texto ao cliente" },
      { type: "MENU", defaultData: { options: [] }, hint: "Pergunta com opções numeradas" },
    ],
  },
  { category: "Atendimento", items: [{ type: "TRANSFER_TO_AGENT", defaultData: { assignedAgentIds: [], mode: "any" }, hint: "Passa para um atendente" }] },
  {
    category: "Controle",
    items: [
      {
        type: "BUSINESS_HOURS",
        defaultData: { workScheduleId: null },
        hint: "Separa dentro e fora do horário",
      },
      { type: "END", defaultData: {}, hint: "Encerra a conversa" },
    ],
  },
];
const COMING_SOON = [{ label: "Validar CEP", icon: MapPin }];

interface Graph {
  nodes: FlowNodeDTO[];
  edges: FlowEdgeDTO[];
}

function menuOptions(node: FlowNodeDTO) {
  return (node.data as { options?: { id: string; label: string }[] }).options ?? [];
}

function nodePreview(node: FlowNodeDTO, agentsById: Map<string, AgentOption>, schedulesById: Map<string, string>): string {
  if (node.type === "TEXT_MESSAGE") {
    const text = (node.data as { text?: string }).text;
    return text ? text : "Sem texto definido";
  }
  if (node.type === "MENU") {
    const options = menuOptions(node);
    return options.length ? "" : "Sem opções";
  }
  if (node.type === "TRANSFER_TO_AGENT") {
    const data = node.data as { assignedAgentIds?: string[]; mode?: string };
    const ids = data.assignedAgentIds ?? [];
    if (data.mode !== "selected" && ids.length === 0) return "Qualquer atendente disponível";
    const names = ids.map((id) => agentsById.get(id)?.displayName).filter(Boolean);
    return names.length ? names.join(", ") : "Nenhum atendente selecionado";
  }
  if (node.type === "START") return "Primeira mensagem do cliente";
  if (node.type === "BUSINESS_HOURS") {
    const data = node.data as FlowBusinessHoursData;
    if (data.workScheduleId) return schedulesById.get(data.workScheduleId) ?? "Horário de expediente";
    // A node saved before schedules existed keeps its own days and hours until one is picked.
    if (data.days) return `${describeDays(data.days)} · ${data.start}–${data.end}`;
    return "Sem horário — sempre aberto";
  }
  return "Encerra a conversa";
}

/** Where a node's outputs leave from, in world coordinates relative to the node. */
function outputAnchors(node: FlowNodeDTO): { handle: string | null; label?: string; dy: number }[] {
  if (node.type === "END" || node.type === "TRANSFER_TO_AGENT") return [];
  if (node.type === "MENU") {
    // Matches the option rows drawn in the node: 8px top padding, 22px rows, 4px gap.
    return menuOptions(node).map((o, i) => ({ handle: o.id, label: o.label, dy: HEADER_HEIGHT + 8 + i * 26 + 11 }));
  }
  if (node.type === "BUSINESS_HOURS") {
    return [
      { handle: FLOW_HOURS_OPEN, label: "Aberto", dy: HEADER_HEIGHT + 8 + 11 },
      { handle: FLOW_HOURS_CLOSED, label: "Fechado", dy: HEADER_HEIGHT + 8 + 26 + 11 },
    ];
  }
  return [{ handle: null, dy: HEADER_HEIGHT / 2 }];
}

const WEEKDAY_SHORT = ["Dom", "Seg", "Ter", "Qua", "Qui", "Sex", "Sáb"];

function describeDays(days: number[]): string {
  const sorted = [...days].sort();
  if (sorted.length === 7) return "Todos os dias";
  if (sorted.join() === "1,2,3,4,5") return "Seg–Sex";
  if (sorted.join() === "1,2,3,4,5,6") return "Seg–Sáb";
  return sorted.map((d) => WEEKDAY_SHORT[d]).join(", ") || "Nenhum dia";
}

export default function FlowEditorPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const permissions = useAuthStore((s) => s.permissions);
  // The drawing is edited on a computer; on a phone the editor opens to view
  // and switch the flow on/off only.
  const [isNarrow, setIsNarrow] = useState(() => window.innerWidth < 768);
  useEffect(() => {
    const onResize = () => setIsNarrow(window.innerWidth < 768);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);
  const canEditarPermission = Boolean(permissions?.[PERMISSION.FLUXO_EDITAR]);
  const canEdit = canEditarPermission && !isNarrow;

  const [graph, setGraph] = useState<Graph>({ nodes: [], edges: [] });
  const { nodes, edges } = graph;
  const [past, setPast] = useState<Graph[]>([]);
  const [future, setFuture] = useState<Graph[]>([]);
  const lastPushRef = useRef<{ key: string; at: number } | null>(null);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [selectedEdgeId, setSelectedEdgeId] = useState<string | null>(null);
  const [pendingConnection, setPendingConnection] = useState<{ sourceNodeId: string; sourceHandle: string | null } | null>(null);
  const [paletteCollapsed, setPaletteCollapsed] = useState(false);
  const [paletteSearch, setPaletteSearch] = useState("");
  const [connectionsOpen, setConnectionsOpen] = useState(false);
  const [issuesOpen, setIssuesOpen] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [editingName, setEditingName] = useState(false);
  const [nameDraft, setNameDraft] = useState("");
  const [view, setView] = useState({ x: 40, y: 40, zoom: 1 });
  const canvasRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{ nodeId: string; offsetX: number; offsetY: number; moved: boolean } | null>(null);
  const panRef = useRef<{ startX: number; startY: number; viewX: number; viewY: number; moved: boolean } | null>(null);

  const { data: flow, isLoading } = useQuery({
    queryKey: ["flow", id],
    queryFn: async () => (await api.get<FlowDetailDTO>(`/flows/${id}`)).data,
    enabled: Boolean(id),
  });

  const { data: connections } = useQuery({
    queryKey: ["whatsapp-connections"],
    queryFn: async () => (await api.get<OfficialConnectionOption[]>("/whatsapp/connections")).data,
  });
  const allConnections = connections ?? [];

  const { data: agents } = useQuery({
    queryKey: ["agents-transfer-targets-all"],
    queryFn: async () => (await api.get<AgentOption[]>("/agents/transfer-targets", { params: { excludeSelf: false } })).data,
  });
  const agentsById = useMemo(() => new Map((agents ?? []).map((a) => [a.id, a])), [agents]);
  const { data: workSchedules } = useQuery({
    queryKey: ["work-schedule-options"],
    queryFn: async () => (await api.get<WorkScheduleOptionDTO[]>("/work-schedules/options")).data,
  });
  const schedulesById = useMemo(() => new Map((workSchedules ?? []).map((w) => [w.id, w.name])), [workSchedules]);

  // Fit the whole drawing in view.
  const fitToScreen = useCallback((target: FlowNodeDTO[] = nodes) => {
    const el = canvasRef.current;
    if (!el || target.length === 0) return;
    const minX = Math.min(...target.map((n) => n.positionX));
    const minY = Math.min(...target.map((n) => n.positionY));
    const maxX = Math.max(...target.map((n) => n.positionX + NODE_WIDTH));
    const maxY = Math.max(...target.map((n) => n.positionY + 140));
    const pad = 60;
    const zoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, Math.min((el.clientWidth - pad * 2) / (maxX - minX), (el.clientHeight - pad * 2) / (maxY - minY), 1)));
    setView({
      zoom,
      x: pad - minX * zoom + Math.max(0, (el.clientWidth - pad * 2 - (maxX - minX) * zoom) / 2),
      y: pad - minY * zoom + Math.max(0, (el.clientHeight - pad * 2 - (maxY - minY) * zoom) / 2),
    });
  }, [nodes]);

  // Toggling Ativo/Inativo or editing Conexões both invalidate this same
  // query, which would otherwise wipe out unsaved canvas edits — so local
  // state is only (re)seeded the first time a given flow id loads.
  const loadedFlowIdRef = useRef<string | null>(null);
  useEffect(() => {
    if (flow && loadedFlowIdRef.current !== flow.id) {
      setGraph({ nodes: flow.nodes, edges: flow.edges });
      setPast([]);
      setFuture([]);
      setDirty(false);
      loadedFlowIdRef.current = flow.id;
      requestAnimationFrame(() => fitToScreen(flow.nodes));
    }
  }, [flow, fitToScreen]);

  // Ask before closing the tab with unsaved changes.
  useEffect(() => {
    if (!dirty) return;
    const handler = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [dirty]);

  const issues: FlowIssue[] = useMemo(
    () => validateFlowGraph({ nodes, edges, connectionCount: flow?.connectionIds.length ?? 0 }),
    [nodes, edges, flow?.connectionIds.length]
  );
  const issuesByNode = useMemo(() => {
    const map = new Map<string, string[]>();
    for (const issue of issues) if (issue.nodeId) map.set(issue.nodeId, [...(map.get(issue.nodeId) ?? []), issue.message]);
    return map;
  }, [issues]);

  // Latest graph, readable from event handlers without stale closures.
  const graphRef = useRef(graph);
  graphRef.current = graph;

  /** Every graph change goes through here so it can be undone. */
  const commit = useCallback((update: (g: Graph) => Graph, coalesceKey?: string) => {
    const current = graphRef.current;
    const now = Date.now();
    const last = lastPushRef.current;
    const coalesce = coalesceKey && last && last.key === coalesceKey && now - last.at < HISTORY_COALESCE_MS;
    if (!coalesce) setPast((p) => [...p.slice(-HISTORY_LIMIT + 1), current]);
    lastPushRef.current = coalesceKey ? { key: coalesceKey, at: now } : null;
    setFuture([]);
    const next = update(current);
    graphRef.current = next;
    setGraph(next);
    setDirty(true);
  }, []);

  function undo() {
    if (past.length === 0) return;
    const previous = past[past.length - 1];
    setPast((p) => p.slice(0, -1));
    setFuture((f) => [graph, ...f]);
    setGraph(previous);
    lastPushRef.current = null;
    setDirty(true);
  }

  function redo() {
    if (future.length === 0) return;
    const next = future[0];
    setFuture((f) => f.slice(1));
    setPast((p) => [...p, graph]);
    setGraph(next);
    lastPushRef.current = null;
    setDirty(true);
  }

  const metaMutation = useMutation({
    mutationFn: (patch: { active?: boolean; connectionIds?: string[]; name?: string }) => api.patch(`/flows/${id}`, patch),
    onSuccess: (_res, patch) => {
      queryClient.invalidateQueries({ queryKey: ["flow", id] });
      queryClient.invalidateQueries({ queryKey: ["flows"] });
      if (patch.active !== undefined) toast.success(patch.active ? "Fluxo ativado." : "Fluxo desativado.");
    },
    onError: (err) => toast.error(getApiErrorMessage(err)),
  });

  const saveMutation = useMutation({
    mutationFn: () =>
      api.put<FlowDetailDTO>(`/flows/${id}/graph`, {
        nodes: nodes.map((n) => ({ id: n.id, type: n.type, positionX: Math.round(n.positionX), positionY: Math.round(n.positionY), data: n.data })),
        edges: edges.map((e) => ({ sourceNodeId: e.sourceNodeId, targetNodeId: e.targetNodeId, sourceHandle: e.sourceHandle })),
      }),
    onSuccess: (res) => {
      // Ids change on every save, so the old history no longer applies.
      setGraph({ nodes: res.data.nodes, edges: res.data.edges });
      setPast([]);
      setFuture([]);
      setDirty(false);
      setSelectedNodeId(null);
      setSelectedEdgeId(null);
      queryClient.invalidateQueries({ queryKey: ["flows"] });
      queryClient.invalidateQueries({ queryKey: ["flow", id] });
      toast.success("Fluxo salvo.");
    },
    onError: (err) => toast.error(getApiErrorMessage(err)),
  });

  const selectedNode = nodes.find((n) => n.id === selectedNodeId) ?? null;

  function updateNodeData(nodeId: string, data: FlowNodeData, field = "data") {
    commit((g) => ({ ...g, nodes: g.nodes.map((n) => (n.id === nodeId ? { ...n, data } : n)) }), `${nodeId}:${field}`);
  }

  function toWorld(clientX: number, clientY: number) {
    const rect = canvasRef.current!.getBoundingClientRect();
    return { x: (clientX - rect.left - view.x) / view.zoom, y: (clientY - rect.top - view.y) / view.zoom };
  }

  function addNode(type: FlowNodeType, defaultData: FlowNodeData, at?: { x: number; y: number }) {
    const newId = `new-${crypto.randomUUID()}`;
    // Without a drop point, the new step goes to the right of the selected
    // one (or of the rightmost step), ready to be linked.
    const anchor = selectedNode ?? [...nodes].sort((a, b) => b.positionX - a.positionX)[0];
    const start = at ?? (anchor ? { x: anchor.positionX + NODE_WIDTH + 80, y: anchor.positionY } : { x: 80, y: 120 });
    const x = start.x;
    let y = start.y;
    const overlaps = (px: number, py: number) => nodes.some((n) => Math.abs(n.positionX - px) < NODE_WIDTH && Math.abs(n.positionY - py) < 90);
    while (!at && overlaps(x, y)) y += 110;
    commit((g) => ({ ...g, nodes: [...g.nodes, { id: newId, type, positionX: x, positionY: y, data: defaultData }] }));
    setSelectedNodeId(newId);
    setSelectedEdgeId(null);
    // Pan so the new step is on screen.
    const el = canvasRef.current;
    if (el && !at) {
      const sx = x * view.zoom + view.x;
      const sy = y * view.zoom + view.y;
      if (sx < 0 || sy < 0 || sx + NODE_WIDTH * view.zoom > el.clientWidth || sy + 120 * view.zoom > el.clientHeight) {
        setView((v) => ({ ...v, x: el.clientWidth / 2 - (x + NODE_WIDTH / 2) * v.zoom, y: el.clientHeight / 3 - y * v.zoom }));
      }
    }
  }

  function deleteNode(nodeId: string) {
    commit((g) => ({
      nodes: g.nodes.filter((n) => n.id !== nodeId),
      edges: g.edges.filter((e) => e.sourceNodeId !== nodeId && e.targetNodeId !== nodeId),
    }));
    if (selectedNodeId === nodeId) setSelectedNodeId(null);
  }

  function deleteEdge(edgeId: string) {
    commit((g) => ({ ...g, edges: g.edges.filter((e) => e.id !== edgeId) }));
    setSelectedEdgeId(null);
  }

  function startConnection(sourceNodeId: string, sourceHandle: string | null) {
    setPendingConnection((p) => (p?.sourceNodeId === sourceNodeId && p.sourceHandle === sourceHandle ? null : { sourceNodeId, sourceHandle }));
  }

  function completeConnection(targetNodeId: string) {
    const pending = pendingConnection;
    setPendingConnection(null);
    if (!pending || pending.sourceNodeId === targetNodeId) return;
    commit((g) => ({
      ...g,
      edges: [
        // One edge per output: re-linking an output replaces its old target.
        ...g.edges.filter((e) => !(e.sourceNodeId === pending.sourceNodeId && e.sourceHandle === pending.sourceHandle)),
        { id: `new-edge-${crypto.randomUUID()}`, sourceNodeId: pending.sourceNodeId, targetNodeId, sourceHandle: pending.sourceHandle },
      ],
    }));
  }

  // Keyboard: Ctrl+S save, Ctrl+Z / Ctrl+Y (or Ctrl+Shift+Z) undo/redo, Delete removes the selection, Esc cancels a link.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const typing = (e.target as HTMLElement).closest("input, textarea, select, [contenteditable]");
      const mod = e.ctrlKey || e.metaKey;
      if (mod && e.key.toLowerCase() === "s") {
        e.preventDefault();
        if (canEdit && dirty && !saveMutation.isPending) saveMutation.mutate();
        return;
      }
      if (typing || !canEdit) return;
      if (mod && e.key.toLowerCase() === "z") {
        e.preventDefault();
        if (e.shiftKey) redo();
        else undo();
      } else if (mod && e.key.toLowerCase() === "y") {
        e.preventDefault();
        redo();
      } else if (e.key === "Delete" || e.key === "Backspace") {
        if (selectedEdgeId) deleteEdge(selectedEdgeId);
        else if (selectedNode && selectedNode.type !== "START") deleteNode(selectedNode.id);
      } else if (e.key === "Escape") {
        setPendingConnection(null);
        setSelectedEdgeId(null);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  function zoomBy(factor: number, center?: { clientX: number; clientY: number }) {
    const el = canvasRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const cx = center ? center.clientX - rect.left : el.clientWidth / 2;
    const cy = center ? center.clientY - rect.top : el.clientHeight / 2;
    setView((v) => {
      const zoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, v.zoom * factor));
      const ratio = zoom / v.zoom;
      return { zoom, x: cx - (cx - v.x) * ratio, y: cy - (cy - v.y) * ratio };
    });
  }

  // Wheel zooms around the cursor (registered natively so it can preventDefault).
  useEffect(() => {
    const el = canvasRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      zoomBy(e.deltaY < 0 ? 1.1 : 1 / 1.1, e);
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  });

  function handleNodePointerDown(e: React.PointerEvent, node: FlowNodeDTO) {
    if ((e.target as HTMLElement).closest("[data-connector]")) return;
    e.stopPropagation();
    setSelectedNodeId(node.id);
    setSelectedEdgeId(null);
    if (!canEdit) return;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    const p = toWorld(e.clientX, e.clientY);
    dragRef.current = { nodeId: node.id, offsetX: p.x - node.positionX, offsetY: p.y - node.positionY, moved: false };
  }

  function handleCanvasPointerDown(e: React.PointerEvent) {
    if (e.button !== 0) return;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    panRef.current = { startX: e.clientX, startY: e.clientY, viewX: view.x, viewY: view.y, moved: false };
  }

  function handlePointerMove(e: React.PointerEvent) {
    const drag = dragRef.current;
    if (drag) {
      const p = toWorld(e.clientX, e.clientY);
      const x = p.x - drag.offsetX;
      const y = p.y - drag.offsetY;
      if (!drag.moved) {
        // First movement of this drag = one undo step for the whole move.
        drag.moved = true;
        commit((g) => g);
      }
      setGraph((g) => ({ ...g, nodes: g.nodes.map((n) => (n.id === drag.nodeId ? { ...n, positionX: x, positionY: y } : n)) }));
      return;
    }
    const pan = panRef.current;
    if (pan) {
      const dx = e.clientX - pan.startX;
      const dy = e.clientY - pan.startY;
      if (Math.abs(dx) + Math.abs(dy) > 3) pan.moved = true;
      setView((v) => ({ ...v, x: pan.viewX + dx, y: pan.viewY + dy }));
    }
  }

  function handlePointerUp() {
    const pan = panRef.current;
    if (pan && !pan.moved) {
      // A click on empty canvas clears the selection.
      setSelectedNodeId(null);
      setSelectedEdgeId(null);
      setPendingConnection(null);
    }
    dragRef.current = null;
    panRef.current = null;
  }

  function handleDrop(e: React.DragEvent) {
    e.preventDefault();
    const raw = e.dataTransfer.getData("application/x-flow-node");
    if (!raw || !canEdit) return;
    const item = JSON.parse(raw) as { type: FlowNodeType; defaultData: FlowNodeData };
    const p = toWorld(e.clientX, e.clientY);
    addNode(item.type, item.defaultData, { x: p.x - NODE_WIDTH / 2, y: p.y - HEADER_HEIGHT / 2 });
  }

  function goBack() {
    if (dirty && !window.confirm("Há alterações não salvas neste fluxo. Sair mesmo assim?")) return;
    navigate("/fluxo");
  }

  function toggleActive() {
    if (!flow || !canEditarPermission) return;
    if (!flow.active) {
      if (dirty) {
        toast.error("Salve as alterações antes de ativar o fluxo.");
        return;
      }
      if (issues.length > 0) {
        setIssuesOpen(true);
        toast.error("Corrija os avisos antes de ativar o fluxo.");
        return;
      }
    }
    metaMutation.mutate({ active: !flow.active });
  }

  if (isLoading || !flow) {
    return <div className="flex h-full items-center justify-center text-sm text-muted">Carregando fluxo...</div>;
  }

  const paletteQuery = paletteSearch.trim().toLowerCase();
  const nodeById = new Map(nodes.map((n) => [n.id, n]));

  return (
    <div className="flex h-full flex-col overflow-hidden">
      {/* Top bar */}
      <div className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-b border-border bg-surface px-3 py-2.5 sm:px-4">
        <div className="flex min-w-0 items-center gap-2">
          <button onClick={goBack} className="focus-ring rounded-lg p-1.5 text-muted hover:bg-surface-alt" aria-label="Voltar para a lista de fluxos">
            <ArrowLeft className="h-5 w-5" />
          </button>
          <div className="min-w-0">
            {editingName ? (
              <input
                autoFocus
                value={nameDraft}
                onChange={(e) => setNameDraft(e.target.value)}
                onBlur={() => {
                  setEditingName(false);
                  if (nameDraft.trim() && nameDraft.trim() !== flow.name) metaMutation.mutate({ name: nameDraft.trim() });
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter") (e.target as HTMLInputElement).blur();
                  if (e.key === "Escape") setEditingName(false);
                }}
                maxLength={120}
                aria-label="Nome do fluxo"
                className="focus-ring w-56 rounded-lg border border-border bg-transparent px-2 py-1 text-sm font-semibold"
              />
            ) : (
              <button
                onClick={() => {
                  if (!canEditarPermission) return;
                  setNameDraft(flow.name);
                  setEditingName(true);
                }}
                className="focus-ring block max-w-[260px] truncate rounded-lg px-1 text-left text-base font-semibold hover:bg-surface-alt"
                title={canEditarPermission ? "Clique para renomear" : undefined}
              >
                {flow.name}
              </button>
            )}
            <p className="flex items-center gap-2 px-1 text-xs text-muted">
              {dirty ? (
                <span className="inline-flex items-center gap-1 font-medium text-warning">
                  <span className="h-1.5 w-1.5 rounded-full bg-amber-500" /> Alterações não salvas
                </span>
              ) : (
                <span>Tudo salvo</span>
              )}
            </p>
          </div>
        </div>

        <div className="flex shrink-0 flex-wrap items-center gap-1.5 sm:gap-2">
          {canEdit && (
            <div className="flex items-center rounded-lg border border-border">
              <button onClick={undo} disabled={past.length === 0} className="focus-ring rounded-l-lg p-1.5 text-muted hover:bg-surface-alt disabled:opacity-40" aria-label="Desfazer" title="Desfazer (Ctrl+Z)">
                <Undo2 className="h-4 w-4" />
              </button>
              <button onClick={redo} disabled={future.length === 0} className="focus-ring rounded-r-lg border-l border-border p-1.5 text-muted hover:bg-surface-alt disabled:opacity-40" aria-label="Refazer" title="Refazer (Ctrl+Y)">
                <Redo2 className="h-4 w-4" />
              </button>
            </div>
          )}

          <div className="relative">
            <button
              onClick={() => setIssuesOpen((o) => !o)}
              className={clsx(
                "focus-ring flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-xs font-medium",
                issues.length ? "border-warning/40 bg-warning-soft text-warning" : "border-border text-success"
              )}
            >
              <AlertTriangle className="h-3.5 w-3.5" /> {issues.length ? `${issues.length} ${issues.length === 1 ? "aviso" : "avisos"}` : "Pronto para ativar"}
            </button>
            {issuesOpen && issues.length > 0 && (
              <div className="absolute right-0 top-10 z-30 w-72 rounded-card border border-border bg-surface p-2 shadow-elevated">
                <p className="mb-1 px-1 text-xs font-semibold text-muted">Corrija antes de ativar</p>
                {issues.map((issue, i) => (
                  <button
                    key={i}
                    onClick={() => {
                      if (issue.nodeId) {
                        setSelectedNodeId(issue.nodeId);
                        setSelectedEdgeId(null);
                      } else setConnectionsOpen(true);
                      setIssuesOpen(false);
                    }}
                    className="flex w-full items-start gap-2 rounded-lg px-2 py-1.5 text-left text-xs hover:bg-surface-alt"
                  >
                    <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-warning" />
                    <span>
                      {issue.nodeId && nodeById.get(issue.nodeId) ? <strong>{NODE_META[nodeById.get(issue.nodeId)!.type].label}: </strong> : null}
                      {issue.message}
                    </span>
                  </button>
                ))}
              </div>
            )}
          </div>

          <div className="relative">
            <button
              onClick={() => setConnectionsOpen((o) => !o)}
              className="focus-ring flex items-center gap-1.5 rounded-lg border border-border px-2.5 py-1.5 text-xs font-medium hover:bg-surface-alt"
            >
              <Plug className="h-3.5 w-3.5" /> Conexões ({flow.connectionIds.length})
            </button>
            {connectionsOpen && (
              <div className="absolute right-0 top-10 z-30 w-64 rounded-card border border-border bg-surface p-2 shadow-elevated">
                <div className="mb-1.5 flex items-center justify-between px-1">
                  <p className="text-xs font-medium text-muted">Conexões que usam este fluxo</p>
                  <button onClick={() => setConnectionsOpen(false)} className="rounded p-0.5 text-muted hover:bg-surface-alt" aria-label="Fechar">
                    <X className="h-3.5 w-3.5" />
                  </button>
                </div>
                {allConnections.length === 0 && <p className="px-1 text-xs text-muted">Nenhuma conexão WhatsApp cadastrada.</p>}
                <div className="max-h-48 overflow-y-auto">
                  {allConnections.map((c) => {
                    const checked = flow.connectionIds.includes(c.id);
                    return (
                      <label key={c.id} className="flex items-center gap-2 rounded-lg px-2 py-1.5 text-sm hover:bg-surface-alt">
                        <input
                          type="checkbox"
                          checked={checked}
                          disabled={!canEditarPermission || metaMutation.isPending}
                          onChange={() => {
                            const next = checked ? flow.connectionIds.filter((cid) => cid !== c.id) : [...flow.connectionIds, c.id];
                            metaMutation.mutate({ connectionIds: next });
                          }}
                          className="h-4 w-4 accent-[var(--color-primary)]"
                        />
                        <span className="min-w-0 flex-1 truncate">{c.name}</span>
                        <span className="shrink-0 text-[10px] text-muted">{c.connectionMode === "OFFICIAL_API" ? "Oficial" : "QR Code"}</span>
                      </label>
                    );
                  })}
                </div>
              </div>
            )}
          </div>

          <div className="flex rounded-lg border border-border p-0.5" role="group" aria-label="Situação do fluxo">
            {[
              { value: false, label: "Inativo" },
              { value: true, label: "Ativo" },
            ].map((opt) => (
              <button
                key={opt.label}
                onClick={() => flow.active !== opt.value && toggleActive()}
                disabled={!canEditarPermission || metaMutation.isPending}
                aria-pressed={flow.active === opt.value}
                className={clsx(
                  "focus-ring rounded-md px-2.5 py-1 text-xs font-semibold disabled:cursor-not-allowed",
                  flow.active === opt.value ? (opt.value ? "bg-green-500 text-white" : "bg-surface-alt text-[var(--color-text)]") : "text-muted"
                )}
              >
                {opt.label}
              </button>
            ))}
          </div>

          {canEdit && (
            <button
              onClick={() => saveMutation.mutate()}
              disabled={saveMutation.isPending || !dirty}
              className="focus-ring flex items-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-sm font-semibold text-primary-fg disabled:opacity-60"
              title="Salvar (Ctrl+S)"
            >
              <Save className="h-4 w-4" /> {saveMutation.isPending ? "Salvando..." : "Salvar"}
            </button>
          )}
        </div>
      </div>

      {isNarrow && (
        <p className="shrink-0 bg-warning-soft px-3 py-2 text-xs text-warning">No celular o fluxo abre só para visualizar e ativar/desativar. Para editar o desenho, use um computador.</p>
      )}

      <div className="relative flex flex-1 overflow-hidden">
        {/* Palette — collapses to an icon rail instead of disappearing */}
        {canEdit &&
          (paletteCollapsed ? (
            <div className="flex w-12 shrink-0 flex-col items-center gap-1 border-r border-border bg-surface py-2">
              <button
                onClick={() => setPaletteCollapsed(false)}
                className="focus-ring mb-1 rounded-lg p-2 text-muted hover:bg-surface-alt"
                aria-label="Expandir painel de nós"
                title="Expandir painel de nós"
              >
                <PanelLeftOpen className="h-4 w-4" />
              </button>
              {PALETTE.flatMap((c) => c.items).map((item) => {
                const meta = NODE_META[item.type];
                return (
                  <button
                    key={item.type}
                    draggable
                    onDragStart={(e) => e.dataTransfer.setData("application/x-flow-node", JSON.stringify(item))}
                    onClick={() => addNode(item.type, item.defaultData)}
                    className="focus-ring rounded-lg p-2 hover:bg-surface-alt"
                    title={meta.label}
                    aria-label={`Adicionar ${meta.label}`}
                  >
                    <meta.icon className="h-4 w-4" style={{ color: meta.color }} />
                  </button>
                );
              })}
            </div>
          ) : (
            <div className="flex w-60 shrink-0 flex-col overflow-y-auto border-r border-border bg-surface">
              <div className="flex items-center justify-between px-3 pb-2 pt-3">
                <p className="text-xs font-semibold uppercase tracking-[0.07em] text-muted">Adicionar passo</p>
                <button
                  onClick={() => setPaletteCollapsed(true)}
                  className="focus-ring rounded-lg p-1 text-muted hover:bg-surface-alt"
                  aria-label="Recolher painel de nós"
                  title="Recolher painel de nós"
                >
                  <PanelLeftClose className="h-4 w-4" />
                </button>
              </div>
              <label className="mx-3 mb-2 flex items-center gap-2 rounded-lg border border-border px-2 py-1.5 text-xs focus-within:border-primary/50">
                <Search className="h-3.5 w-3.5 shrink-0 text-muted" />
                <input value={paletteSearch} onChange={(e) => setPaletteSearch(e.target.value)} placeholder="Buscar passo" className="min-w-0 flex-1 bg-transparent outline-none" />
              </label>
              {PALETTE.map((category) => {
                const items = category.items.filter((i) => !paletteQuery || NODE_META[i.type].label.toLowerCase().includes(paletteQuery));
                if (items.length === 0) return null;
                return (
                  <div key={category.category} className="px-3 pb-2">
                    <p className="mb-1 mt-1 text-[10px] font-semibold uppercase tracking-[0.07em] text-muted">{category.category}</p>
                    <div className="space-y-1">
                      {items.map((item) => {
                        const meta = NODE_META[item.type];
                        return (
                          <button
                            key={item.type}
                            draggable
                            onDragStart={(e) => e.dataTransfer.setData("application/x-flow-node", JSON.stringify(item))}
                            onClick={() => addNode(item.type, item.defaultData)}
                            className="focus-ring flex w-full cursor-grab items-center gap-2.5 rounded-lg border border-border px-2.5 py-2 text-left hover:border-primary/40 hover:bg-surface-alt active:cursor-grabbing"
                          >
                            <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md" style={{ backgroundColor: `${meta.color}1A`, color: meta.color }}>
                              <meta.icon className="h-4 w-4" />
                            </span>
                            <span className="min-w-0">
                              <span className="block truncate text-[13px] font-medium">{meta.label}</span>
                              <span className="block truncate text-[11px] text-muted">{item.hint}</span>
                            </span>
                          </button>
                        );
                      })}
                    </div>
                  </div>
                );
              })}
              {!paletteQuery && (
                <div className="px-3 pb-3">
                  <p className="mb-1 mt-1 text-[10px] font-semibold uppercase tracking-[0.07em] text-muted">Em breve</p>
                  {COMING_SOON.map((item) => (
                    <div key={item.label} className="flex items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-[13px] text-muted opacity-60">
                      <item.icon className="h-4 w-4" /> {item.label}
                    </div>
                  ))}
                </div>
              )}
              <p className="mt-auto border-t border-border px-3 py-2 text-[11px] text-muted">Arraste para o desenho ou clique para adicionar. Ligue os passos clicando na bolinha de saída e depois no destino.</p>
            </div>
          ))}

        {/* Canvas */}
        <div
          ref={canvasRef}
          className={clsx("relative flex-1 touch-none overflow-hidden bg-[var(--color-bg)]", pendingConnection ? "cursor-crosshair" : "cursor-grab active:cursor-grabbing")}
          style={{
            backgroundImage: "radial-gradient(circle, var(--color-border) 1px, transparent 1px)",
            backgroundSize: `${20 * view.zoom}px ${20 * view.zoom}px`,
            backgroundPosition: `${view.x}px ${view.y}px`,
          }}
          onPointerDown={handleCanvasPointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
          onDragOver={(e) => canEdit && e.preventDefault()}
          onDrop={handleDrop}
        >
          <div className="absolute left-0 top-0 origin-top-left" style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.zoom})` }}>
            <svg className="absolute left-0 top-0 overflow-visible" width={1} height={1}>
              <defs>
                <marker id="flow-arrow" markerWidth="8" markerHeight="8" refX="6" refY="4" orient="auto">
                  <path d="M0,0 L8,4 L0,8 Z" fill="var(--color-primary)" />
                </marker>
                <marker id="flow-arrow-selected" markerWidth="8" markerHeight="8" refX="6" refY="4" orient="auto">
                  <path d="M0,0 L8,4 L0,8 Z" fill="var(--color-danger)" />
                </marker>
              </defs>
              {edges.map((edge) => {
                const source = nodeById.get(edge.sourceNodeId);
                const target = nodeById.get(edge.targetNodeId);
                if (!source || !target) return null;
                const anchor = outputAnchors(source).find((a) => a.handle === (edge.sourceHandle ?? null));
                const x1 = source.positionX + NODE_WIDTH;
                const y1 = source.positionY + (anchor?.dy ?? HEADER_HEIGHT / 2);
                const x2 = target.positionX;
                const y2 = target.positionY + HEADER_HEIGHT / 2;
                const midX = (x1 + x2) / 2;
                const selected = selectedEdgeId === edge.id;
                const d = `M ${x1} ${y1} C ${Math.max(midX, x1 + 40)} ${y1}, ${Math.min(midX, x2 - 40)} ${y2}, ${x2} ${y2}`;
                return (
                  <g key={edge.id}>
                    <path
                      d={d}
                      fill="none"
                      stroke="transparent"
                      strokeWidth={14}
                      className="pointer-events-auto cursor-pointer"
                      onPointerDown={(e) => e.stopPropagation()}
                      onClick={(e) => {
                        e.stopPropagation();
                        setSelectedEdgeId(edge.id);
                        setSelectedNodeId(null);
                      }}
                    />
                    <path
                      d={d}
                      fill="none"
                      stroke={selected ? "var(--color-danger)" : "var(--color-primary)"}
                      strokeWidth={selected ? 2.5 : 2}
                      markerEnd={selected ? "url(#flow-arrow-selected)" : "url(#flow-arrow)"}
                      className="pointer-events-none"
                    />
                    {anchor?.label && (
                      <text x={midX} y={(y1 + y2) / 2 - 6} textAnchor="middle" className="pointer-events-none fill-[var(--color-muted)] text-[11px] font-medium">
                        {anchor.label}
                      </text>
                    )}
                    {selected && canEdit && (
                      <foreignObject x={midX - 14} y={(y1 + y2) / 2 - 2} width={28} height={28} className="overflow-visible">
                        <button
                          onPointerDown={(e) => e.stopPropagation()}
                          onClick={(e) => {
                            e.stopPropagation();
                            deleteEdge(edge.id);
                          }}
                          className="flex h-7 w-7 items-center justify-center rounded-full border border-danger/40 bg-surface text-danger shadow-soft"
                          aria-label="Apagar ligação"
                          title="Apagar ligação (Delete)"
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </button>
                      </foreignObject>
                    )}
                  </g>
                );
              })}
            </svg>

            {nodes.map((node) => {
              const meta = NODE_META[node.type];
              const outputs = outputAnchors(node);
              const nodeIssues = issuesByNode.get(node.id);
              const preview = nodePreview(node, agentsById, schedulesById);
              const selected = selectedNodeId === node.id;
              return (
                <div
                  key={node.id}
                  onPointerDown={(e) => handleNodePointerDown(e, node)}
                  onPointerUp={(e) => {
                    if (pendingConnection && !(e.target as HTMLElement).closest("[data-connector]")) {
                      e.stopPropagation();
                      completeConnection(node.id);
                    }
                  }}
                  className={clsx(
                    "shadow-soft absolute select-none rounded-card border bg-surface",
                    canEdit ? "cursor-grab active:cursor-grabbing" : "cursor-pointer",
                    selected ? "border-primary ring-2 ring-primary/30" : nodeIssues ? "border-warning/60" : "border-border",
                    pendingConnection && pendingConnection.sourceNodeId !== node.id && "ring-2 ring-primary/20"
                  )}
                  style={{ left: node.positionX, top: node.positionY, width: NODE_WIDTH }}
                >
                  <div
                    className="flex items-center gap-2 rounded-t-card px-3 text-xs font-semibold"
                    style={{ height: HEADER_HEIGHT, backgroundColor: `${meta.color}14`, color: meta.color, borderBottom: `1px solid ${meta.color}26` }}
                  >
                    <meta.icon className="h-3.5 w-3.5 shrink-0" />
                    <span className="flex-1 truncate" title={meta.label}>{(node.data as { name?: string }).name?.trim() || meta.label}</span>
                    {(node.data as { image?: FlowImage | null }).image && <Image className="h-3.5 w-3.5 shrink-0" aria-label="Com foto" />}
                    {nodeIssues && (
                      <span title={nodeIssues.join("\n")} className="text-warning">
                        <AlertTriangle className="h-3.5 w-3.5" />
                      </span>
                    )}
                  </div>
                  {preview && <p className="line-clamp-2 px-3 py-2 text-xs text-muted">{preview}</p>}

                  {(node.type === "MENU" || node.type === "BUSINESS_HOURS") && outputs.length > 0 && (
                    <div className="space-y-1 px-3 pb-2 pt-2">
                      {outputs.map((out, i) => (
                        <div key={out.handle} className="flex h-[22px] items-center gap-1.5 rounded-md bg-surface-alt px-2 text-[11px]">
                          {node.type === "MENU" ? (
                            <span className="font-semibold text-muted">{i + 1}</span>
                          ) : (
                            <span className={clsx("h-2 w-2 rounded-full", out.handle === FLOW_HOURS_OPEN ? "bg-green-500" : "bg-gray-400")} />
                          )}
                          <span className="truncate">{out.label || <em className="text-muted">sem nome</em>}</span>
                        </div>
                      ))}
                    </div>
                  )}

                  {/* Output connectors on the right edge */}
                  {canEdit &&
                    outputs.map((out) => {
                      const active = pendingConnection?.sourceNodeId === node.id && pendingConnection.sourceHandle === out.handle;
                      return (
                        <button
                          key={out.handle ?? "out"}
                          data-connector
                          onPointerDown={(e) => e.stopPropagation()}
                          onClick={(e) => {
                            e.stopPropagation();
                            startConnection(node.id, out.handle);
                          }}
                          title="Clique aqui e depois no passo de destino"
                          aria-label={out.label ? `Ligar a opção ${out.label}` : "Ligar a um próximo passo"}
                          className={clsx(
                            "focus-ring absolute -right-[7px] h-3.5 w-3.5 -translate-y-1/2 rounded-full border-2 border-surface",
                            active ? "animate-pulse bg-primary" : "bg-muted hover:bg-primary"
                          )}
                          style={{ top: out.dy }}
                        />
                      );
                    })}

                  {node.type !== "START" && canEdit && selected && (
                    <button
                      data-connector
                      onPointerDown={(e) => e.stopPropagation()}
                      onClick={(e) => {
                        e.stopPropagation();
                        deleteNode(node.id);
                      }}
                      className="focus-ring absolute -right-2 -top-2 rounded-full border border-border bg-surface p-1 text-muted hover:bg-danger-soft hover:text-danger"
                      aria-label="Excluir passo"
                      title="Excluir passo (Delete)"
                    >
                      <Trash2 className="h-3 w-3" />
                    </button>
                  )}
                </div>
              );
            })}
          </div>

          {pendingConnection && (
            <div className="pointer-events-none absolute left-1/2 top-3 -translate-x-1/2 rounded-full bg-[var(--color-text)] px-3 py-1 text-xs text-surface shadow-elevated">
              Agora clique no passo de destino · Esc cancela
            </div>
          )}

          {/* Zoom controls */}
          <div className="absolute bottom-3 left-3 flex items-center gap-0.5 rounded-lg border border-border bg-surface p-0.5 shadow-soft" onPointerDown={(e) => e.stopPropagation()}>
            <button onClick={() => zoomBy(1 / 1.2)} className="focus-ring rounded-md p-1.5 text-muted hover:bg-surface-alt" aria-label="Diminuir zoom">
              <Minus className="h-4 w-4" />
            </button>
            <span className="w-11 text-center text-xs tabular-nums text-muted">{Math.round(view.zoom * 100)}%</span>
            <button onClick={() => zoomBy(1.2)} className="focus-ring rounded-md p-1.5 text-muted hover:bg-surface-alt" aria-label="Aumentar zoom">
              <Plus className="h-4 w-4" />
            </button>
            <button onClick={() => fitToScreen()} className="focus-ring rounded-md border-l border-border p-1.5 text-muted hover:bg-surface-alt" aria-label="Ajustar à tela" title="Ajustar à tela">
              <Maximize2 className="h-4 w-4" />
            </button>
          </div>
        </div>

        {/* Node inspector */}
        {selectedNode && (
          <NodeInspector
            node={selectedNode}
            agents={agents ?? []}
            workSchedules={workSchedules ?? []}
            disabled={!canEdit}
            issues={issuesByNode.get(selectedNode.id) ?? []}
            onChange={(data, field) => updateNodeData(selectedNode.id, data, field)}
            onClose={() => setSelectedNodeId(null)}
          />
        )}
      </div>
    </div>
  );
}

function NodeInspector({
  node,
  agents,
  workSchedules,
  disabled,
  issues,
  onChange,
  onClose,
}: {
  node: FlowNodeDTO;
  agents: AgentOption[];
  workSchedules: WorkScheduleOptionDTO[];
  disabled: boolean;
  issues: string[];
  onChange: (data: FlowNodeData, field?: string) => void;
  onClose: () => void;
}) {
  const meta = NODE_META[node.type];
  const textRef = useRef<HTMLTextAreaElement>(null);
  const [agentSearch, setAgentSearch] = useState("");

  return (
    <div className="absolute inset-y-0 right-0 z-20 flex w-80 shrink-0 flex-col border-l border-border bg-surface shadow-elevated md:relative md:shadow-none">
      <div className="flex items-center gap-2 border-b border-border px-4 py-3">
        <span className="flex h-7 w-7 items-center justify-center rounded-md" style={{ backgroundColor: `${meta.color}1A`, color: meta.color }}>
          <meta.icon className="h-4 w-4" />
        </span>
        <p className="flex-1 text-sm font-semibold">{meta.label}</p>
        <button onClick={onClose} className="focus-ring rounded-lg p-1 text-muted hover:bg-surface-alt" aria-label="Fechar painel do passo">
          <X className="h-4 w-4" />
        </button>
      </div>
      <div className="flex-1 space-y-4 overflow-y-auto p-4">
        {issues.length > 0 && (
          <div className="space-y-1 rounded-lg bg-warning-soft px-3 py-2 text-xs text-warning">
            {issues.map((issue, i) => (
              <p key={i} className="flex items-start gap-1.5">
                <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" /> {issue}
              </p>
            ))}
          </div>
        )}

        {node.type !== "START" && node.type !== "END" && (
          <label className="block">
            <span className="mb-1 block text-xs font-medium text-muted">Nome do passo</span>
            <input
              disabled={disabled}
              value={(node.data as { name?: string }).name ?? ""}
              onChange={(e) => onChange({ ...(node.data as object), name: e.target.value } as FlowNodeData, "name")}
              placeholder={`${meta.label} — ex.: Guias, Cidades, Vendas`}
              maxLength={60}
              className="focus-ring w-full rounded-lg border border-border bg-surface px-2.5 py-1.5 text-sm"
            />
            <span className="mt-1 block text-[11px] text-muted">Aparece no desenho e nas notas para o atendente.</span>
          </label>
        )}

        {node.type === "TEXT_MESSAGE" && (
          <>
            <label className="block">
              <span className="mb-1 block text-xs font-medium text-muted">Texto da mensagem</span>
              <textarea
                ref={textRef}
                disabled={disabled}
                value={(node.data as { text?: string }).text ?? ""}
                onChange={(e) => onChange({ ...(node.data as object), text: e.target.value } as FlowNodeData, "text")}
                rows={5}
                maxLength={4096}
                placeholder="Olá! Como podemos ajudar?"
                className="focus-ring w-full resize-none rounded-card border border-border bg-transparent px-3 py-2 text-sm disabled:opacity-60"
              />
            </label>
            {!disabled && (
              <div className="flex flex-wrap items-center gap-1.5">
                <span className="text-[11px] text-muted">Inserir:</span>
                {VARIABLES.map((v) => (
                  <button
                    key={v.tag}
                    onClick={() => {
                      const el = textRef.current;
                      const current = (node.data as { text?: string }).text ?? "";
                      const pos = el?.selectionStart ?? current.length;
                      onChange({ ...(node.data as object), text: current.slice(0, pos) + v.tag + current.slice(pos) } as FlowNodeData, "text");
                      requestAnimationFrame(() => el?.focus());
                    }}
                    className="focus-ring rounded-full border border-border px-2 py-0.5 font-mono text-[11px] text-primary hover:border-primary/40"
                    title={v.label}
                  >
                    {v.tag}
                  </button>
                ))}
              </div>
            )}
            <FlowImageField disabled={disabled} image={(node.data as { image?: FlowImage | null }).image ?? null} onChange={(image) => onChange({ ...(node.data as object), image } as FlowNodeData, "image")} />
            <WhatsAppPreview text={PREVIEW_VARS((node.data as { text?: string }).text ?? "")} image={(node.data as { image?: FlowImage | null }).image ?? null} />
          </>
        )}

        {node.type === "MENU" && (
          <>
            <label className="block">
              <span className="mb-1 block text-xs font-medium text-muted">Pergunta</span>
              <textarea
                disabled={disabled}
                value={(node.data as { prompt?: string }).prompt ?? ""}
                onChange={(e) => onChange({ ...(node.data as { options: { id: string; label: string }[] }), prompt: e.target.value }, "prompt")}
                placeholder={FLOW_MENU_DEFAULT_PROMPT}
                maxLength={MAX_MENU_PROMPT}
                rows={4}
                className="focus-ring w-full resize-y rounded-lg border border-border bg-surface px-2.5 py-1.5 text-sm"
              />
            </label>
            <MenuOptionsEditor disabled={disabled} options={menuOptions(node)} onChange={(options) => onChange({ ...(node.data as object), options }, "options")} />
            {menuOptions(node).length > 0 && (
              <>
                <p className="text-xs text-muted">
                  Na conexão por QR Code o cliente responde com o número ou com o nome da opção. Na API Oficial, até 3 opções curtas viram botões e até 10 viram
                  uma lista. Depois de 3 respostas que não batem com nenhuma opção, a conversa vai para a fila.
                </p>
                <MenuNavigationField
                  disabled={disabled}
                  navigation={(node.data as { navigation?: FlowMenuNavigation }).navigation}
                  onChange={(navigation) => onChange({ ...(node.data as object), navigation } as FlowNodeData, "navigation")}
                />
                <FlowImageField disabled={disabled} image={(node.data as { image?: FlowImage | null }).image ?? null} onChange={(image) => onChange({ ...(node.data as object), image } as FlowNodeData, "image")} />
                <WhatsAppPreview
                  text={PREVIEW_VARS(
                    renderFlowMenuText({
                      prompt: (node.data as { prompt?: string }).prompt,
                      options: [
                        ...menuOptions(node).map((o) => ({ ...o, label: o.label || "…" })),
                        ...flowMenuNavOptions((node.data as { navigation?: FlowMenuNavigation }).navigation, true),
                      ],
                    })
                  )}
                  image={(node.data as { image?: FlowImage | null }).image ?? null}
                />
              </>
            )}
          </>
        )}

        {node.type === "TRANSFER_TO_AGENT" &&
          (() => {
            const data = node.data as { assignedAgentIds?: string[]; mode?: "any" | "selected" };
            const ids = data.assignedAgentIds ?? [];
            const mode = data.mode ?? (ids.length ? "selected" : "any");
            const q = agentSearch.trim().toLowerCase();
            const visibleAgents = agents.filter((a) => !q || a.displayName.toLowerCase().includes(q));
            return (
              <div className="space-y-3">
                <div className="space-y-1.5">
                  {(
                    [
                      { value: "any", label: "Qualquer atendente disponível", hint: "Vai para a fila da conexão por onde o cliente entrou" },
                      {
                        value: "selected",
                        label: "Somente os atendentes selecionados",
                        hint: "Atendem de qualquer conexão: vai direto para o selecionado online menos ocupado. Sem nenhum deles online, vai para Abandonados; sem ninguém online, espera neste passo.",
                      },
                    ] as const
                  ).map((opt) => (
                    <label
                      key={opt.value}
                      className={clsx(
                        "flex cursor-pointer items-start gap-2 rounded-lg border px-3 py-2",
                        mode === opt.value ? "border-primary bg-primary/[0.06]" : "border-border"
                      )}
                    >
                      <input
                        type="radio"
                        name={`transfer-mode-${node.id}`}
                        disabled={disabled}
                        checked={mode === opt.value}
                        onChange={() => onChange({ ...(node.data as object), assignedAgentIds: opt.value === "any" ? [] : ids, mode: opt.value } as FlowNodeData, "mode")}
                        className="mt-0.5 accent-[var(--color-primary)]"
                      />
                      <span>
                        <span className="block text-sm font-medium">{opt.label}</span>
                        <span className="block text-xs text-muted">{opt.hint}</span>
                      </span>
                    </label>
                  ))}
                </div>
                {mode === "selected" && (
                  <div>
                    <label className="mb-1.5 flex items-center gap-2 rounded-lg border border-border px-2 py-1.5 text-xs focus-within:border-primary/50">
                      <Search className="h-3.5 w-3.5 shrink-0 text-muted" />
                      <input value={agentSearch} onChange={(e) => setAgentSearch(e.target.value)} placeholder="Buscar atendente" className="min-w-0 flex-1 bg-transparent outline-none" />
                    </label>
                    <p className="mb-1 text-[11px] text-muted">{ids.length} selecionado(s)</p>
                    <div className="max-h-64 overflow-y-auto rounded-card border border-border">
                      {visibleAgents.length === 0 && <p className="p-3 text-center text-xs text-muted">Nenhum atendente encontrado.</p>}
                      {visibleAgents.map((agent) => {
                        const checked = ids.includes(agent.id);
                        return (
                          <label key={agent.id} className="flex items-center gap-2 border-b border-border px-2.5 py-2 text-sm last:border-b-0 hover:bg-surface-alt">
                            <input
                              type="checkbox"
                              disabled={disabled}
                              checked={checked}
                              onChange={() =>
                                onChange({ ...(node.data as object), assignedAgentIds: checked ? ids.filter((aid) => aid !== agent.id) : [...ids, agent.id], mode: "selected" } as FlowNodeData, "agents")
                              }
                              className="h-4 w-4 accent-[var(--color-primary)]"
                            />
                            <span className={clsx("h-2 w-2 shrink-0 rounded-full", PRESENCE_DOT[agent.presence])} />
                            <span className="min-w-0 flex-1 truncate">{agent.displayName}</span>
                            <span className="shrink-0 text-[11px] text-muted">
                              {agent.presence === "AWAY" ? (agent.pauseReasonName ?? "Pausado") : agent.presence === "ONLINE" ? "Online" : "Offline"}
                            </span>
                          </label>
                        );
                      })}
                    </div>
                  </div>
                )}
              </div>
            );
          })()}

        {node.type === "BUSINESS_HOURS" &&
          (() => {
            const data = node.data as FlowBusinessHoursData;
            const legacy = !data.workScheduleId && data.days;
            return (
              <div className="space-y-3">
                <p className="text-xs text-muted">
                  Dentro do horário, o cliente segue pela saída <strong className="text-success">Aberto</strong>; fora dele, pela saída <strong>Fechado</strong>. Escolha um horário
                  de expediente já cadastrado em Respostas.
                </p>
                <label className="block">
                  <span className="mb-1 block text-xs font-medium text-muted">Horário de expediente</span>
                  <select
                    disabled={disabled}
                    value={data.workScheduleId ?? ""}
                    onChange={(e) => onChange({ ...(node.data as object), workScheduleId: e.target.value || null } as FlowNodeData, "workScheduleId")}
                    className="focus-ring w-full rounded-lg border border-border bg-surface px-2.5 py-1.5 text-sm"
                  >
                    <option value="">{legacy ? "Horário próprio deste nó" : "Sem horário (sempre aberto)"}</option>
                    {workSchedules.map((w) => (
                      <option key={w.id} value={w.id}>
                        {w.name}
                      </option>
                    ))}
                  </select>
                </label>
                {legacy && (
                  <p className="rounded-lg bg-surface-alt px-2.5 py-2 text-xs text-muted">
                    Este nó usa um horário próprio ({describeDays(data.days ?? [])}, {data.start}–{data.end}). Escolha um horário de expediente para substituí-lo.
                  </p>
                )}
                <p className="text-xs text-muted">Se a conexão do fluxo já tem um horário de expediente em Conexões, o da conexão vale e este é ignorado.</p>
              </div>
            );
          })()}

        {node.type === "START" &&
          (() => {
            const data = node.data as FlowStartData;
            return (
              <div className="space-y-4">
                <p className="text-sm text-muted">Ponto de entrada do fluxo — toda conversa nova começa por aqui. Ligue-o ao primeiro passo.</p>
                <label className="flex items-start gap-2 rounded-lg border border-border px-3 py-2">
                  <input
                    type="checkbox"
                    disabled={disabled}
                    checked={Boolean(data.outOfHoursPrompt)}
                    onChange={(e) => onChange({ ...data, outOfHoursPrompt: e.target.checked }, "outOfHoursPrompt")}
                    className="mt-0.5 h-4 w-4 accent-[var(--color-primary)]"
                  />
                  <span>
                    <span className="block text-sm font-medium">Avisar quando estiver fora do horário</span>
                    <span className="block text-xs text-muted">
                      Fora do Horário de expediente da conexão de entrada, o fluxo começa contando o horário de atendimento e perguntando se o cliente quer seguir. No
                      lugar da mensagem de fechado da conexão.
                    </span>
                  </span>
                </label>
                <label className="block">
                  <span className="mb-1 block text-xs font-medium text-muted">Minutos sem resposta nos menus para ir a Abandonados</span>
                  <input
                    type="number"
                    min={1}
                    max={1440}
                    disabled={disabled}
                    value={data.abandonAfterMinutes ?? FLOW_ABANDON_AFTER_MINUTES_DEFAULT}
                    onChange={(e) => onChange({ ...data, abandonAfterMinutes: Math.max(1, Math.min(1440, Number(e.target.value) || FLOW_ABANDON_AFTER_MINUTES_DEFAULT)) }, "abandonAfterMinutes")}
                    className="focus-ring w-28 rounded-lg border border-border bg-surface px-2.5 py-1.5 text-sm"
                  />
                  <span className="mt-1 block text-[11px] text-muted">O cliente recebe um aviso e a conversa vai para Abandonados, com uma nota de onde ele parou.</span>
                </label>
              </div>
            );
          })()}

        {node.type === "END" && (
          <p className="text-sm text-muted">Encerra a conversa sem passar por um atendente. Use depois de uma mensagem final; para levar o cliente até a equipe, use Transferir.</p>
        )}
      </div>
    </div>
  );
}

/** How the message will look on the customer's WhatsApp. */
function WhatsAppPreview({ text, image }: { text: string; image?: FlowImage | null }) {
  const imageUrl = useFlowImageUrl(image ?? null);
  return (
    <div>
      <p className="mb-1.5 text-xs font-medium text-muted">Prévia no WhatsApp</p>
      <div className="rounded-card bg-[#efeae2] p-3 dark:bg-[#0b141a]">
        <div className="ml-auto max-w-[90%] whitespace-pre-wrap break-words rounded-lg rounded-tr-none bg-[#d9fdd3] px-2.5 py-1.5 text-[13px] text-[#111b21] shadow-sm dark:bg-[#005c4b] dark:text-[#e9edef]">
          {imageUrl && <img src={imageUrl} alt="" className="-mx-1 mb-1.5 mt-0.5 block w-[calc(100%+0.5rem)] max-w-none rounded-md" />}
          {text.trim() ? <WhatsAppFormatted text={text} /> : <span className="opacity-50">Digite o texto da mensagem…</span>}
          <span className="ml-2 inline-block align-bottom text-[10px] opacity-60">10:42</span>
        </div>
      </div>
    </div>
  );
}

function MenuOptionsEditor({
  options,
  onChange,
  disabled,
}: {
  options: { id: string; label: string }[];
  onChange: (options: { id: string; label: string }[]) => void;
  disabled: boolean;
}) {
  return (
    <div>
      <p className="mb-1.5 text-xs font-medium text-muted">Opções (cada uma vira uma saída deste passo)</p>
      <div className="space-y-1.5">
        {options.map((opt, i) => (
          <div key={opt.id} className="flex items-center gap-1.5">
            <span className="w-4 shrink-0 text-center text-xs font-semibold text-muted">{i + 1}</span>
            <input
              disabled={disabled}
              value={opt.label}
              onChange={(e) => onChange(options.map((o, j) => (j === i ? { ...o, label: e.target.value } : o)))}
              placeholder={`Opção ${i + 1}`}
              maxLength={60}
              className="focus-ring min-w-0 flex-1 rounded-card border border-border bg-transparent px-2 py-1.5 text-sm disabled:opacity-60"
            />
            {!disabled && (
              <button
                onClick={() => onChange(options.filter((_, j) => j !== i))}
                className="focus-ring shrink-0 rounded-card p-1 text-muted hover:bg-danger-soft hover:text-danger"
                aria-label={`Remover opção ${i + 1}`}
              >
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            )}
          </div>
        ))}
      </div>
      {!disabled && (
        <button onClick={() => onChange([...options, { id: crypto.randomUUID(), label: "" }])} className="focus-ring mt-2 text-xs font-medium text-primary hover:underline">
          + Adicionar opção
        </button>
      )}
    </div>
  );
}

/** The step's photo for the editor (fetched with the session, like the Respostas attachment preview). */
function useFlowImageUrl(image: FlowImage | null) {
  const { data } = useQuery({
    queryKey: ["flow-media", image?.storageKey],
    queryFn: async () => URL.createObjectURL((await api.get<Blob>(`/flows/media/${image!.storageKey}`, { responseType: "blob" })).data),
    enabled: Boolean(image?.storageKey),
    staleTime: Infinity,
  });
  return image ? (data ?? null) : null;
}

/** A photo sent with this step — above the text (QR Code), or with the buttons (API Oficial). */
function FlowImageField({ image, onChange, disabled }: { image: FlowImage | null; onChange: (image: FlowImage | null) => void; disabled: boolean }) {
  const inputRef = useRef<HTMLInputElement>(null);
  const upload = useMutation({
    mutationFn: async (file: File) => {
      const form = new FormData();
      form.append("file", file);
      return (await api.post<FlowImage>("/flows/media", form, { headers: { "Content-Type": "multipart/form-data" } })).data;
    },
    onSuccess: (uploaded) => onChange(uploaded),
    onError: (err) => toast.error(getApiErrorMessage(err)),
  });
  return (
    <div>
      <p className="mb-1.5 text-xs font-medium text-muted">Foto (opcional)</p>
      {image ? (
        <div className="flex items-center gap-2 rounded-lg border border-border px-2.5 py-1.5 text-xs">
          <Image className="h-3.5 w-3.5 shrink-0 text-primary" />
          <span className="min-w-0 flex-1 truncate">{image.fileName}</span>
          {!disabled && (
            <button onClick={() => onChange(null)} className="focus-ring rounded p-0.5 text-muted hover:text-danger" aria-label="Remover foto">
              <X className="h-3.5 w-3.5" />
            </button>
          )}
        </div>
      ) : (
        !disabled && (
          <button
            onClick={() => inputRef.current?.click()}
            disabled={upload.isPending}
            className="focus-ring flex items-center gap-1.5 rounded-lg border border-dashed border-border px-2.5 py-1.5 text-xs font-medium text-primary hover:border-primary/40 disabled:opacity-60"
          >
            <Image className="h-3.5 w-3.5" /> {upload.isPending ? "Enviando..." : "Escolher foto"}
          </button>
        )
      )}
      <input
        ref={inputRef}
        type="file"
        accept="image/jpeg,image/png,image/webp"
        hidden
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) upload.mutate(file);
          e.target.value = "";
        }}
      />
    </div>
  );
}

/** *negrito* as WhatsApp shows it. */
function WhatsAppFormatted({ text }: { text: string }) {
  return (
    <>
      {text.split(/(\*[^*\n]+\*)/g).map((part, i) =>
        part.length > 2 && part.startsWith("*") && part.endsWith("*") ? <strong key={i}>{part.slice(1, -1)}</strong> : <span key={i}>{part}</span>
      )}
    </>
  );
}

const MENU_NAVIGATION_FIELDS: { key: keyof FlowMenuNavigation; hint: string }[] = [
  { key: "back", hint: "Volta para o menu anterior." },
  { key: "home", hint: "Volta para o primeiro menu do fluxo." },
  { key: "end", hint: "Encerra a conversa na hora, sem enviar a pesquisa de satisfação." },
];

/** Voltar / Menu inicial / Encerrar atendimento: on by default, numbered after the menu's own options (QR Code). */
function MenuNavigationField({
  disabled,
  navigation,
  onChange,
}: {
  disabled: boolean;
  navigation: FlowMenuNavigation | undefined;
  onChange: (navigation: FlowMenuNavigation) => void;
}) {
  return (
    <div className="space-y-1.5">
      <span className="block text-xs font-medium text-muted">Opções de navegação (QR Code)</span>
      {MENU_NAVIGATION_FIELDS.map(({ key, hint }) => (
        <label key={key} className="flex items-start gap-2 rounded-lg border border-border px-3 py-2">
          <input
            type="checkbox"
            disabled={disabled}
            checked={navigation?.[key] !== false}
            onChange={(e) => onChange({ ...navigation, [key]: e.target.checked })}
            className="mt-0.5 h-4 w-4 accent-[var(--color-primary)]"
          />
          <span>
            <span className="block text-sm font-medium">{FLOW_MENU_NAV_OPTIONS[key].label}</span>
            <span className="block text-xs text-muted">{hint}</span>
          </span>
        </label>
      ))}
      <p className="text-xs text-muted">Aparecem numeradas depois das opções do menu. Voltar e Menu inicial não aparecem no primeiro menu do fluxo.</p>
    </div>
  );
}
