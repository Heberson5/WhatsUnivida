import { randomBytes } from "node:crypto";
import { Router } from "express";
import multer from "multer";
import { z } from "zod";
import { PERMISSION } from "@whatsatendende/types";
import { asyncHandler } from "../../lib/async-handler";
import { requireAuth } from "../../middleware/auth";
import { requirePermission } from "../../lib/permissions";
import { writeAudit } from "../../lib/audit";
import { Errors } from "../../lib/http-error";
import { prisma } from "../../lib/prisma";
import { microsoftAuthorizeUrl, microsoftToken } from "./data-source-fetch";
import * as service from "./data-sources.service";

export const dataSourcesRouter = Router();

const MAX_UPLOAD_MB = 300;
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_UPLOAD_MB * 1024 * 1024 } });

// Microsoft sign-in in progress: state -> source, valid for 10 minutes (single API process).
const OAUTH_STATE_TTL_MS = 10 * 60_000;
const pendingMicrosoftSignIns = new Map<string, { sourceId: string; expiresAt: number }>();

// The redirect back from Microsoft carries no session — the one-time state is what authorizes it.
dataSourcesRouter.get(
  "/microsoft/callback",
  asyncHandler(async (req, res) => {
    const { state, code, error_description: errorDescription } = req.query as Record<string, string | undefined>;
    const pending = state ? pendingMicrosoftSignIns.get(state) : undefined;
    if (state) pendingMicrosoftSignIns.delete(state);
    const page = (message: string) =>
      res.type("html").send(`<!doctype html><meta charset="utf-8"><title>Conta Microsoft</title><body style="font-family:sans-serif;padding:2rem"><p>${message}</p><p>Pode fechar esta janela.</p></body>`);
    if (!pending || pending.expiresAt < Date.now()) return page("O pedido de acesso expirou. Volte em Fontes de dados e clique em Entrar com a conta Microsoft de novo.");
    if (!code) return page(`A Microsoft não liberou o acesso${errorDescription ? `: ${errorDescription.split("\r\n")[0]}` : ""}.`);
    const source = await service.getDataSourceOrThrow(pending.sourceId);
    const token = await microsoftToken(service.microsoftApp(source), { code });
    await prisma.dataSource.update({
      where: { id: source.id },
      data: { secrets: service.writeSecrets({ ...service.readSecrets(source), refreshToken: token.refreshToken ?? undefined }) },
    });
    await service.syncDataSource(source.id);
    page("Conta Microsoft conectada. A planilha já está sendo lida.");
  })
);

dataSourcesRouter.use(requireAuth);

// What the composer offers when "{{" is typed — any logged-in person.
dataSourcesRouter.get(
  "/tags",
  asyncHandler(async (req, res) => {
    const conversationId = typeof req.query.conversationId === "string" ? req.query.conversationId : null;
    const conversation = conversationId ? await prisma.conversation.findUnique({ where: { id: conversationId }, select: { whatsappConnectionId: true } }) : null;
    res.json(await service.availableTags(conversation));
  })
);

const requireView = requirePermission(PERMISSION.FONTES_DADOS_VER);
const requireAdd = requirePermission(PERMISSION.FONTES_DADOS_ADICIONAR);
const requireEdit = requirePermission(PERMISSION.FONTES_DADOS_EDITAR);
const requireDelete = requirePermission(PERMISSION.FONTES_DADOS_EXCLUIR);

const configSchema = z.record(z.union([z.string().max(8000), z.number(), z.null()]));
const sourceSchema = z
  .object({
    name: z.string().trim().min(1).max(80),
    kind: z.enum(["LINK", "MICROSOFT", "UPLOAD", "DATABASE"]),
    config: configSchema.default({}),
    secrets: z.object({ clientSecret: z.string().max(500).optional(), password: z.string().max(500).optional() }).optional(),
    columnMap: z.record(z.string().max(120)).optional(),
    sensitiveColumns: z.array(z.string().max(120)).max(200).optional(),
    overrideContactName: z.boolean().optional(),
    maxAgeHours: z.number().int().min(1).max(24 * 30).optional(),
    refreshMinutes: z.number().int().min(5).max(24 * 60).optional(),
    allConnections: z.boolean().optional(),
    connectionIds: z.array(z.string().uuid()).max(200).optional(),
    bankLayouts: z.record(z.string().regex(/^\d{3}$/), z.string().uuid()).optional(),
  })
  .strict()
  .superRefine((s, ctx) => {
    const c = s.config as Record<string, unknown>;
    const need = (key: string, label: string) => {
      if (!c[key]) ctx.addIssue({ code: "custom", message: `Preencha ${label}`, path: ["config", key] });
    };
    if (s.kind === "LINK") need("url", "o link da planilha");
    if (s.kind === "MICROSOFT") {
      need("shareUrl", "o link do arquivo");
      need("clientId", "o ID do aplicativo");
    }
    if (s.kind === "DATABASE") {
      if (!["sqlserver", "postgres", "mysql"].includes(String(c.dialect))) ctx.addIssue({ code: "custom", message: "Escolha o tipo de banco", path: ["config", "dialect"] });
      need("host", "o servidor");
      need("database", "o banco");
      need("user", "o usuário");
      need("query", "a consulta");
    }
  });

function auditMetadata(input: z.infer<typeof sourceSchema>) {
  // Never the secrets themselves.
  return { name: input.name, kind: input.kind, config: input.config };
}

dataSourcesRouter.get(
  "/",
  requireView,
  asyncHandler(async (_req, res) => {
    res.json(await service.listDataSources());
  })
);

dataSourcesRouter.post(
  "/",
  requireAdd,
  asyncHandler(async (req, res) => {
    const input = sourceSchema.parse(req.body);
    const source = await service.createDataSource(input);
    await writeAudit({ userId: req.auth!.userId, action: "DATA_SOURCE_CREATED", entity: "DataSource", entityId: source.id, ipAddress: req.ip ?? null, metadata: auditMetadata(input) });
    res.status(201).json(source);
  })
);

dataSourcesRouter.put(
  "/:id",
  requireEdit,
  asyncHandler(async (req, res) => {
    const input = sourceSchema.parse(req.body);
    const existing = await service.getDataSourceOrThrow(req.params.id);
    if (existing.kind !== input.kind) throw Errors.badRequest("O tipo da fonte não pode ser trocado; crie uma nova");
    const source = await service.updateDataSource(req.params.id, input);
    await writeAudit({ userId: req.auth!.userId, action: "DATA_SOURCE_UPDATED", entity: "DataSource", entityId: source.id, ipAddress: req.ip ?? null, metadata: auditMetadata(input) });
    res.json(source);
  })
);

dataSourcesRouter.post(
  "/:id/active",
  requireEdit,
  asyncHandler(async (req, res) => {
    const { active } = z.object({ active: z.boolean() }).parse(req.body);
    let source = await service.setDataSourceActive(req.params.id, active);
    if (active && source.kind !== "UPLOAD") source = await service.startSync(source.id);
    await writeAudit({ userId: req.auth!.userId, action: active ? "DATA_SOURCE_ACTIVATED" : "DATA_SOURCE_DEACTIVATED", entity: "DataSource", entityId: source.id, ipAddress: req.ip ?? null });
    res.json(source);
  })
);

dataSourcesRouter.post(
  "/:id/sync",
  requireEdit,
  asyncHandler(async (req, res) => {
    res.json(await service.startSync(req.params.id));
  })
);

dataSourcesRouter.post(
  "/:id/upload",
  requireEdit,
  upload.single("file"),
  asyncHandler(async (req, res) => {
    const source = await service.getDataSourceOrThrow(req.params.id);
    if (source.kind !== "UPLOAD") throw Errors.badRequest("Esta fonte não recebe arquivo");
    if (!req.file) throw Errors.badRequest("Nenhum arquivo enviado");
    await prisma.dataSource.update({ where: { id: source.id }, data: { config: { ...(source.config as object), fileName: req.file.originalname } } });
    await writeAudit({ userId: req.auth!.userId, action: "DATA_SOURCE_FILE_UPLOADED", entity: "DataSource", entityId: source.id, ipAddress: req.ip ?? null, metadata: { fileName: req.file.originalname } });
    res.json(await service.startSync(source.id, req.file.buffer));
  })
);

dataSourcesRouter.get(
  "/:id/microsoft/authorize",
  requireEdit,
  asyncHandler(async (req, res) => {
    const source = await service.getDataSourceOrThrow(req.params.id);
    if (source.kind !== "MICROSOFT") throw Errors.badRequest("Esta fonte não usa conta Microsoft");
    let app;
    try {
      app = service.microsoftApp(source);
    } catch (err) {
      throw Errors.badRequest((err as Error).message);
    }
    const state = randomBytes(24).toString("hex");
    pendingMicrosoftSignIns.set(state, { sourceId: source.id, expiresAt: Date.now() + OAUTH_STATE_TTL_MS });
    res.json({ url: microsoftAuthorizeUrl(app, state), redirectUri: app.redirectUri });
  })
);

dataSourcesRouter.delete(
  "/:id",
  requireDelete,
  asyncHandler(async (req, res) => {
    await service.deleteDataSource(req.params.id);
    await writeAudit({ userId: req.auth!.userId, action: "DATA_SOURCE_DELETED", entity: "DataSource", entityId: req.params.id, ipAddress: req.ip ?? null });
    res.status(204).end();
  })
);
