import { Router } from "express";
import { z } from "zod";
import { HOLIDAY_SCOPE, PERMISSION } from "@whatsunivida/types";
import { asyncHandler } from "../../lib/async-handler";
import { requireAuth } from "../../middleware/auth";
import { requirePermission } from "../../lib/permissions";
import { writeAudit } from "../../lib/audit";
import { Errors } from "../../lib/http-error";
import { logger } from "../../lib/logger";
import { toHolidayDTO } from "./holidays.mapper";
import * as service from "./holidays.service";

export const holidaysRouter = Router();
holidaysRouter.use(requireAuth);

const scopeSchema = z.enum([HOLIDAY_SCOPE.NATIONAL, HOLIDAY_SCOPE.STATE, HOLIDAY_SCOPE.MUNICIPAL]);

const listQuerySchema = z.object({
  scope: scopeSchema.optional(),
  state: z.string().optional(),
  year: z.coerce.number().int().optional(),
});

holidaysRouter.get(
  "/",
  requirePermission(PERMISSION.CONFIGURACOES_GERENCIAR),
  asyncHandler(async (req, res) => {
    const filter = listQuerySchema.parse(req.query);
    const holidays = await service.listHolidays(filter);
    res.json(holidays.map(toHolidayDTO));
  })
);

const createSchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Data invalida (use AAAA-MM-DD)"),
  name: z.string().min(1).max(120),
  scope: scopeSchema,
  state: z.string().length(2).nullable().optional(),
  city: z.string().min(1).nullable().optional(),
});

holidaysRouter.post(
  "/",
  requirePermission(PERMISSION.CONFIGURACOES_GERENCIAR),
  asyncHandler(async (req, res) => {
    const input = createSchema.parse(req.body);
    const holiday = await service.createManualHoliday(input);
    await writeAudit({ userId: req.auth!.userId, action: "HOLIDAY_CREATED", entity: "Holiday", entityId: holiday.id, ipAddress: req.ip ?? null, metadata: input });
    res.status(201).json(toHolidayDTO(holiday));
  })
);

const updateSchema = createSchema.partial();

holidaysRouter.patch(
  "/:id",
  requirePermission(PERMISSION.CONFIGURACOES_GERENCIAR),
  asyncHandler(async (req, res) => {
    const input = updateSchema.parse(req.body);
    const holiday = await service.updateManualHoliday(req.params.id, input);
    await writeAudit({ userId: req.auth!.userId, action: "HOLIDAY_UPDATED", entity: "Holiday", entityId: holiday.id, ipAddress: req.ip ?? null, metadata: input });
    res.json(toHolidayDTO(holiday));
  })
);

holidaysRouter.delete(
  "/:id",
  requirePermission(PERMISSION.CONFIGURACOES_GERENCIAR),
  asyncHandler(async (req, res) => {
    await service.deleteHoliday(req.params.id);
    await writeAudit({ userId: req.auth!.userId, action: "HOLIDAY_DELETED", entity: "Holiday", entityId: req.params.id, ipAddress: req.ip ?? null });
    res.status(204).end();
  })
);

// Manual trigger, in addition to server.ts's own periodic (roughly-monthly)
// check — lets an admin pull the current year's national holidays on
// demand right after setting this up, instead of waiting for the next
// scheduled run. Estadual/municipal stay manual-only — see PROMPT: "deixe
// o cadastro de feriado municipal manual".
holidaysRouter.post(
  "/sync",
  requirePermission(PERMISSION.CONFIGURACOES_GERENCIAR),
  asyncHandler(async (req, res) => {
    const year = new Date().getUTCFullYear();
    const result = await service.runHolidaySync(year);
    await writeAudit({ userId: req.auth!.userId, action: "HOLIDAY_SYNC_TRIGGERED", entity: "Holiday", entityId: null, ipAddress: req.ip ?? null, metadata: result });
    res.json(result);
  })
);

// ---------------------------------------------------------------------------
// IBGE states/cities proxy — see PROMPT: "lista pronta que aparece após
// selecionar o estado". Any authenticated user can read this (it's public
// geographic reference data, no different from a bundled static list) —
// used by both the Usuários form (cidade onde trabalha) and the Feriados
// screen (estado/cidade of a STATE/MUNICIPAL entry). Cached in memory since
// this practically never changes and IBGE has no obligation to serve every
// dropdown open across every deployment.
// ---------------------------------------------------------------------------

interface IbgeState {
  id: number;
  sigla: string;
  nome: string;
}
interface IbgeCity {
  id: number;
  nome: string;
}

// The 26 states + Federal District never changes — a small, permanently
// stable fallback (not fetched from anywhere) for when IBGE's API is
// unreachable, so the state dropdown itself can never go completely empty.
// Ids are IBGE's own (needed nowhere here, kept only for shape parity).
const FALLBACK_STATES: IbgeState[] = [
  { id: 12, sigla: "AC", nome: "Acre" },
  { id: 27, sigla: "AL", nome: "Alagoas" },
  { id: 16, sigla: "AP", nome: "Amapá" },
  { id: 13, sigla: "AM", nome: "Amazonas" },
  { id: 29, sigla: "BA", nome: "Bahia" },
  { id: 23, sigla: "CE", nome: "Ceará" },
  { id: 53, sigla: "DF", nome: "Distrito Federal" },
  { id: 32, sigla: "ES", nome: "Espírito Santo" },
  { id: 52, sigla: "GO", nome: "Goiás" },
  { id: 21, sigla: "MA", nome: "Maranhão" },
  { id: 51, sigla: "MT", nome: "Mato Grosso" },
  { id: 50, sigla: "MS", nome: "Mato Grosso do Sul" },
  { id: 31, sigla: "MG", nome: "Minas Gerais" },
  { id: 15, sigla: "PA", nome: "Pará" },
  { id: 25, sigla: "PB", nome: "Paraíba" },
  { id: 41, sigla: "PR", nome: "Paraná" },
  { id: 26, sigla: "PE", nome: "Pernambuco" },
  { id: 22, sigla: "PI", nome: "Piauí" },
  { id: 33, sigla: "RJ", nome: "Rio de Janeiro" },
  { id: 24, sigla: "RN", nome: "Rio Grande do Norte" },
  { id: 43, sigla: "RS", nome: "Rio Grande do Sul" },
  { id: 11, sigla: "RO", nome: "Rondônia" },
  { id: 14, sigla: "RR", nome: "Roraima" },
  { id: 42, sigla: "SC", nome: "Santa Catarina" },
  { id: 35, sigla: "SP", nome: "São Paulo" },
  { id: 28, sigla: "SE", nome: "Sergipe" },
  { id: 17, sigla: "TO", nome: "Tocantins" },
].sort((a, b) => a.nome.localeCompare(b.nome, "pt-BR"));

const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
let statesCache: { data: IbgeState[]; fetchedAt: number } | null = null;
const citiesCache = new Map<string, { data: IbgeCity[]; fetchedAt: number }>();

holidaysRouter.get(
  "/locations/states",
  asyncHandler(async (_req, res) => {
    if (statesCache && Date.now() - statesCache.fetchedAt < CACHE_TTL_MS) {
      return res.json(statesCache.data);
    }
    try {
      const response = await fetch("https://servicodados.ibge.gov.br/api/v1/localidades/estados?orderBy=nome");
      if (!response.ok) throw new Error(`IBGE respondeu ${response.status}`);
      const data = (await response.json()) as IbgeState[];
      statesCache = { data, fetchedAt: Date.now() };
      res.json(data);
    } catch (err) {
      logger.warn({ err }, "IBGE indisponivel para estados — usando lista fixa como alternativa");
      // Not cached — a real network blip shouldn't lock this fallback in
      // for a full day once IBGE comes back.
      res.json(FALLBACK_STATES);
    }
  })
);

holidaysRouter.get(
  "/locations/states/:uf/cities",
  asyncHandler(async (req, res) => {
    const uf = req.params.uf.toUpperCase();
    const cached = citiesCache.get(uf);
    if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
      return res.json(cached.data);
    }
    let response: Response;
    try {
      response = await fetch(`https://servicodados.ibge.gov.br/api/v1/localidades/estados/${uf}/municipios?orderBy=nome`);
    } catch (err) {
      logger.warn({ err, uf }, "IBGE indisponivel para municipios");
      throw Errors.badRequest("Nao foi possivel carregar a lista de cidades no momento — tente novamente em instantes");
    }
    if (!response.ok) throw Errors.badRequest("Nao foi possivel carregar a lista de cidades no momento");
    const data = (await response.json()) as IbgeCity[];
    citiesCache.set(uf, { data, fetchedAt: Date.now() });
    res.json(data);
  })
);
