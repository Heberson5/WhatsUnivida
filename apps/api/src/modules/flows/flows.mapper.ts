import type { Prisma } from "@prisma/client";
import { validateFlowGraph, type FlowDetailDTO, type FlowEdgeDTO, type FlowListItemDTO, type FlowNodeData, type FlowNodeDTO, type FlowNodeType } from "@whatsatendende/types";

// The list carries the graph too (flows are small) so each card can draw a
// thumbnail and say what still blocks activation.
const flowListInclude = {
  connections: { include: { whatsappConnection: { select: { id: true, name: true } } } },
  createdBy: { select: { displayName: true } },
  _count: { select: { nodes: true } },
  nodes: true,
  edges: true,
} satisfies Prisma.FlowInclude;

type FlowListRow = Prisma.FlowGetPayload<{ include: typeof flowListInclude }>;

const flowDetailInclude = flowListInclude;

type FlowDetailRow = Prisma.FlowGetPayload<{ include: typeof flowDetailInclude }>;

export const FLOW_LIST_INCLUDE = flowListInclude;
export const FLOW_DETAIL_INCLUDE = flowDetailInclude;

export function toFlowListItemDTO(row: FlowListRow): FlowListItemDTO {
  const nodes = row.nodes.map(toFlowNodeDTO);
  const indexById = new Map(nodes.map((n, i) => [n.id, i]));
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    active: row.active,
    connectionIds: row.connections.map((c) => c.whatsappConnectionId),
    connectionNames: row.connections.map((c) => c.whatsappConnection.name),
    nodeCount: row._count.nodes,
    preview: {
      nodes: nodes.map((n) => ({ x: n.positionX, y: n.positionY, type: n.type })),
      edges: row.edges
        .map((e) => [indexById.get(e.sourceNodeId), indexById.get(e.targetNodeId)])
        .filter((pair): pair is [number, number] => pair[0] !== undefined && pair[1] !== undefined),
    },
    issues: validateFlowGraph({ nodes, edges: row.edges, connectionCount: row.connections.length }),
    createdByUserName: row.createdBy?.displayName ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export function toFlowNodeDTO(row: { id: string; type: string; positionX: number; positionY: number; data: Prisma.JsonValue }): FlowNodeDTO {
  return {
    id: row.id,
    type: row.type as FlowNodeType,
    positionX: row.positionX,
    positionY: row.positionY,
    data: (row.data ?? {}) as FlowNodeData,
  };
}

export function toFlowEdgeDTO(row: { id: string; sourceNodeId: string; targetNodeId: string; sourceHandle: string | null }): FlowEdgeDTO {
  return { id: row.id, sourceNodeId: row.sourceNodeId, targetNodeId: row.targetNodeId, sourceHandle: row.sourceHandle };
}

export function toFlowDetailDTO(row: FlowDetailRow): FlowDetailDTO {
  return {
    ...toFlowListItemDTO(row),
    nodes: row.nodes.map(toFlowNodeDTO),
    edges: row.edges.map(toFlowEdgeDTO),
  };
}
