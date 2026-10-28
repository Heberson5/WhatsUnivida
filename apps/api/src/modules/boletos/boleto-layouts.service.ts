import type { BoletoInstruction, BoletoLayout, Prisma } from "@prisma/client";
import {
  BOLETO_BANKS,
  BOLETO_LAYOUT_MODELS,
  BOLETO_MESSAGE_TAG,
  BOLETO_PAYMENT_PLACES,
  DEFAULT_BOLETO_INSTRUCTION,
  DEFAULT_BOLETO_LAYOUT_SETTINGS,
  DEFAULT_BOLETO_SEND_MESSAGE,
  fillBoletoInstructions,
  type BoletoInstructionDTO,
  type BoletoInstructionInput,
  type BoletoLayoutDTO,
  type BoletoLayoutInput,
  type BoletoLayoutModel,
  type BoletoLayoutSettings,
  type BoletoSendMessageDTO,
} from "@whatsatendende/types";
import { prisma } from "../../lib/prisma";
import { Errors } from "../../lib/http-error";

const DEFAULTS_KEY = "boleto-defaults";
// 2.25.0: Sicredi, Bradesco, Itaú and Caixa get their "Boleto F" — once, also on installs that already have the BB ones.
const OTHER_BANKS_DEFAULTS_KEY = "boleto-defaults-other-banks";
const SEND_MESSAGE_KEY = "boleto-send-message";
// Where the instructions lived before Mensagens do boleto (one set for everything): becomes "Instruções padrão".
const LEGACY_INSTRUCTIONS_KEY = "boleto-instructions";

/** The layouts every Banco do Brasil install starts with — editable, renamable, deletable like any other. */
const DEFAULT_BB_LAYOUTS: { name: string; model: BoletoLayoutModel; perPage: number; settings?: Partial<BoletoLayoutSettings> }[] = [
  { name: "Boleto F", model: "CARNE", perPage: 3 },
  { name: "Boleto padrão", model: "PADRAO", perPage: 1 },
  {
    name: "Boleto com demonstrativo",
    model: "DEMONSTRATIVO",
    perPage: 1,
    settings: { demonstrative: "Contrato: {contrato}  Documento: {documento}\nVencimento: {vencimento}  Valor: R$ {valor}" },
  },
  { name: "Ficha de compensação", model: "FICHA", perPage: 3 },
];

/** First start (or a fresh database): "Instruções padrão" and the Banco do Brasil layouts. Runs once. */
export async function ensureBoletoDefaults(): Promise<void> {
  await ensureBankDefaults();
  await ensureOtherBanksDefaults();
}

/** "Boleto F" (carnê) for each of the other banks, with the payment place its manual asks for. Runs once. */
async function ensureOtherBanksDefaults(): Promise<void> {
  if (await prisma.systemSetting.findUnique({ where: { key: OTHER_BANKS_DEFAULTS_KEY } })) return;
  const carne = DEFAULT_BB_LAYOUTS[0];
  await prisma.$transaction([
    ...Object.keys(BOLETO_BANKS)
      .filter((code) => code !== "001")
      .map((bankCode) =>
        prisma.boletoLayout.upsert({
          where: { bankCode_name: { bankCode, name: carne.name } },
          update: {},
          create: {
            name: carne.name,
            bankCode,
            model: carne.model,
            perPage: carne.perPage,
            settings: { ...DEFAULT_BOLETO_LAYOUT_SETTINGS, paymentPlace: BOLETO_PAYMENT_PLACES[bankCode] } as unknown as Prisma.InputJsonValue,
          },
        })
      ),
    prisma.systemSetting.upsert({ where: { key: OTHER_BANKS_DEFAULTS_KEY }, update: {}, create: { key: OTHER_BANKS_DEFAULTS_KEY, value: true } }),
  ]);
}

async function ensureBankDefaults(): Promise<void> {
  if (await prisma.systemSetting.findUnique({ where: { key: DEFAULTS_KEY } })) return;
  const legacy = await prisma.systemSetting.findUnique({ where: { key: LEGACY_INSTRUCTIONS_KEY } });
  const instruction = { ...DEFAULT_BOLETO_INSTRUCTION, ...((legacy?.value as Omit<BoletoInstructionInput, "name"> | undefined) ?? {}) };
  await prisma.$transaction([
    prisma.boletoInstruction.upsert({ where: { name: instruction.name }, update: {}, create: instruction }),
    ...DEFAULT_BB_LAYOUTS.map((layout) =>
      prisma.boletoLayout.upsert({
        where: { bankCode_name: { bankCode: "001", name: layout.name } },
        update: {},
        create: {
          name: layout.name,
          bankCode: "001",
          model: layout.model,
          perPage: layout.perPage,
          settings: { ...DEFAULT_BOLETO_LAYOUT_SETTINGS, ...layout.settings } as unknown as Prisma.InputJsonValue,
        },
      })
    ),
    prisma.systemSetting.deleteMany({ where: { key: LEGACY_INSTRUCTIONS_KEY } }),
    prisma.systemSetting.upsert({ where: { key: DEFAULTS_KEY }, update: {}, create: { key: DEFAULTS_KEY, value: true } }),
  ]);
}

// --- Mensagens do boleto (instructions) ------------------------------------------------------------------------------

const tagOf = (name: string) => `{mensagem:${name}}`;
const layoutTexts = (layout: BoletoLayout) => {
  const settings = layout.settings as unknown as BoletoLayoutSettings;
  return `${settings.instructions}\n${settings.demonstrative}`;
};

function toInstructionDTO(row: BoletoInstruction, layouts: BoletoLayout[]): BoletoInstructionDTO {
  return {
    id: row.id,
    name: row.name,
    finePercent: row.finePercent,
    interestMonthPercent: row.interestMonthPercent,
    lines: row.lines,
    usedBy: layouts.filter((l) => layoutTexts(l).includes(tagOf(row.name))).map((l) => l.name),
  };
}

export async function listInstructions(): Promise<BoletoInstructionDTO[]> {
  await ensureBoletoDefaults();
  const [rows, layouts] = await Promise.all([prisma.boletoInstruction.findMany({ orderBy: { name: "asc" } }), prisma.boletoLayout.findMany()]);
  return rows.map((row) => toInstructionDTO(row, layouts));
}

async function assertInstructionNameFree(name: string, exceptId?: string) {
  const existing = await prisma.boletoInstruction.findUnique({ where: { name } });
  if (existing && existing.id !== exceptId) throw Errors.conflict(`Já existe a mensagem "${name}"`);
}

export async function createInstruction(input: BoletoInstructionInput): Promise<BoletoInstructionDTO> {
  await assertInstructionNameFree(input.name);
  const row = await prisma.boletoInstruction.create({ data: input });
  return toInstructionDTO(row, []);
}

/** A rename also renames {mensagem:Nome} in the layouts, so they keep bringing it in. */
export async function updateInstruction(id: string, input: BoletoInstructionInput): Promise<BoletoInstructionDTO> {
  const current = await prisma.boletoInstruction.findUnique({ where: { id } });
  if (!current) throw Errors.notFound("Mensagem não encontrada");
  await assertInstructionNameFree(input.name, id);
  const layouts = await prisma.boletoLayout.findMany();
  const renames =
    current.name === input.name
      ? []
      : layouts
          .filter((l) => layoutTexts(l).includes(tagOf(current.name)))
          .map((l) => {
            const settings = l.settings as unknown as BoletoLayoutSettings;
            const swap = (text: string) => text.split(tagOf(current.name)).join(tagOf(input.name));
            const next = { ...settings, instructions: swap(settings.instructions), demonstrative: swap(settings.demonstrative) };
            return prisma.boletoLayout.update({ where: { id: l.id }, data: { settings: next as unknown as Prisma.InputJsonValue } });
          });
  const [row] = await prisma.$transaction([prisma.boletoInstruction.update({ where: { id }, data: input }), ...renames]);
  return toInstructionDTO(row, await prisma.boletoLayout.findMany());
}

export async function deleteInstruction(id: string): Promise<void> {
  const row = await prisma.boletoInstruction.findUnique({ where: { id } });
  if (!row) throw Errors.notFound("Mensagem não encontrada");
  const { usedBy } = toInstructionDTO(row, await prisma.boletoLayout.findMany());
  if (usedBy.length > 0) throw Errors.conflict(`Esta mensagem está nos layouts ${usedBy.map((n) => `"${n}"`).join(", ")}. Tire de lá antes de excluir.`);
  await prisma.boletoInstruction.delete({ where: { id } });
}

/**
 * A layout's text as printed on one boleto: a line that is just {mensagem:Nome} becomes that message's lines; any
 * other line is printed as written. Tags ({multa}, {contrato}...) are filled with the message's percentages — on a
 * fixed line, with the first message the text brings in.
 */
export function expandLayoutText(text: string, instructions: BoletoInstruction[], boleto: { cents: number; contract: string; document: string | null; due: string }): string[] {
  const byName = new Map(instructions.map((i) => [i.name, i]));
  const firstUsed = [...text.matchAll(BOLETO_MESSAGE_TAG)].map((m) => byName.get(m[1].trim())).find(Boolean);
  const rates = { finePercent: firstUsed?.finePercent ?? 0, interestMonthPercent: firstUsed?.interestMonthPercent ?? 0 };
  const lines: string[] = [];
  for (const line of text.split("\n")) {
    const only = /^\s*\{mensagem:([^}]+)\}\s*$/.exec(line);
    if (only) {
      const message = byName.get(only[1].trim());
      if (message) lines.push(...fillBoletoInstructions(message, boleto));
    } else if (line.trim()) {
      lines.push(...fillBoletoInstructions({ ...rates, lines: [line.replace(BOLETO_MESSAGE_TAG, "")] }, boleto));
    }
  }
  return lines;
}

// --- Layouts de boleto ---------------------------------------------------------------------------------------------

export function toLayoutInput(row: BoletoLayout): BoletoLayoutInput {
  return {
    name: row.name,
    bankCode: row.bankCode,
    model: row.model as BoletoLayoutModel,
    perPage: row.perPage,
    settings: { ...DEFAULT_BOLETO_LAYOUT_SETTINGS, ...(row.settings as Partial<BoletoLayoutSettings>) },
  };
}

export async function listLayouts(): Promise<BoletoLayoutDTO[]> {
  await ensureBoletoDefaults();
  const [rows, sources] = await Promise.all([
    prisma.boletoLayout.findMany({ orderBy: [{ bankCode: "asc" }, { createdAt: "asc" }] }),
    prisma.dataSource.findMany({ select: { name: true, bankLayouts: true } }),
  ]);
  return rows.map((row) => ({
    id: row.id,
    ...toLayoutInput(row),
    usedBy: sources.filter((s) => Object.values(s.bankLayouts as Record<string, string>).includes(row.id)).map((s) => s.name),
  }));
}

function checkLayout(input: BoletoLayoutInput) {
  if (!BOLETO_BANKS[input.bankCode]) throw Errors.badRequest("Banco sem envio de boleto");
  if (input.perPage > BOLETO_LAYOUT_MODELS[input.model].maxPerPage) {
    throw Errors.badRequest(`Este modelo cabe no máximo ${BOLETO_LAYOUT_MODELS[input.model].maxPerPage} boleto(s) por página`);
  }
}

async function assertLayoutNameFree(bankCode: string, name: string, exceptId?: string) {
  const existing = await prisma.boletoLayout.findUnique({ where: { bankCode_name: { bankCode, name } } });
  if (existing && existing.id !== exceptId) throw Errors.conflict(`Já existe o layout "${name}" para este banco`);
}

const layoutData = (input: BoletoLayoutInput) => ({ ...input, settings: input.settings as unknown as Prisma.InputJsonValue });

export async function createLayout(input: BoletoLayoutInput): Promise<BoletoLayoutDTO> {
  checkLayout(input);
  await assertLayoutNameFree(input.bankCode, input.name);
  const row = await prisma.boletoLayout.create({ data: layoutData(input) });
  return { id: row.id, ...toLayoutInput(row), usedBy: [] };
}

export async function updateLayout(id: string, input: BoletoLayoutInput): Promise<BoletoLayoutDTO> {
  checkLayout(input);
  const current = await prisma.boletoLayout.findUnique({ where: { id } });
  if (!current) throw Errors.notFound("Layout não encontrado");
  if (current.bankCode !== input.bankCode) throw Errors.badRequest("O banco de um layout não muda: crie um layout novo para o outro banco");
  await assertLayoutNameFree(input.bankCode, input.name, id);
  await prisma.boletoLayout.update({ where: { id }, data: layoutData(input) });
  return (await listLayouts()).find((l) => l.id === id)!;
}

export async function deleteLayout(id: string): Promise<void> {
  const layout = (await listLayouts()).find((l) => l.id === id);
  if (!layout) throw Errors.notFound("Layout não encontrado");
  if (layout.usedBy.length > 0) {
    throw Errors.conflict(`Este layout é o padrão das fontes ${layout.usedBy.map((n) => `"${n}"`).join(", ")}. Escolha outro layout nelas antes de excluir.`);
  }
  const sameBank = await prisma.boletoLayout.count({ where: { bankCode: layout.bankCode } });
  if (sameBank <= 1) throw Errors.conflict("É o único layout deste banco: os boletos dele precisam de pelo menos um.");
  await prisma.boletoLayout.delete({ where: { id } });
}

/** The layout a bank's boletos come out in for a source: the one chosen there, else the bank's first layout. */
export async function layoutForBank(bankLayouts: Record<string, string>, bankCode: string): Promise<BoletoLayout> {
  await ensureBoletoDefaults();
  const chosen = bankLayouts[bankCode] ? await prisma.boletoLayout.findUnique({ where: { id: bankLayouts[bankCode] } }) : null;
  const layout = chosen ?? (await prisma.boletoLayout.findFirst({ where: { bankCode }, orderBy: { createdAt: "asc" } }));
  if (!layout) throw Errors.badRequest(`Nenhum layout de boleto para o banco ${bankCode}. Cadastre um em Dados › Layouts de boleto.`);
  return layout;
}

// --- Mensagem de envio -----------------------------------------------------------------------------------------------

export async function getSendMessage(): Promise<BoletoSendMessageDTO> {
  const row = await prisma.systemSetting.findUnique({ where: { key: SEND_MESSAGE_KEY } });
  return (row?.value as BoletoSendMessageDTO | undefined) ?? DEFAULT_BOLETO_SEND_MESSAGE;
}

export async function setSendMessage(message: BoletoSendMessageDTO): Promise<BoletoSendMessageDTO> {
  const value = message as unknown as Prisma.InputJsonValue;
  await prisma.systemSetting.upsert({ where: { key: SEND_MESSAGE_KEY }, update: { value }, create: { key: SEND_MESSAGE_KEY, value } });
  return message;
}
