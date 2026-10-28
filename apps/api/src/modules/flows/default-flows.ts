import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { FlowNodeType, Prisma } from "@prisma/client";
import { env } from "../../config/env";
import { prisma } from "../../lib/prisma";
import { logger } from "../../lib/logger";
import { saveFlowGraph } from "./flows.service";

/**
 * Flows that ship with the system (prisma/default-flows/*.json, their photos beside them) — each one copied in once,
 * switched off and with no connection, ready for an administrator to link and switch on. A flow deleted in Fluxo
 * never comes back.
 */
const DEFAULT_FLOWS_DIR = path.resolve(__dirname, "../../../prisma/default-flows");
const SEEDED_KEY = "defaultFlowsSeeded";

interface ShippedNode {
  id: string;
  type: FlowNodeType;
  positionX: number;
  positionY: number;
  data: Record<string, unknown> & { image?: { file: string } };
}

interface ShippedFlow {
  key: string;
  name: string;
  description: string;
  nodes: ShippedNode[];
  edges: { sourceNodeId: string; targetNodeId: string; sourceHandle: string | null }[];
}

/** The step's photo copied into the uploads, as a FlowImage. */
function copyPhoto(folder: string, file: string) {
  const source = path.join(folder, file);
  const storageKey = `${randomUUID()}${path.extname(file).toLowerCase()}`;
  fs.mkdirSync(env.UPLOAD_DIR, { recursive: true });
  fs.copyFileSync(source, path.join(env.UPLOAD_DIR, storageKey));
  return { storageKey, fileName: file, mimeType: "image/jpeg", sizeBytes: fs.statSync(source).size };
}

export async function syncDefaultFlows(dir: string = DEFAULT_FLOWS_DIR): Promise<number> {
  if (!fs.existsSync(dir)) return 0;
  const record = await prisma.systemSetting.findUnique({ where: { key: SEEDED_KEY } });
  const seeded = new Set((record?.value as { keys?: string[] } | undefined)?.keys ?? []);
  let added = 0;
  for (const file of fs.readdirSync(dir).filter((f) => f.endsWith(".json"))) {
    const photos = path.join(dir, path.basename(file, ".json"));
    const { flows } = JSON.parse(fs.readFileSync(path.join(dir, file), "utf8")) as { flows: ShippedFlow[] };
    for (const shipped of flows) {
      if (seeded.has(shipped.key)) continue;
      const flow = await prisma.flow.create({ data: { name: shipped.name, description: shipped.description, active: false }, select: { id: true } });
      await saveFlowGraph(
        flow.id,
        shipped.nodes.map((n) => {
          const { image, ...data } = n.data;
          return { id: n.id, type: n.type, positionX: n.positionX, positionY: n.positionY, data: image ? { ...data, image: copyPhoto(photos, image.file) } : data };
        }),
        shipped.edges
      );
      seeded.add(shipped.key);
      added++;
    }
  }
  if (added > 0) {
    const value = { keys: [...seeded] } as unknown as Prisma.InputJsonValue;
    await prisma.systemSetting.upsert({ where: { key: SEEDED_KEY }, update: { value }, create: { key: SEEDED_KEY, value } });
    logger.info({ added }, "flows shipped with this version copied in, switched off");
  }
  return added;
}
