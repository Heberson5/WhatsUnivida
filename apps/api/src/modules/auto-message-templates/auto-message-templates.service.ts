import type { AutoMessageTrigger, Role } from "@prisma/client";
import { z } from "zod";
import { customerFirstName } from "@whatsatendende/types";
import { fillGreeting } from "../../lib/customer-tags";
import { prisma } from "../../lib/prisma";
import { Errors } from "../../lib/http-error";
import { appliesToConnection, assertScopeConnectionsExist, scopeData, withScopeConnections, type ConnectionScopeInput } from "../../lib/connection-scope";

/** "Todos os usuários" or the users a message is sent for — Respostas › Aceite › "Quem pode usar". */
export const userScopeSchema = z
  .object({ allUsers: z.boolean(), userIds: z.array(z.string().uuid()).max(500) })
  .refine((s) => s.allUsers || s.userIds.length > 0, { message: "Escolha pelo menos um usuário ou marque todos os usuários" });

export type UserScopeInput = z.infer<typeof userScopeSchema>;

const withScope = {
  ...withScopeConnections,
  users: { select: { id: true, displayName: true }, orderBy: { displayName: "asc" as const } },
} as const;

async function assertScopeUsersExist(scope: UserScopeInput): Promise<void> {
  if (scope.allUsers) return;
  const count = await prisma.user.count({ where: { id: { in: scope.userIds } } });
  if (count !== new Set(scope.userIds).size) throw Errors.badRequest("Um ou mais usuários escolhidos são inválidos");
}

function userScopeData<Op extends "connect" | "set">(scope: UserScopeInput, op: Op) {
  const ids = scope.allUsers ? [] : scope.userIds;
  return { allUsers: scope.allUsers, users: { [op]: ids.map((id) => ({ id })) } as Record<Op, { id: string }[]> };
}

/** Rows sent for this agent: the ones for everyone, plus the ones chosen for them. */
function appliesToUser(agentId: string | null) {
  if (!agentId) return { allUsers: true };
  return { OR: [{ allUsers: true }, { users: { some: { id: agentId } } }] };
}

export async function listAutoMessageTemplates(trigger?: AutoMessageTrigger) {
  return prisma.autoMessageTemplate.findMany({
    where: trigger ? { trigger } : undefined,
    orderBy: { name: "asc" },
    include: withScope,
  });
}

export async function getAutoMessageTemplate(id: string) {
  const row = await prisma.autoMessageTemplate.findUnique({ where: { id }, include: withScope });
  if (!row) throw Errors.notFound("Mensagem automatica nao encontrada");
  return row;
}

export interface AutoMessageTemplateInput {
  trigger: AutoMessageTrigger;
  name: string;
  text: string;
  active: boolean;
  // Left out: with the name on top (the default).
  showSenderName?: boolean;
  connectionScope: ConnectionScopeInput;
  // Left out: sent for everyone.
  userScope?: UserScopeInput;
}

export async function createAutoMessageTemplate({ connectionScope, userScope = { allUsers: true, userIds: [] }, ...input }: AutoMessageTemplateInput) {
  await assertScopeConnectionsExist(connectionScope);
  await assertScopeUsersExist(userScope);
  return prisma.autoMessageTemplate.create({
    data: { ...input, ...scopeData(connectionScope, "connect"), ...userScopeData(userScope, "connect") },
    include: withScope,
  });
}

export async function updateAutoMessageTemplate(id: string, { connectionScope, userScope, ...input }: Partial<AutoMessageTemplateInput>) {
  await getAutoMessageTemplate(id);
  if (connectionScope) await assertScopeConnectionsExist(connectionScope);
  if (userScope) await assertScopeUsersExist(userScope);
  return prisma.autoMessageTemplate.update({
    where: { id },
    data: { ...input, ...(connectionScope && scopeData(connectionScope, "set")), ...(userScope && userScopeData(userScope, "set")) },
    include: withScope,
  });
}

export async function deleteAutoMessageTemplate(id: string) {
  await getAutoMessageTemplate(id);
  await prisma.autoMessageTemplate.delete({ where: { id } });
}

/**
 * The template actually used when a trigger fires on a conversation of this
 * connection, taken by this agent (the one accepting it, or receiving the
 * transfer) — among the ACTIVE rows that apply, the most specific one: chosen
 * for the agent first, then for the connection, then the most recently
 * updated. Null when none applies (the trigger is then a no-op). More than
 * one active row can exist, but only one message ever goes out per event.
 */
export async function getActiveTemplateFor(trigger: AutoMessageTrigger, whatsappConnectionId: string | null, agentId: string | null = null) {
  const rows = await prisma.autoMessageTemplate.findMany({
    where: { trigger, active: true, AND: [appliesToConnection(whatsappConnectionId), appliesToUser(agentId)] },
    orderBy: { updatedAt: "desc" },
  });
  const specificity = (row: (typeof rows)[number]) => (row.allUsers ? 0 : 2) + (row.allConnections ? 0 : 1);
  return rows.reduce<(typeof rows)[number] | null>((best, row) => (!best || specificity(row) > specificity(best) ? row : best), null);
}

const TAGS = {
  atendente: /\{\{\s*atendente\s*\}\}/gi,
  atendenteNome: /\{\{\s*atendente_nome\s*\}\}/gi,
  atendenteCargo: /\{\{\s*atendente_cargo\s*\}\}/gi,
  cliente: /\{\{\s*cliente\s*\}\}/gi,
  primeiroNome: /\{\{\s*primeiro_nome\s*\}\}/gi,
};

// See PROMPT: "quero que tenha as tags do cadastro do usuário" — used by
// {{atendente_cargo}} below, and reused as-is by closing-messages.service.ts
// for the Encerramento message, which shares this same tag set.
export const ROLE_LABEL: Record<Role, string> = { AGENT: "Atendente", MANAGER: "Gestor", ADMIN: "Administrador" };

export interface AutoMessageTemplateVars {
  /** Nome de exibição — kept as the {{atendente}} tag for templates saved before the tags below existed. */
  atendente: string;
  /** Nome completo cadastrado no usuário — {{atendente_nome}}. */
  atendenteNome: string;
  /** Cargo do usuário (Atendente/Gestor/Administrador) — {{atendente_cargo}}. */
  atendenteCargo: string;
  cliente: string;
  /** Contatos › Primeiro nome — {{primeiro_nome}}; empty uses the first word of cliente. */
  primeiroNome?: string | null;
}

/** Substitutes {{atendente}}/{{atendente_nome}}/{{atendente_cargo}}/{{cliente}}/{{primeiro_nome}}/{{saudacao}} with real values — see AutoMessageTemplate's own doc comment. */
export function renderAutoMessageTemplate(text: string, vars: AutoMessageTemplateVars): string {
  return fillGreeting(text)
    .replace(TAGS.atendente, vars.atendente)
    .replace(TAGS.atendenteNome, vars.atendenteNome)
    .replace(TAGS.atendenteCargo, vars.atendenteCargo)
    .replace(TAGS.primeiroNome, customerFirstName(vars.cliente, vars.primeiroNome))
    .replace(TAGS.cliente, vars.cliente);
}
