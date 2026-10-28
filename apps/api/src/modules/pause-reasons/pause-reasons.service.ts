import { prisma } from "../../lib/prisma";
import { Errors } from "../../lib/http-error";

/** Management list (Respostas > Motivo de Pausa) — every reason, active or not, newest first. */
export async function listPauseReasons() {
  return prisma.pauseReason.findMany({ orderBy: { createdAt: "desc" } });
}

/** What the profile-menu pause picker offers — only reasons still active. */
export async function listActivePauseReasons() {
  return prisma.pauseReason.findMany({ where: { active: true }, orderBy: { name: "asc" } });
}

export async function createPauseReason(name: string) {
  return prisma.pauseReason.create({ data: { name } });
}

export async function updatePauseReason(id: string, name: string) {
  const existing = await prisma.pauseReason.findUnique({ where: { id } });
  if (!existing) throw Errors.notFound("Motivo de pausa nao encontrado");
  return prisma.pauseReason.update({ where: { id }, data: { name } });
}

/**
 * "Excluir" always deactivates rather than deleting the row — a reason
 * already referenced by AgentStatusLog history (or a currently-paused
 * User) must keep existing for that history and the Dashboard's presence
 * chart to keep making sense; it just stops being offered when pausing.
 */
export async function deactivatePauseReason(id: string) {
  const existing = await prisma.pauseReason.findUnique({ where: { id } });
  if (!existing) throw Errors.notFound("Motivo de pausa nao encontrado");
  return prisma.pauseReason.update({ where: { id }, data: { active: false } });
}
