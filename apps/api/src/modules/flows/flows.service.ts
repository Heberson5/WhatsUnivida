import { prisma } from "../../lib/prisma";
import { Errors } from "../../lib/http-error";
import type { FlowNodeType } from "@prisma/client";
import { FLOW_HOURS_CLOSED, FLOW_HOURS_OPEN, validateFlowGraph } from "@whatsatendende/types";
import { FLOW_DETAIL_INCLUDE, FLOW_LIST_INCLUDE, toFlowEdgeDTO, toFlowNodeDTO } from "./flows.mapper";

export type FlowTemplate = "welcome" | "after-hours";

type TemplateNode = { key: string; type: FlowNodeType; x: number; y: number; data: object };
type TemplateEdge = { from: string; to: string; handle?: string };

// Ready-made starting points offered on Fluxo's empty state.
const TEMPLATES: Record<FlowTemplate, { nodes: TemplateNode[]; edges: TemplateEdge[] }> = {
  welcome: {
    nodes: [
      { key: "start", type: "START", x: 60, y: 200, data: {} },
      { key: "hello", type: "TEXT_MESSAGE", x: 320, y: 200, data: { text: "Olá, {{cliente}}! 👋 Bem-vindo ao nosso atendimento." } },
      { key: "menu", type: "MENU", x: 600, y: 180, data: { options: [{ id: "opt-vendas", label: "Vendas" }, { id: "opt-suporte", label: "Suporte" }, { id: "opt-financeiro", label: "Financeiro" }] } },
      { key: "vendas", type: "TRANSFER_TO_AGENT", x: 900, y: 60, data: { assignedAgentIds: [], mode: "any" } },
      { key: "suporte", type: "TRANSFER_TO_AGENT", x: 900, y: 220, data: { assignedAgentIds: [], mode: "any" } },
      { key: "financeiro", type: "TRANSFER_TO_AGENT", x: 900, y: 380, data: { assignedAgentIds: [], mode: "any" } },
    ],
    edges: [
      { from: "start", to: "hello" },
      { from: "hello", to: "menu" },
      { from: "menu", to: "vendas", handle: "opt-vendas" },
      { from: "menu", to: "suporte", handle: "opt-suporte" },
      { from: "menu", to: "financeiro", handle: "opt-financeiro" },
    ],
  },
  "after-hours": {
    nodes: [
      { key: "start", type: "START", x: 60, y: 200, data: {} },
      // Mon–Fri 08:00–18:00, Brasília (UTC-3 → getTimezoneOffset() = 180).
      { key: "hours", type: "BUSINESS_HOURS", x: 300, y: 190, data: { days: [1, 2, 3, 4, 5], start: "08:00", end: "18:00", tzOffsetMinutes: 180 } },
      { key: "queue", type: "TRANSFER_TO_AGENT", x: 620, y: 80, data: { assignedAgentIds: [], mode: "any" } },
      {
        key: "closed",
        type: "TEXT_MESSAGE",
        x: 620,
        y: 300,
        data: { text: "Olá, {{cliente}}! No momento estamos fora do horário de atendimento. Sua mensagem foi registrada e responderemos assim que voltarmos." },
      },
      { key: "later", type: "TRANSFER_TO_AGENT", x: 920, y: 300, data: { assignedAgentIds: [], mode: "any" } },
    ],
    edges: [
      { from: "start", to: "hours" },
      { from: "hours", to: "queue", handle: FLOW_HOURS_OPEN },
      { from: "hours", to: "closed", handle: FLOW_HOURS_CLOSED },
      { from: "closed", to: "later" },
    ],
  },
};

/** Refuses to leave a flow switched on while something in it is broken. */
function assertActivatable(nodes: Parameters<typeof validateFlowGraph>[0]["nodes"], edges: Parameters<typeof validateFlowGraph>[0]["edges"], connectionCount: number) {
  const issues = validateFlowGraph({ nodes, edges, connectionCount });
  if (issues.length > 0) {
    const shown = issues.slice(0, 3).map((i) => i.message).join("; ");
    throw Errors.badRequest(`O fluxo ativo precisa estar completo: ${shown}${issues.length > 3 ? ` (e mais ${issues.length - 3})` : ""}`);
  }
}

export interface FlowMetaInput {
  name: string;
  description?: string | null;
  connectionIds?: string[];
}

async function assertConnectionsExist(connectionIds: string[]): Promise<void> {
  if (connectionIds.length === 0) return;
  const count = await prisma.whatsAppConnection.count({ where: { id: { in: connectionIds } } });
  if (count !== connectionIds.length) throw Errors.badRequest("Uma ou mais conexoes informadas nao existem");
}

/** Each connection runs at most one flow at a time — otherwise which one answers a new conversation would be arbitrary. */
async function assertNoOtherActiveFlow(flowId: string, connectionIds: string[]): Promise<void> {
  if (connectionIds.length === 0) return;
  const clash = await prisma.flowConnection.findFirst({
    where: { whatsappConnectionId: { in: connectionIds }, flowId: { not: flowId }, flow: { active: true } },
    select: { flow: { select: { name: true } }, whatsappConnection: { select: { name: true } } },
  });
  if (clash) {
    throw Errors.conflict(`A conexão “${clash.whatsappConnection.name}” já tem o fluxo “${clash.flow.name}” ativo. Desative-o antes de ativar este.`);
  }
}

export async function listFlows() {
  return prisma.flow.findMany({ include: FLOW_LIST_INCLUDE, orderBy: { createdAt: "desc" } });
}

export async function getFlowDetail(id: string) {
  const row = await prisma.flow.findUnique({ where: { id }, include: FLOW_DETAIL_INCLUDE });
  if (!row) throw Errors.notFound("Fluxo nao encontrado");
  return row;
}

/** A brand-new flow always starts with a single START node — the canvas's one fixed entry point, see FlowNodeType.START. */
export async function createFlow(input: FlowMetaInput & { template?: FlowTemplate }, createdByUserId: string) {
  const connectionIds = input.connectionIds ?? [];
  await assertConnectionsExist(connectionIds);

  const flow = await prisma.flow.create({
    data: {
      name: input.name,
      description: input.description || null,
      createdByUserId,
      connections: { create: connectionIds.map((whatsappConnectionId) => ({ whatsappConnectionId })) },
      ...(input.template ? {} : { nodes: { create: [{ type: "START" as const, positionX: 80, positionY: 160, data: {} }] } }),
    },
    select: { id: true },
  });
  if (input.template) {
    const template = TEMPLATES[input.template];
    await saveFlowGraph(
      flow.id,
      template.nodes.map((n) => ({ id: n.key, type: n.type, positionX: n.x, positionY: n.y, data: n.data as Record<string, unknown> })),
      template.edges.map((e) => ({ sourceNodeId: e.from, targetNodeId: e.to, sourceHandle: e.handle ?? null }))
    );
  }
  return prisma.flow.findUniqueOrThrow({ where: { id: flow.id }, include: FLOW_LIST_INCLUDE });
}

/** A copy of a flow (graph and connections), always created switched off. */
export async function duplicateFlow(id: string, createdByUserId: string) {
  const source = await getFlowDetail(id);
  const copy = await prisma.flow.create({
    data: {
      name: `${source.name} (cópia)`.slice(0, 120),
      description: source.description,
      createdByUserId,
      connections: { create: source.connections.map((c) => ({ whatsappConnectionId: c.whatsappConnectionId })) },
    },
    select: { id: true },
  });
  await saveFlowGraph(
    copy.id,
    source.nodes.map((n) => ({ id: n.id, type: n.type, positionX: n.positionX, positionY: n.positionY, data: (n.data ?? {}) as Record<string, unknown> })),
    source.edges.map((e) => ({ sourceNodeId: e.sourceNodeId, targetNodeId: e.targetNodeId, sourceHandle: e.sourceHandle }))
  );
  return prisma.flow.findUniqueOrThrow({ where: { id: copy.id }, include: FLOW_LIST_INCLUDE });
}

export async function updateFlowMeta(id: string, input: Partial<FlowMetaInput> & { active?: boolean }) {
  const existing = await prisma.flow.findUnique({ where: { id }, include: { nodes: true, edges: true, connections: true } });
  if (!existing) throw Errors.notFound("Fluxo nao encontrado");

  if (input.connectionIds) await assertConnectionsExist(input.connectionIds);
  const willBeActive = input.active ?? existing.active;
  if (willBeActive && (input.active === true || input.connectionIds)) {
    const connectionIds = input.connectionIds ?? existing.connections.map((c) => c.whatsappConnectionId);
    assertActivatable(existing.nodes.map(toFlowNodeDTO), existing.edges.map(toFlowEdgeDTO), connectionIds.length);
    await assertNoOtherActiveFlow(id, connectionIds);
  }

  await prisma.$transaction(async (tx) => {
    await tx.flow.update({
      where: { id },
      data: {
        name: input.name,
        description: input.description === undefined ? undefined : input.description || null,
        active: input.active,
      },
    });
    if (input.connectionIds) {
      await tx.flowConnection.deleteMany({ where: { flowId: id } });
      if (input.connectionIds.length > 0) {
        await tx.flowConnection.createMany({ data: input.connectionIds.map((whatsappConnectionId) => ({ flowId: id, whatsappConnectionId })) });
      }
    }
  });

  return prisma.flow.findUniqueOrThrow({ where: { id }, include: FLOW_LIST_INCLUDE });
}

export async function deleteFlow(id: string): Promise<void> {
  const existing = await prisma.flow.findUnique({ where: { id }, select: { id: true } });
  if (!existing) throw Errors.notFound("Fluxo nao encontrado");
  // FlowConnection/FlowNode/FlowEdge/FlowSession all cascade from Flow.
  await prisma.flow.delete({ where: { id } });
}

export interface FlowGraphNodeInput {
  id: string; // client-assigned — a real UUID for an existing node, any unique string for a new one
  type: FlowNodeType;
  positionX: number;
  positionY: number;
  data?: Record<string, unknown>;
}

export interface FlowGraphEdgeInput {
  sourceNodeId: string; // one of the client ids above
  targetNodeId: string;
  sourceHandle?: string | null;
}

/**
 * Replaces the flow's entire node/edge set in one shot — the simplest
 * correct way to persist what a visual canvas editor holds client-side,
 * rather than diffing adds/moves/deletes against the previous graph. Every
 * save gets fresh node/edge ids; nothing downstream depends on a node's id
 * staying stable across saves — a customer waiting on a menu of an active
 * flow that gets re-saved is simply handed to the queue by the engine
 * (see flow-engine.service.ts) when their answer arrives.
 */
export async function saveFlowGraph(flowId: string, nodes: FlowGraphNodeInput[], edges: FlowGraphEdgeInput[]) {
  const existing = await prisma.flow.findUnique({ where: { id: flowId }, select: { id: true, active: true, _count: { select: { connections: true } } } });
  if (!existing) throw Errors.notFound("Fluxo nao encontrado");
  if (existing.active) {
    assertActivatable(
      nodes.map((n) => ({ id: n.id, type: n.type, positionX: n.positionX, positionY: n.positionY, data: (n.data ?? {}) as never })),
      edges.map((e) => ({ sourceNodeId: e.sourceNodeId, sourceHandle: e.sourceHandle ?? null })),
      existing._count.connections
    );
  }

  const clientIds = new Set(nodes.map((n) => n.id));
  for (const edge of edges) {
    if (!clientIds.has(edge.sourceNodeId) || !clientIds.has(edge.targetNodeId)) {
      throw Errors.badRequest("Uma aresta referencia um no que nao existe neste salvamento");
    }
  }
  if (!nodes.some((n) => n.type === "START")) {
    throw Errors.badRequest("O fluxo precisa ter um no de Inicio");
  }

  await prisma.$transaction(async (tx) => {
    await tx.flowEdge.deleteMany({ where: { flowId } });
    await tx.flowNode.deleteMany({ where: { flowId } });

    const idMap = new Map<string, string>();
    for (const node of nodes) {
      const created = await tx.flowNode.create({
        data: { flowId, type: node.type, positionX: node.positionX, positionY: node.positionY, data: (node.data ?? {}) as object },
        select: { id: true },
      });
      idMap.set(node.id, created.id);
    }

    if (edges.length > 0) {
      await tx.flowEdge.createMany({
        data: edges.map((edge) => ({
          flowId,
          sourceNodeId: idMap.get(edge.sourceNodeId)!,
          targetNodeId: idMap.get(edge.targetNodeId)!,
          sourceHandle: edge.sourceHandle ?? null,
        })),
      });
    }
  });

  return getFlowDetail(flowId);
}
