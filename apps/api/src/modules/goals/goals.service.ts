import type { Goal } from "@prisma/client";
import type { GoalDTO, GoalScope, GoalType, MyDayGoalDTO } from "@whatsatendende/types";
import { prisma } from "../../lib/prisma";
import { Errors } from "../../lib/http-error";

export function toGoalDTO(goal: Goal): GoalDTO {
  return {
    id: goal.id,
    type: goal.type,
    target: goal.target,
    active: goal.active,
    scope: goal.scope,
    connectionIds: goal.connectionIds,
    agentIds: goal.agentIds,
  };
}

export interface GoalInput {
  type: GoalType;
  target: number;
  active: boolean;
  scope: GoalScope;
  connectionIds: string[];
  agentIds: string[];
}

export async function listGoals(): Promise<GoalDTO[]> {
  return (await prisma.goal.findMany({ orderBy: [{ type: "asc" }, { createdAt: "asc" }] })).map(toGoalDTO);
}

export async function createGoal(input: GoalInput): Promise<GoalDTO> {
  return toGoalDTO(await prisma.goal.create({ data: input }));
}

export async function updateGoal(id: string, input: Partial<GoalInput>): Promise<GoalDTO> {
  const existing = await prisma.goal.findUnique({ where: { id } });
  if (!existing) throw Errors.notFound("Meta nao encontrada");
  return toGoalDTO(await prisma.goal.update({ where: { id }, data: input }));
}

export async function deleteGoal(id: string) {
  await prisma.goal.delete({ where: { id } }).catch(() => {
    throw Errors.notFound("Meta nao encontrada");
  });
}

const SCOPE_RANK: Record<GoalScope, number> = { AGENTS: 3, CONNECTIONS: 2, ALL: 1 };

/** For each goal type, the active goal that applies to this person — the most specific scope wins, then the newest. */
export async function goalsForUser(userId: string, connectionId: string | null): Promise<Goal[]> {
  const goals = await prisma.goal.findMany({ where: { active: true }, orderBy: { createdAt: "desc" } });
  const best = new Map<GoalType, Goal>();
  for (const goal of goals) {
    const applies =
      goal.scope === "ALL" ||
      (goal.scope === "AGENTS" && goal.agentIds.includes(userId)) ||
      (goal.scope === "CONNECTIONS" && connectionId !== null && goal.connectionIds.includes(connectionId));
    if (!applies) continue;
    const current = best.get(goal.type);
    if (!current || SCOPE_RANK[goal.scope] > SCOPE_RANK[current.scope]) best.set(goal.type, goal);
  }
  return [...best.values()];
}

export function goalProgress(goal: Goal, values: { closedToday: number; avgFirstResponseMs: number | null; npsThisMonth: number | null }): MyDayGoalDTO {
  if (goal.type === "CLOSED_PER_DAY") return { type: goal.type, target: goal.target, current: values.closedToday, achieved: values.closedToday >= goal.target };
  if (goal.type === "AVG_FIRST_RESPONSE") {
    const minutes = values.avgFirstResponseMs === null ? null : Math.round(values.avgFirstResponseMs / 60_000);
    return { type: goal.type, target: goal.target, current: minutes, achieved: minutes !== null && minutes <= goal.target };
  }
  return { type: goal.type, target: goal.target, current: values.npsThisMonth, achieved: values.npsThisMonth !== null && values.npsThisMonth >= goal.target };
}
