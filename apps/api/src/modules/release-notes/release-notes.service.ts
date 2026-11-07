import type { Prisma, ReleaseNoteVersion, Role } from "@prisma/client";
import { compareVersions, visibleReleases, type PermissionMap, type ReleaseContent, type ReleaseDTO, type ReleaseNoteDTO } from "@whatsatendende/types";
import { prisma } from "../../lib/prisma";
import { Errors } from "../../lib/http-error";
import { logger } from "../../lib/logger";
import { DEFAULT_RELEASES } from "./default-releases";

// The shipped versions already copied into the database (see syncDefaultReleaseNotes).
const DEFAULTS_KEY = "releaseNotesDefaults";
// "version|title" of the shipped notes whose screenshots were already filled in (see fillShippedNoteImages).
const IMAGES_KEY = "releaseNotesImagesFilled";

function toReleaseDTO(row: ReleaseNoteVersion): ReleaseDTO {
  return { id: row.id, version: row.version, date: row.date, name: row.name, summary: row.summary, notes: row.notes as unknown as ReleaseNoteDTO[] };
}

function toData(content: ReleaseContent) {
  return { version: content.version, date: content.date, name: content.name, summary: content.summary, notes: content.notes as unknown as Prisma.InputJsonValue };
}

/** Every version, the newest first (by number, not by when it was written). */
export async function listReleases(): Promise<ReleaseDTO[]> {
  const rows = await prisma.releaseNoteVersion.findMany();
  return rows.map(toReleaseDTO).sort((a, b) => compareVersions(b.version, a.version));
}

/** The current version of the system: the highest number in Notas de versão (shipped or written there). */
export async function currentVersion(): Promise<string | null> {
  const rows = await prisma.releaseNoteVersion.findMany({ select: { version: true } });
  return rows.map((r) => r.version).sort((a, b) => compareVersions(b, a))[0] ?? null;
}

/** The versions as this person sees them — only the notes about screens they can open. */
export async function listVisibleReleases(role: Role, permissions: PermissionMap): Promise<ReleaseDTO[]> {
  return visibleReleases(await listReleases(), role, permissions);
}

async function getRelease(id: string): Promise<ReleaseNoteVersion> {
  const row = await prisma.releaseNoteVersion.findUnique({ where: { id } });
  if (!row) throw Errors.notFound("Versão não encontrada");
  return row;
}

async function assertVersionFree(version: string, exceptId?: string): Promise<void> {
  const existing = await prisma.releaseNoteVersion.findUnique({ where: { version }, select: { id: true } });
  if (existing && existing.id !== exceptId) throw Errors.conflict(`Já existe a versão ${version}. Edite essa versão ou use outro número.`);
}

export async function createRelease(content: ReleaseContent): Promise<ReleaseDTO> {
  await assertVersionFree(content.version);
  return toReleaseDTO(await prisma.releaseNoteVersion.create({ data: toData(content) }));
}

export async function updateRelease(id: string, content: ReleaseContent): Promise<ReleaseDTO> {
  await getRelease(id);
  await assertVersionFree(content.version, id);
  return toReleaseDTO(await prisma.releaseNoteVersion.update({ where: { id }, data: toData(content) }));
}

export async function deleteRelease(id: string): Promise<ReleaseDTO> {
  const row = await getRelease(id);
  await prisma.releaseNoteVersion.delete({ where: { id } });
  return toReleaseDTO(row);
}

/**
 * Copies the versions shipped with the system (default-releases.ts) into the database — each one once. A version
 * an administrator deleted is not brought back, an edited one is not overwritten, and a version shipped later is
 * added on the next start. Called when the server starts.
 */
/**
 * A version shipped in two steps under the same number: the first copy (still exactly as shipped — same name, never
 * edited by an administrator) is replaced by the complete one, and whoever had already read it sees it again.
 * 2.37.0 went out first as the preparation, then without the closing/reports part, and now complete.
 */
// Earlier shipped copies, by their summary (an administrator's edit changes it, and then it is never touched).
const SUPERSEDED_SHIPPED: Record<string, string[]> = {
  "2.37.0": [
    "Chegou a base do Assistente Virtual, uma IA que roda no próprio servidor e vai atender o cliente antes da fila. Ele começa desligado: nada muda no atendimento até o administrador ligá-lo.",
    "Chegou o Assistente Virtual: uma IA que roda no próprio servidor, sem custo por mensagem, e atende o cliente antes da fila. Ele envia boleto e linha digitável, informa os débitos em aberto com o valor atualizado e passa para a equipe tudo o que não for com ele. Começa desligado e em Modo teste.",
  ],
};

async function replaceSupersededShipped(defaults: ReleaseContent[]): Promise<void> {
  for (const [version, oldSummaries] of Object.entries(SUPERSEDED_SHIPPED)) {
    const shipped = defaults.find((r) => r.version === version);
    if (!shipped || oldSummaries.includes(shipped.summary)) continue;
    const row = await prisma.releaseNoteVersion.findUnique({ where: { version } });
    if (!row || !oldSummaries.includes(row.summary)) continue;
    await prisma.releaseNoteVersion.update({ where: { version }, data: toData(shipped) });
    // Back to the version before, so the complete note shows up once more (and nothing older does).
    const previous = defaults.map((r) => r.version).filter((v) => compareVersions(v, version) < 0).sort(compareVersions).at(-1) ?? null;
    await prisma.user.updateMany({ where: { releaseNotesSeenVersion: version }, data: { releaseNotesSeenVersion: previous } });
    logger.info({ version }, "release note shipped in two steps replaced by its complete version");
  }
}

export async function syncDefaultReleaseNotes(defaults: ReleaseContent[] = DEFAULT_RELEASES): Promise<number> {
  await replaceSupersededShipped(defaults);
  const record = await prisma.systemSetting.findUnique({ where: { key: DEFAULTS_KEY } });
  const copied = new Set((record?.value as { versions?: string[] } | undefined)?.versions ?? []);
  const missing = defaults.filter((r) => !copied.has(r.version));
  if (missing.length === 0) return 0;

  let added = 0;
  for (const release of missing) {
    // Already written in Configurações with the same number: that one stays.
    const exists = await prisma.releaseNoteVersion.findUnique({ where: { version: release.version }, select: { id: true } });
    if (!exists) {
      await prisma.releaseNoteVersion.create({ data: toData(release) });
      added++;
    }
    copied.add(release.version);
  }
  const value = { versions: [...copied] } as unknown as Prisma.InputJsonValue;
  await prisma.systemSetting.upsert({ where: { key: DEFAULTS_KEY }, update: { value }, create: { key: DEFAULTS_KEY, value } });
  if (added > 0) logger.info({ added }, "release notes shipped with this version copied into the database");
  return added;
}

/**
 * Screenshots shipped later for a version already copied in: a version is copied only once (then it is the
 * administrator's), so a note that got its images afterwards would never show them. Each shipped note's images are
 * filled in once, and only while the copy in the database has none — an image an administrator removed, or a note
 * they rewrote with their own, stays as they left it.
 */
export async function fillShippedNoteImages(defaults: ReleaseContent[] = DEFAULT_RELEASES): Promise<number> {
  const record = await prisma.systemSetting.findUnique({ where: { key: IMAGES_KEY } });
  const done = new Set((record?.value as { notes?: string[] } | undefined)?.notes ?? []);
  const pending = defaults.flatMap((release) =>
    release.notes.filter((note) => note.images?.length && !done.has(`${release.version}|${note.title}`)).map((note) => ({ release, note }))
  );
  if (pending.length === 0) return 0;

  let filled = 0;
  for (const version of new Set(pending.map((p) => p.release.version))) {
    const row = await prisma.releaseNoteVersion.findUnique({ where: { version } });
    if (!row) continue;
    const notes = row.notes as unknown as ReleaseNoteDTO[];
    let changed = false;
    for (const { note } of pending.filter((p) => p.release.version === version)) {
      const stored = notes.find((n) => n.title === note.title);
      if (stored && !stored.images?.length) {
        stored.images = note.images;
        changed = true;
        filled++;
      }
      done.add(`${version}|${note.title}`);
    }
    if (changed) await prisma.releaseNoteVersion.update({ where: { version }, data: { notes: notes as unknown as Prisma.InputJsonValue } });
  }
  for (const { release, note } of pending) done.add(`${release.version}|${note.title}`);
  const value = { notes: [...done] } as unknown as Prisma.InputJsonValue;
  await prisma.systemSetting.upsert({ where: { key: IMAGES_KEY }, update: { value }, create: { key: IMAGES_KEY, value } });
  if (filled > 0) logger.info({ filled }, "screenshots of shipped release notes filled in");
  return filled;
}
