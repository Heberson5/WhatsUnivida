import { Router } from "express";
import { z } from "zod";
import {
  BOLETO_INSTRUCTION_LINE_MAX_LENGTH,
  BOLETO_INSTRUCTION_LINES_MAX,
  BOLETO_LAYOUT_MODELS,
  BOLETO_SEND_MESSAGE_MAX_LENGTH,
  PERMISSION,
  type BoletoLayoutModel,
} from "@whatsatendende/types";
import { asyncHandler } from "../../lib/async-handler";
import { requireAuth } from "../../middleware/auth";
import { requirePermission } from "../../lib/permissions";
import { writeAudit } from "../../lib/audit";
import * as service from "./boletos.service";
import * as layouts from "./boleto-layouts.service";

/** Dados: validation (a bank only sends boletos after matching 3 real ones), layouts, instruction and send messages. */
export const boletosRouter = Router();
boletosRouter.use(requireAuth);

boletosRouter.get(
  "/validation",
  requirePermission(PERMISSION.FONTES_DADOS_VER),
  asyncHandler(async (_req, res) => {
    res.json(await service.getValidation());
  })
);

const sampleSchema = z.object({ ourNumber: z.string().trim().min(1).max(40), linha: z.string().trim().min(44).max(80) });
boletosRouter.post(
  "/validation",
  requirePermission(PERMISSION.FONTES_DADOS_EDITAR),
  asyncHandler(async (req, res) => {
    const { ourNumber, linha } = sampleSchema.parse(req.body);
    try {
      res.json(await service.submitValidationSample(ourNumber, linha));
    } finally {
      await writeAudit({ userId: req.auth!.userId, action: "BOLETO_VALIDATION_SAMPLE", entity: "SystemSetting", entityId: "boleto-validation", ipAddress: req.ip ?? null, metadata: { ourNumber } });
    }
  })
);

boletosRouter.delete(
  "/validation/:bank",
  requirePermission(PERMISSION.FONTES_DADOS_EDITAR),
  asyncHandler(async (req, res) => {
    const result = await service.resetValidation(req.params.bank);
    await writeAudit({ userId: req.auth!.userId, action: "BOLETO_VALIDATION_RESET", entity: "SystemSetting", entityId: "boleto-validation", ipAddress: req.ip ?? null, metadata: { bank: req.params.bank } });
    res.json(result);
  })
);

// --- Dados › Mensagens do boleto ---------------------------------------------------------------------------------

const percent = z.number().min(0).max(100);
const instructionSchema = z.object({
  name: z.string().trim().min(1).max(60).regex(/^[^{}]+$/, "O nome não pode ter chaves { }"),
  finePercent: percent,
  interestMonthPercent: percent,
  lines: z.array(z.string().trim().min(1).max(BOLETO_INSTRUCTION_LINE_MAX_LENGTH)).max(BOLETO_INSTRUCTION_LINES_MAX),
});

boletosRouter.get(
  "/instructions",
  requirePermission(PERMISSION.FONTES_DADOS_VER),
  asyncHandler(async (_req, res) => {
    res.json(await layouts.listInstructions());
  })
);

boletosRouter.post(
  "/instructions",
  requirePermission(PERMISSION.FONTES_DADOS_EDITAR),
  asyncHandler(async (req, res) => {
    const instruction = await layouts.createInstruction(instructionSchema.parse(req.body));
    await writeAudit({ userId: req.auth!.userId, action: "BOLETO_INSTRUCTION_CREATED", entity: "BoletoInstruction", entityId: instruction.id, ipAddress: req.ip ?? null, metadata: { ...instruction } });
    res.status(201).json(instruction);
  })
);

boletosRouter.put(
  "/instructions/:id",
  requirePermission(PERMISSION.FONTES_DADOS_EDITAR),
  asyncHandler(async (req, res) => {
    const instruction = await layouts.updateInstruction(req.params.id, instructionSchema.parse(req.body));
    await writeAudit({ userId: req.auth!.userId, action: "BOLETO_INSTRUCTION_UPDATED", entity: "BoletoInstruction", entityId: instruction.id, ipAddress: req.ip ?? null, metadata: { ...instruction } });
    res.json(instruction);
  })
);

boletosRouter.delete(
  "/instructions/:id",
  requirePermission(PERMISSION.FONTES_DADOS_EDITAR),
  asyncHandler(async (req, res) => {
    await layouts.deleteInstruction(req.params.id);
    await writeAudit({ userId: req.auth!.userId, action: "BOLETO_INSTRUCTION_DELETED", entity: "BoletoInstruction", entityId: req.params.id, ipAddress: req.ip ?? null });
    res.status(204).end();
  })
);

// --- Dados › Layouts de boleto -------------------------------------------------------------------------------------

const yesNo = z.boolean();
const dateSource = z.enum(["PRINT", "BLANK"]);
const layoutSchema = z.object({
  name: z.string().trim().min(1).max(60),
  bankCode: z.string().regex(/^\d{3}$/),
  model: z.enum(Object.keys(BOLETO_LAYOUT_MODELS) as [BoletoLayoutModel, ...BoletoLayoutModel[]]),
  perPage: z.number().int().min(1).max(3),
  settings: z.object({
    paymentPlace: z.string().trim().max(200),
    documentKind: z.string().trim().max(10),
    acceptance: z.string().trim().max(5),
    documentDate: dateSource,
    processDate: dateSource,
    showLogo: yesNo,
    showPayerDocument: yesNo,
    showPayerAddress: yesNo,
    showPayeeDocument: yesNo,
    showGuarantor: yesNo,
    highlight: yesNo,
    instructions: z.string().max(1000),
    demonstrative: z.string().max(2000),
  }),
});

boletosRouter.get(
  "/layouts",
  requirePermission(PERMISSION.FONTES_DADOS_VER),
  asyncHandler(async (_req, res) => {
    res.json(await layouts.listLayouts());
  })
);

// The layout being edited, as a PDF with fictitious boletos — the live preview beside the form.
boletosRouter.post(
  "/layouts/preview",
  requirePermission(PERMISSION.FONTES_DADOS_VER),
  asyncHandler(async (req, res) => {
    const pdf = await service.previewLayoutPdf(layoutSchema.parse(req.body));
    res.type("application/pdf").send(pdf);
  })
);

boletosRouter.post(
  "/layouts",
  requirePermission(PERMISSION.FONTES_DADOS_EDITAR),
  asyncHandler(async (req, res) => {
    const layout = await layouts.createLayout(layoutSchema.parse(req.body));
    await writeAudit({ userId: req.auth!.userId, action: "BOLETO_LAYOUT_CREATED", entity: "BoletoLayout", entityId: layout.id, ipAddress: req.ip ?? null, metadata: { name: layout.name, model: layout.model } });
    res.status(201).json(layout);
  })
);

boletosRouter.put(
  "/layouts/:id",
  requirePermission(PERMISSION.FONTES_DADOS_EDITAR),
  asyncHandler(async (req, res) => {
    const layout = await layouts.updateLayout(req.params.id, layoutSchema.parse(req.body));
    await writeAudit({ userId: req.auth!.userId, action: "BOLETO_LAYOUT_UPDATED", entity: "BoletoLayout", entityId: layout.id, ipAddress: req.ip ?? null, metadata: { name: layout.name, model: layout.model } });
    res.json(layout);
  })
);

boletosRouter.delete(
  "/layouts/:id",
  requirePermission(PERMISSION.FONTES_DADOS_EDITAR),
  asyncHandler(async (req, res) => {
    await layouts.deleteLayout(req.params.id);
    await writeAudit({ userId: req.auth!.userId, action: "BOLETO_LAYOUT_DELETED", entity: "BoletoLayout", entityId: req.params.id, ipAddress: req.ip ?? null });
    res.status(204).end();
  })
);

boletosRouter.get(
  "/sources/:id/banks",
  requirePermission(PERMISSION.FONTES_DADOS_VER),
  asyncHandler(async (req, res) => {
    res.json(await service.sourceBanks(req.params.id));
  })
);

// --- Dados › Mensagem de envio -------------------------------------------------------------------------------------

boletosRouter.get(
  "/send-message",
  requirePermission(PERMISSION.FONTES_DADOS_VER),
  asyncHandler(async (_req, res) => {
    res.json(await layouts.getSendMessage());
  })
);

const sendMessageText = z.string().trim().min(1).max(BOLETO_SEND_MESSAGE_MAX_LENGTH);
boletosRouter.put(
  "/send-message",
  requirePermission(PERMISSION.FONTES_DADOS_EDITAR),
  asyncHandler(async (req, res) => {
    const message = await layouts.setSendMessage(z.object({ single: sendMessageText, plural: sendMessageText }).parse(req.body));
    await writeAudit({ userId: req.auth!.userId, action: "BOLETO_SEND_MESSAGE_UPDATED", entity: "SystemSetting", entityId: "boleto-send-message", ipAddress: req.ip ?? null, metadata: { ...message } });
    res.json(message);
  })
);
