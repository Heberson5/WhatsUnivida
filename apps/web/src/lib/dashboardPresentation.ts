import type PptxGenJS from "pptxgenjs";
import { NPS_SMALL_SAMPLE } from "@whatsatendende/types";
import {
  AUTO_MESSAGE_KIND_LABEL,
  type ArrivalsByHourDTO,
  type AutoMessageBlocksReportDTO,
  type PresenceByHourDTO,
  type SatisfactionOverviewDTO,
  type SatisfactionReportDTO,
  type SatisfactionResponseDTO,
} from "@whatsatendende/types";
import type { TeamData } from "../components/dashboard/TeamCards";
import type { HourRange } from "../components/dashboard/PresenceByHourChart";
import { arrivalsSummary } from "../components/dashboard/ArrivalsByHourChart";
import { darken, lighten } from "./chart-theme";
import {
  compareWithPrevious,
  describePeriod,
  formatMinutes,
  formatNps,
  formatNumber,
  npsDelta,
  npsZone,
  percentOf,
  type PeriodKey,
  type StatDelta,
} from "./dashboardMetrics";

/**
 * The Dashboard as a presentation for the board, executives and managers: the same numbers and
 * charts, laid out as slides — a cover, the period in four sentences, the indicator cards, volume,
 * the journey of a conversation with its average times, customer satisfaction (NPS), the team,
 * presence through the day, what customers talk about, a glossary and a closing slide.
 *
 * Everything is native PowerPoint (shapes, tables and charts — no screenshots), so it can be
 * edited, and every slide carries speaker notes that explain what it shows. This module only
 * builds the deck; exportDashboardPptx.ts loads the logo and icons and saves the file.
 */

export interface DashboardSnapshot {
  conversations: { received: number; unique: number; inProgress: number; closed: number; closedNoReturn: number; waiting: number };
  messages: { received: number; sent: number; total: number };
  timings: { avgAcceptMs: number | null; avgFirstResponseMs: number | null; avgHandlingMs: number | null; avgClosingMs: number | null };
  perAgent: { agentId: string; agentName: string; conversations: number; messagesSent: number; messagesReceived: number; avgHandlingMs: number | null }[];
  users: { online: number; active: number; total: number };
  previous: { received: number; unique: number; closed: number; messagesTotal: number; avgFirstResponseMs: number | null };
}

export const PRESENTATION_ICONS = ["inbox", "users", "clock", "timer", "check", "messages", "star", "trophy", "flag", "headset"] as const;
export type PresentationIconName = (typeof PRESENTATION_ICONS)[number];

export interface PresentationInput {
  companyName: string;
  /** The brand color of Configurações › Exportações. */
  primaryColor: string;
  logo: { data: string; width: number; height: number } | null;
  /** White icons as PNG data addresses — any that is missing is simply left out of its circle. */
  icons: Partial<Record<PresentationIconName, string>>;
  period: { period: PeriodKey; from?: string; to?: string };
  /** "Todas as conexões · todos os atendentes" — the Dashboard filters the numbers come from. */
  scopeLabel: string;
  data: DashboardSnapshot;
  /** The Dashboard's satisfaction (same numbers as Relatórios); per attendant and the latest evaluations for Gestor/Administrador. */
  satisfaction: SatisfactionOverviewDTO | null;
  /** Relatórios › Pesquisa de satisfação for the same period — over time and per connection. */
  satisfactionReport?: SatisfactionReportDTO | null;
  team: TeamData | null;
  wordCloud: { word: string; count: number }[];
  presenceByHour: PresenceByHourDTO | null;
  presenceHourRange: HourRange | null;
  arrivalsByHour?: ArrivalsByHourDTO | null;
  arrivalsHourRange?: HourRange | null;
  /** Relatórios › Mensagens bloqueadas for the same period — what the tags stopped (Gestor/Administrador). */
  autoMessageBlocks?: AutoMessageBlocksReportDTO | null;
  now: Date;
}

// ---- canvas (16:9 wide) and type ----
const W = 13.333;
const M = 0.6; // side margin
const CONTENT_W = W - 2 * M;
const CONTENT_TOP = 1.65;
const CONTENT_BOTTOM = 6.75;
const FONT = "Calibri";

// ---- neutrals and status colors (the brand color comes from the input) ----
const INK = "0F172A";
const BODY = "334155";
const MUTED = "64748B";
const FAINT = "94A3B8";
const LINE = "E2E8F0";
const PAGE = "F4F6F9";
const WHITE = "FFFFFF";
const AMBER = "F59E0B";
const GREEN = "16A34A";
const RED = "DC2626";
const SLATE = "64748B";

const MASTER_COVER = "WA_CAPA";
const MASTER_CONTENT = "WA_CONTEUDO";
const MASTER_CLOSING = "WA_ENCERRAMENTO";

/** Bars and table rows shown on one slide; the rest is summarized in the notes or continued. */
const MAX_AGENTS_IN_CHART = 12;
const AGENT_ROWS_PER_SLIDE = 11;
const MAX_WORDS = 12;

const hex = (color: string) => color.replace("#", "").toUpperCase();

/**
 * Where a bar chart goes inside the `room` it could fill, sized to its bars: with one or two attendants
 * (or words) a chart stretched over the whole card draws each bar as thick as a wall. Each bar gets
 * about `per` inches (plus `extra` for the axis and legend) and the chart sits in the middle of the room.
 */
export function fitBars(count: number, start: number, room: number, per: number, extra: number): { start: number; size: number } {
  const size = Math.min(room, count * per + extra);
  return { start: start + (room - size) / 2, size };
}

interface Palette {
  brand: string;
  deep: string;
  dark: string;
  soft: string;
  mid: string;
}

function palette(primary: string): Palette {
  return {
    brand: hex(primary),
    deep: hex(darken(primary, 0.35)),
    dark: hex(darken(primary, 0.66)),
    soft: hex(lighten(primary, 0.9)),
    mid: hex(lighten(primary, 0.45)),
  };
}

/** Signed change in percent against the previous period, or null when there is nothing to compare with. */
export function relativeChange(current: number | null, previous: number | null): number | null {
  if (current === null || previous === null || previous === 0) return null;
  return Math.round(((current - previous) / previous) * 100);
}

export interface Highlight {
  icon: PresentationIconName;
  value: string;
  title: string;
  detail: string;
}

/**
 * The period in up to four sentences, for the slide right after the cover: volume, speed of the
 * first answer, satisfaction (or closed conversations, without a survey) and who attended the most.
 * Only facts taken straight from the Dashboard's numbers — nothing is guessed.
 */
export function buildHighlights(input: Pick<PresentationInput, "data" | "satisfaction">): Highlight[] {
  const { data } = input;
  const items: Highlight[] = [];

  const volumeChange = relativeChange(data.conversations.received, data.previous.received);
  const uniqueText = `${formatNumber(data.conversations.unique)} ${data.conversations.unique === 1 ? "cliente diferente" : "clientes diferentes"}`;
  items.push({
    icon: "inbox",
    value: formatNumber(data.conversations.received),
    title: data.conversations.received === 1 ? "conversa recebida" : "conversas recebidas",
    detail:
      volumeChange === null
        ? uniqueText
        : volumeChange === 0
          ? `O mesmo volume do período anterior · ${uniqueText}`
          : `${Math.abs(volumeChange)}% ${volumeChange > 0 ? "a mais" : "a menos"} que no período anterior · ${uniqueText}`,
  });

  if (data.timings.avgFirstResponseMs !== null) {
    const speedChange = relativeChange(data.timings.avgFirstResponseMs, data.previous.avgFirstResponseMs);
    items.push({
      icon: "timer",
      value: formatMinutes(data.timings.avgFirstResponseMs),
      title: "até a 1ª resposta, em média",
      detail:
        speedChange === null
          ? "Do aceite até o atendente responder pela primeira vez"
          : speedChange === 0
            ? "O mesmo tempo do período anterior"
            : speedChange < 0
              ? `${Math.abs(speedChange)}% mais rápido que no período anterior`
              : `${speedChange}% mais lento que no período anterior`,
    });
  }

  const nps = npsOverview(input.satisfaction);
  if (nps) {
    const delta = npsDelta(nps.nps, nps.previous.nps);
    items.push({
      icon: "star",
      value: formatNps(nps.nps),
      title: "de NPS, de 0 a 100 (satisfação dos clientes)",
      detail: `${npsZone(nps.nps).label} · ${formatNumber(nps.answered)} ${nps.answered === 1 ? "resposta" : "respostas"}${delta ? ` · ${delta.text} vs. período anterior` : ""}`,
    });
  } else {
    const closedChange = relativeChange(data.conversations.closed, data.previous.closed);
    items.push({
      icon: "check",
      value: formatNumber(data.conversations.closed),
      title: data.conversations.closed === 1 ? "conversa encerrada" : "conversas encerradas",
      detail:
        closedChange === null
          ? "Atendimentos concluídos no período"
          : closedChange === 0
            ? "O mesmo número do período anterior"
            : `${Math.abs(closedChange)}% ${closedChange > 0 ? "a mais" : "a menos"} que no período anterior`,
    });
  }

  const ranked = [...data.perAgent].filter((a) => a.conversations > 0).sort((a, b) => b.conversations - a.conversations);
  if (ranked.length >= 2) {
    const total = ranked.reduce((sum, a) => sum + a.conversations, 0);
    const top = ranked[0];
    items.push({
      icon: "trophy",
      value: formatNumber(top.conversations),
      title: `conversas com ${top.agentName}`,
      detail: `Quem mais atendeu: ${percentOf(top.conversations, total)}% das conversas da equipe`,
    });
  }
  return items;
}

/** The period's NPS (0 a 100) when there are answers, with what the slides need. */
function npsOverview(overview: SatisfactionOverviewDTO | null) {
  if (!overview || overview.totals.answered === 0 || overview.totals.nps === null) return null;
  return { ...overview.totals, nps: overview.totals.nps, question: overview.currentQuestion, previous: overview.previous, goal: overview.settings.npsGoal };
}

/**
 * *negrito*, _itálico_ and ~riscado~ of a WhatsApp text as PowerPoint runs, line by line — the question as the
 * customer got it. Each line ends its paragraph itself, so a formatted word never starts a new line.
 */
export function whatsappRuns(value: string, options: PptxGenJS.TextPropsOptions = {}): PptxGenJS.TextProps[] {
  const runs: PptxGenJS.TextProps[] = [];
  const lines = value.split("\n");
  lines.forEach((line, li) => {
    const lineRuns: PptxGenJS.TextProps[] = [];
    let last = 0;
    for (const m of line.matchAll(/(\*[^*]+\*|_[^_]+_|~[^~]+~)/g)) {
      if (m.index! > last) lineRuns.push({ text: line.slice(last, m.index), options: { ...options } });
      const mark = m[0][0];
      lineRuns.push({ text: m[0].slice(1, -1), options: { ...options, bold: mark === "*" || options.bold, italic: mark === "_" || options.italic, strike: mark === "~" ? "sngStrike" : undefined } });
      last = m.index! + m[0].length;
    }
    if (last < line.length || lineRuns.length === 0) lineRuns.push({ text: line.slice(last) || " ", options: { ...options } });
    if (li < lines.length - 1) lineRuns[lineRuns.length - 1].options = { ...lineRuns[lineRuns.length - 1].options, breakLine: true };
    runs.push(...lineRuns);
  });
  return runs;
}

/** How a customer is named in the presentation: name and number, or only the initials (Respostas › Pesquisa). */
export function customerLabel(r: Pick<SatisfactionResponseDTO, "contactName" | "contactPhone">, mode: "full" | "initials"): string {
  const phone = r.contactPhone ? formatPhoneForSlide(r.contactPhone) : null;
  if (mode === "initials") {
    const initials = (r.contactName ?? "")
      .split(/\s+/)
      .filter(Boolean)
      .map((w) => `${w[0]!.toUpperCase()}.`)
      .slice(0, 3)
      .join(" ");
    return initials || "Cliente";
  }
  if (r.contactName && phone) return `${r.contactName} · ${phone}`;
  return r.contactName ?? phone ?? "Cliente";
}

function formatPhoneForSlide(phone: string): string {
  const digits = phone.replace(/\D/g, "");
  const local = digits.startsWith("55") && digits.length >= 12 ? digits.slice(2) : digits;
  if (local.length === 11) return `(${local.slice(0, 2)}) ${local.slice(2, 7)}-${local.slice(7)}`;
  if (local.length === 10) return `(${local.slice(0, 2)}) ${local.slice(2, 6)}-${local.slice(6)}`;
  return `+${digits}`;
}

/**
 * Builds the deck. `PptxGen` is pptxgenjs's class (loaded on demand by the caller); the returned
 * presentation is ready for writeFile/write.
 */
export function buildDashboardPresentation(PptxGen: typeof PptxGenJS, input: PresentationInput): PptxGenJS {
  const pptx = new PptxGen();
  const C = palette(input.primaryColor);
  const period = describePeriod(input.period, input.now);
  const periodLine = `${period.name} · ${period.dates}`;
  const generatedAt = input.now.toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" });
  const { data } = input;

  pptx.layout = "LAYOUT_WIDE";
  pptx.theme = { headFontFace: FONT, bodyFontFace: FONT };
  pptx.author = input.companyName;
  pptx.title = `Relatório de atendimento — ${periodLine}`;
  pptx.subject = "Indicadores do Dashboard do WhatsAtendende";

  // ---- layouts ----
  const logoBox = (maxW: number, maxH: number) => {
    if (!input.logo) return null;
    const scale = Math.min(maxW / input.logo.width, maxH / input.logo.height);
    return { w: input.logo.width * scale, h: input.logo.height * scale };
  };
  const headerLogo = logoBox(1.7, 0.55);

  pptx.defineSlideMaster({ title: MASTER_COVER, background: { color: C.dark } });
  pptx.defineSlideMaster({ title: MASTER_CLOSING, background: { color: C.dark } });
  pptx.defineSlideMaster({
    title: MASTER_CONTENT,
    background: { color: PAGE },
    margin: [0.5, M, 0.7, M],
    objects: [
      {
        placeholder: {
          options: { name: "title", type: "title", x: M, y: 0.62, w: headerLogo ? CONTENT_W - 2.2 : CONTENT_W, h: 0.75, fontFace: FONT, fontSize: 30, bold: true, color: INK, align: "left", valign: "top", margin: 0 },
          text: "",
        },
      },
      {
        text: {
          text: `${input.companyName}  ·  Relatório de atendimento  ·  ${periodLine}`,
          options: { x: M, y: 6.98, w: CONTENT_W - 1, h: 0.3, fontFace: FONT, fontSize: 10, color: FAINT, margin: 0, valign: "middle" },
        },
      },
      ...(input.logo && headerLogo
        ? [{ image: { data: input.logo.data, x: W - M - headerLogo.w, y: 0.42 + (0.55 - headerLogo.h) / 2, w: headerLogo.w, h: headerLogo.h } }]
        : []),
    ],
    slideNumber: { x: W - M - 0.6, y: 6.98, w: 0.6, h: 0.3, fontFace: FONT, fontSize: 10, color: FAINT, align: "right" },
  });

  // ---- drawing helpers ----
  const shadow = (): PptxGenJS.ShadowProps => ({ type: "outer", color: "000000", opacity: 0.07, blur: 10, offset: 2, angle: 90 });

  function card(slide: PptxGenJS.Slide, x: number, y: number, w: number, h: number, name: string, fill = WHITE, line = LINE) {
    slide.addShape(pptx.ShapeType.roundRect, { x, y, w, h, rectRadius: 0.08, fill: { color: fill }, line: { color: line, width: 0.75 }, shadow: shadow(), objectName: name });
  }

  function iconBadge(slide: PptxGenJS.Slide, icon: PresentationIconName, x: number, y: number, size: number, fill: string, name: string) {
    slide.addShape(pptx.ShapeType.ellipse, { x, y, w: size, h: size, fill: { color: fill }, line: { type: "none" }, objectName: `${name} - círculo` });
    const png = input.icons[icon];
    if (png) {
      const inset = size * 0.24;
      slide.addImage({ data: png, x: x + inset, y: y + inset, w: size - 2 * inset, h: size - 2 * inset, altText: "", objectName: `${name} - ícone` });
    }
  }

  function text(slide: PptxGenJS.Slide, value: string | PptxGenJS.TextProps[], options: PptxGenJS.TextPropsOptions) {
    slide.addText(value, { fontFace: FONT, margin: 0, isTextBox: true, ...options });
  }

  function kicker(slide: PptxGenJS.Slide, label: string) {
    text(slide, label.toUpperCase(), { x: M, y: 0.36, w: 8, h: 0.26, fontSize: 12, bold: true, color: C.brand, charSpacing: 2 });
  }

  function contentSlide(section: string, label: string, title: string) {
    const slide = pptx.addSlide({ masterName: MASTER_CONTENT, sectionTitle: section });
    kicker(slide, label);
    slide.addText(title, { placeholder: "title" });
    return slide;
  }

  const deltaRun = (delta: StatDelta | null): PptxGenJS.TextProps[] => {
    if (!delta) return [{ text: "sem período anterior para comparar", options: { color: FAINT } }];
    if (delta.text.startsWith("igual")) return [{ text: "= igual ao período anterior", options: { color: MUTED } }];
    return [{ text: `${delta.up ? "▲" : "▼"} ${delta.text}`, options: { color: delta.good ? GREEN : RED, bold: true } }];
  };

  const chartText = { catAxisLabelFontFace: FONT, valAxisLabelFontFace: FONT, dataLabelFontFace: FONT, legendFontFace: FONT, titleFontFace: FONT };
  const quietAxes = {
    catAxisLabelColor: BODY,
    catAxisLabelFontSize: 12,
    catAxisLineShow: false,
    valAxisHidden: true,
    valAxisLineShow: false,
    valGridLine: { style: "none" as const },
    catGridLine: { style: "none" as const },
    dataLabelColor: BODY,
    dataLabelFontSize: 12,
  };

  // ---- 1. Capa ----
  {
    pptx.addSection({ title: "Abertura" });
    const slide = pptx.addSlide({ masterName: MASTER_COVER, sectionTitle: "Abertura" });
    // The deck's motif: circles — large and translucent here, small with an icon inside on the content slides.
    slide.addShape(pptx.ShapeType.ellipse, { x: 8.3, y: -1.6, w: 6.6, h: 6.6, fill: { color: C.brand, transparency: 72 }, line: { type: "none" }, objectName: "Círculo decorativo grande" });
    slide.addShape(pptx.ShapeType.ellipse, { x: 10.4, y: 3.9, w: 4.2, h: 4.2, fill: { color: C.brand, transparency: 84 }, line: { type: "none" }, objectName: "Círculo decorativo médio" });
    slide.addShape(pptx.ShapeType.ellipse, { x: 9.2, y: 4.5, w: 1.1, h: 1.1, fill: { type: "none" }, line: { color: C.mid, width: 2 }, objectName: "Anel decorativo" });

    let top = 0.9;
    const coverLogo = logoBox(2.6, 0.75);
    if (input.logo && coverLogo) {
      card(slide, M, top, coverLogo.w + 0.5, coverLogo.h + 0.36, "Fundo do logo");
      slide.addImage({ data: input.logo.data, x: M + 0.25, y: top + 0.18, w: coverLogo.w, h: coverLogo.h, altText: `Logo ${input.companyName}`, objectName: "Logo" });
      top += coverLogo.h + 0.36 + 0.55;
    } else {
      text(slide, input.companyName, { x: M, y: top, w: 8, h: 0.5, fontSize: 22, bold: true, color: WHITE });
      top += 1.1;
    }
    text(slide, "RELATÓRIO DE ATENDIMENTO", { x: M, y: top + 0.35, w: 8, h: 0.35, fontSize: 14, bold: true, color: C.mid, charSpacing: 3 });
    text(slide, "Desempenho do atendimento", { x: M, y: top + 0.8, w: 8.6, h: 0.95, fontSize: 46, bold: true, color: WHITE });
    text(slide, periodLine, { x: M, y: top + 1.85, w: 8.6, h: 0.5, fontSize: 22, color: hex(lighten(C.brand, 0.8)) });
    text(slide, input.scopeLabel, { x: M, y: top + 2.4, w: 8.6, h: 0.35, fontSize: 14, color: hex(lighten(C.brand, 0.6)) });
    text(slide, `${input.companyName} · gerado em ${generatedAt}`, { x: M, y: 6.75, w: 8.6, h: 0.3, fontSize: 11, color: hex(lighten(C.brand, 0.5)) });
    slide.addNotes(
      `Relatório de atendimento de ${input.companyName}. Período: ${periodLine}. Dados do Dashboard do WhatsAtendende (${input.scopeLabel}), gerados em ${generatedAt}.`
    );
  }

  // ---- 2. O período em resumo ----
  {
    const highlights = buildHighlights(input);
    const slide = contentSlide("Abertura", "Visão geral", "O período em resumo");
    const cols = 2;
    const gap = 0.35;
    const cardW = (CONTENT_W - gap) / cols;
    const rows = Math.ceil(highlights.length / cols);
    const cardH = rows === 1 ? 2.6 : (CONTENT_BOTTOM - CONTENT_TOP - gap) / 2;
    // A single row (a quiet period) sits in the middle of the slide rather than leaving its bottom half empty.
    const top = rows === 1 ? CONTENT_TOP + (CONTENT_BOTTOM - CONTENT_TOP - cardH) / 2 : CONTENT_TOP;
    highlights.forEach((h, i) => {
      // A last card left alone in its row takes the whole width, so no empty slot is left beside it.
      const w = i === highlights.length - 1 && i % cols === 0 ? CONTENT_W : cardW;
      const x = M + (i % cols) * (cardW + gap);
      const y = top + Math.floor(i / cols) * (cardH + gap);
      card(slide, x, y, w, cardH, `Destaque ${i + 1}`);
      iconBadge(slide, h.icon, x + 0.4, y + 0.42, 0.85, C.brand, `Destaque ${i + 1}`);
      text(slide, h.value, { x: x + 1.55, y: y + 0.3, w: w - 1.9, h: 0.8, fontSize: 40, bold: true, color: C.deep, valign: "middle", fit: "shrink" });
      text(slide, h.title, { x: x + 1.55, y: y + 1.12, w: w - 1.9, h: 0.4, fontSize: 18, bold: true, color: INK });
      text(slide, h.detail, { x: x + 1.55, y: y + 1.55, w: w - 1.9, h: 0.75, fontSize: 14, color: MUTED, valign: "top" });
    });
    slide.addNotes(highlights.map((h) => `${h.value} ${h.title}. ${h.detail}.`).join("\n"));
  }

  // ---- 3. Indicadores (os cartões do Dashboard) ----
  {
    const slide = contentSlide("Abertura", "Visão geral", "Indicadores do período");
    const generatedTime = input.now.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
    const kpis: { label: string; value: string; icon: PresentationIconName; delta?: StatDelta | null; hint?: string; alert?: boolean }[] = [
      { label: "Conversas recebidas", value: formatNumber(data.conversations.received), icon: "inbox", delta: compareWithPrevious(data.conversations.received, data.previous.received) },
      { label: "Atendimentos únicos", value: formatNumber(data.conversations.unique), icon: "users", delta: compareWithPrevious(data.conversations.unique, data.previous.unique) },
      {
        label: "Na fila ao gerar o relatório",
        value: formatNumber(data.conversations.waiting),
        icon: "clock",
        hint: data.conversations.waiting > 0 ? `aguardando um atendente às ${generatedTime}` : `ninguém esperando às ${generatedTime}`,
        alert: data.conversations.waiting > 0,
      },
      {
        label: "1ª resposta (média)",
        value: formatMinutes(data.timings.avgFirstResponseMs),
        icon: "timer",
        delta: compareWithPrevious(data.timings.avgFirstResponseMs, data.previous.avgFirstResponseMs, true),
      },
      { label: "Encerradas", value: formatNumber(data.conversations.closed), icon: "check", delta: compareWithPrevious(data.conversations.closed, data.previous.closed) },
      { label: "Mensagens", value: formatNumber(data.messages.total), icon: "messages", delta: compareWithPrevious(data.messages.total, data.previous.messagesTotal) },
    ];
    const gap = 0.3;
    const cardW = (CONTENT_W - 2 * gap) / 3;
    const cardH = (CONTENT_BOTTOM - CONTENT_TOP - gap) / 2;
    kpis.forEach((k, i) => {
      const x = M + (i % 3) * (cardW + gap);
      const y = CONTENT_TOP + Math.floor(i / 3) * (cardH + gap);
      card(slide, x, y, cardW, cardH, `Indicador ${k.label}`, k.alert ? "FFFBEB" : WHITE, k.alert ? "FCD34D" : LINE);
      iconBadge(slide, k.icon, x + 0.35, y + 0.35, 0.62, k.alert ? AMBER : C.brand, `Indicador ${k.label}`);
      text(slide, k.label, { x: x + 1.15, y: y + 0.35, w: cardW - 1.4, h: 0.62, fontSize: 15, bold: true, color: BODY, valign: "middle" });
      text(slide, k.value, { x: x + 0.35, y: y + 1.05, w: cardW - 0.7, h: 0.8, fontSize: 40, bold: true, color: INK, valign: "middle", fit: "shrink" });
      text(slide, k.hint ? [{ text: k.hint, options: { color: k.alert ? "B45309" : MUTED, bold: k.alert } }] : deltaRun(k.delta ?? null), {
        x: x + 0.35,
        y: y + 1.9,
        w: cardW - 0.7,
        h: 0.35,
        fontSize: 13,
        valign: "middle",
      });
    });
    slide.addNotes(
      [
        "Os mesmos cartões do topo do Dashboard. As setas comparam com um período do mesmo tamanho logo antes deste: verde é bom (mais conversas, ou menos tempo), vermelho é ruim.",
        `"Na fila" é uma fotografia do momento em que o relatório foi gerado (${generatedAt}), não um total do período.`,
        "Atendimentos únicos contam clientes diferentes: o mesmo cliente com duas conversas conta uma vez.",
      ].join("\n")
    );
  }

  // ---- 4. Volume: conversas por status e mensagens ----
  {
    pptx.addSection({ title: "Atendimento" });
    const slide = contentSlide("Atendimento", "Atendimento", "Volume do período");
    const gap = 0.35;
    const cardW = (CONTENT_W - gap) / 2;
    const cardH = CONTENT_BOTTOM - CONTENT_TOP;
    const blocks = [
      {
        title: "Conversas por status",
        unit: "conversas",
        parts: [
          { label: "Aguardando (agora)", value: data.conversations.waiting, color: AMBER },
          { label: "Em atendimento", value: data.conversations.inProgress, color: C.brand },
          { label: "Encerradas", value: data.conversations.closed, color: SLATE },
        ],
      },
      {
        title: "Mensagens recebidas x enviadas",
        unit: "mensagens",
        parts: [
          { label: "Recebidas", value: data.messages.received, color: C.brand },
          { label: "Enviadas", value: data.messages.sent, color: C.deep },
        ],
      },
    ];
    blocks.forEach((block, i) => {
      const x = M + i * (cardW + gap);
      const y = CONTENT_TOP;
      card(slide, x, y, cardW, cardH, block.title);
      text(slide, block.title, { x: x + 0.4, y: y + 0.3, w: cardW - 0.8, h: 0.4, fontSize: 18, bold: true, color: INK });
      const total = block.parts.reduce((sum, p) => sum + p.value, 0);
      const chartSize = 3.0;
      const cx = x + 0.3;
      const cy = y + 1.15;
      if (total > 0) {
        slide.addChart(pptx.ChartType.doughnut, [{ name: block.title, labels: block.parts.map((p) => p.label), values: block.parts.map((p) => p.value) }], {
          x: cx,
          y: cy,
          w: chartSize,
          h: chartSize,
          holeSize: 62,
          chartColors: block.parts.map((p) => p.color),
          showLegend: false,
          showValue: false,
          showPercent: false,
          showTitle: false,
          dataBorder: { pt: 1.5, color: WHITE },
          objectName: `Gráfico ${block.title}`,
          ...chartText,
        });
        text(
          slide,
          [
            { text: formatNumber(total), options: { fontSize: 26, bold: true, color: INK, breakLine: true } },
            { text: block.unit, options: { fontSize: 12, color: MUTED } },
          ],
          { x: cx + 0.55, y: cy + chartSize / 2 - 0.45, w: chartSize - 1.1, h: 0.9, align: "center", valign: "middle" }
        );
      } else {
        text(slide, `Sem ${block.unit} no período`, { x: cx, y: cy + chartSize / 2 - 0.2, w: chartSize, h: 0.4, fontSize: 14, color: MUTED, align: "center" });
      }
      // The legend carries the numbers too — color is never the only cue.
      const legendX = x + chartSize + 0.6;
      const legendW = cardW - chartSize - 0.6 - 0.3;
      block.parts.forEach((p, j) => {
        const ly = y + 1.55 + j * 0.85;
        slide.addShape(pptx.ShapeType.ellipse, { x: legendX, y: ly + 0.1, w: 0.2, h: 0.2, fill: { color: p.color }, line: { type: "none" }, objectName: `${block.title} - ${p.label} (cor)` });
        text(slide, p.label, { x: legendX + 0.35, y: ly, w: legendW - 0.35, h: 0.4, fontSize: 14, color: BODY, valign: "middle" });
        text(
          slide,
          [
            { text: formatNumber(p.value), options: { bold: true, color: INK } },
            { text: `  ${percentOf(p.value, total)}%`, options: { color: MUTED } },
          ],
          { x: legendX + 0.35, y: ly + 0.34, w: legendW - 0.35, h: 0.36, fontSize: 15, valign: "middle" }
        );
      });
    });
    slide.addNotes(
      [
        `Conversas: ${formatNumber(data.conversations.inProgress)} em atendimento e ${formatNumber(data.conversations.closed)} encerradas no período; ${formatNumber(data.conversations.waiting)} aguardavam na fila quando o relatório foi gerado.`,
        `Mensagens: ${formatNumber(data.messages.received)} recebidas dos clientes e ${formatNumber(data.messages.sent)} enviadas pela equipe.`,
      ].join("\n")
    );
  }

  // ---- 5. A jornada da conversa e os tempos médios (só quando há algum tempo para mostrar) ----
  if (Object.values(data.timings).some((ms) => ms !== null)) {
    const t = data.timings;
    const slide = contentSlide("Atendimento", "Atendimento", "Tempos médios da jornada do cliente");
    const firstDelta = compareWithPrevious(t.avgFirstResponseMs, data.previous.avgFirstResponseMs, true);
    const stops = [
      { label: "Entrou na fila", icon: "inbox" as const },
      { label: "Aceita por um atendente", icon: "headset" as const },
      { label: "1ª resposta enviada", icon: "messages" as const },
      { label: "Conversa encerrada", icon: "flag" as const },
    ];
    const lineY = 3.6;
    const dot = 0.7;
    const xs = [1.5, 5.0, 8.5, 12.0].map((cx) => cx - dot / 2 + 0.0);
    // The path, then the stops on it.
    slide.addShape(pptx.ShapeType.line, { x: xs[0] + dot / 2, y: lineY, w: xs[3] - xs[0], h: 0, line: { color: C.mid, width: 3 }, objectName: "Linha da jornada" });
    stops.forEach((s, i) => {
      iconBadge(slide, s.icon, xs[i], lineY - dot / 2, dot, i === 0 || i === 3 ? C.deep : C.brand, `Etapa ${s.label}`);
      text(slide, s.label, { x: xs[i] + dot / 2 - 1.2, y: lineY + dot / 2 + 0.12, w: 2.4, h: 0.4, fontSize: 14, bold: true, color: INK, align: "center" });
    });
    // A stop no conversation reached in the period says so, quietly, instead of a lone "-".
    const noData = "sem dados";
    // Segment times above the path.
    const segment = (from: number, to: number, ms: number | null, label: string, extra?: PptxGenJS.TextProps[]) => {
      const x = xs[from] + dot / 2 + 0.25;
      const w = xs[to] - xs[from] - 0.5;
      text(
        slide,
        [
          ms === null
            ? { text: noData, options: { fontSize: 20, italic: true, color: FAINT, breakLine: true } }
            : { text: formatMinutes(ms), options: { fontSize: 30, bold: true, color: C.deep, breakLine: true } },
          { text: label, options: { fontSize: 13, color: MUTED, breakLine: Boolean(extra) } },
          ...(extra ?? []),
        ],
        { x, y: lineY - 1.75, w, h: 1.45, align: "center", valign: "bottom" }
      );
    };
    segment(0, 1, t.avgAcceptMs, "esperando na fila até o aceite");
    segment(1, 2, t.avgFirstResponseMs, "do aceite até a 1ª resposta", firstDelta ? deltaRun(firstDelta).map((r) => ({ ...r, options: { ...r.options, fontSize: 12 } })) : undefined);
    text(slide, "a conversa segue até ser resolvida", { x: xs[2] + dot / 2 + 0.25, y: lineY - 1.75, w: xs[3] - xs[2] - 0.5, h: 1.45, fontSize: 13, italic: true, color: FAINT, align: "center", valign: "bottom" });
    // Spans below the path: attendance (accept → close) and the whole way (queue → close).
    const bracket = (from: number, to: number, y: number, ms: number | null, label: string, color: string, name: string) => {
      const x1 = xs[from] + dot / 2;
      const x2 = xs[to] + dot / 2;
      slide.addShape(pptx.ShapeType.line, { x: x1, y, w: x2 - x1, h: 0, line: { color, width: 1.5 }, objectName: `${name} - traço` });
      slide.addShape(pptx.ShapeType.line, { x: x1, y: y - 0.12, w: 0, h: 0.24, line: { color, width: 1.5 }, objectName: `${name} - início` });
      slide.addShape(pptx.ShapeType.line, { x: x2, y: y - 0.12, w: 0, h: 0.24, line: { color, width: 1.5 }, objectName: `${name} - fim` });
      const labelW = 4.6;
      slide.addShape(pptx.ShapeType.roundRect, { x: (x1 + x2) / 2 - labelW / 2, y: y - 0.25, w: labelW, h: 0.5, rectRadius: 0.5, fill: { color: PAGE }, line: { type: "none" }, objectName: `${name} - fundo do rótulo` });
      text(
        slide,
        [
          ms === null
            ? { text: `${noData}  `, options: { italic: true, color: FAINT, fontSize: 15 } }
            : { text: `${formatMinutes(ms)}  `, options: { bold: true, color, fontSize: 18 } },
          { text: label, options: { color: BODY, fontSize: 13 } },
        ],
        { x: (x1 + x2) / 2 - labelW / 2, y: y - 0.25, w: labelW, h: 0.5, align: "center", valign: "middle" }
      );
    };
    bracket(1, 3, 5.2, t.avgHandlingMs, "de atendimento (aceite → encerramento)", C.brand, "Tempo de atendimento");
    bracket(0, 3, 6.2, t.avgClosingMs, "do início ao fim (fila → encerramento)", C.deep, "Tempo total");
    const noteTime = (ms: number | null) => (ms === null ? "sem dados no período" : formatMinutes(ms));
    slide.addNotes(
      [
        "Cada média vem das conversas do período que passaram pela etapa:",
        `• Aceite: ${noteTime(t.avgAcceptMs)} — da entrada na fila até um atendente aceitar.`,
        `• 1ª resposta: ${noteTime(t.avgFirstResponseMs)} — do aceite até a primeira mensagem escrita pelo atendente (a mensagem automática de aceite não conta).`,
        `• Atendimento: ${noteTime(t.avgHandlingMs)} — do aceite até o encerramento.`,
        `• Até o encerramento: ${noteTime(t.avgClosingMs)} — da entrada na fila até o encerramento.`,
        "As distâncias entre as etapas não estão em escala.",
      ].join("\n")
    );
  }

  // ---- 6. Satisfação (NPS) ----
  const nps = npsOverview(input.satisfaction);
  if (nps) {
    pptx.addSection({ title: "Satisfação" });
    const slide = contentSlide("Satisfação", "Satisfação dos clientes", "Como os clientes avaliam o atendimento");
    const zone = npsZone(nps.nps);
    const zoneColor = { success: GREEN, primary: C.brand, warning: AMBER, danger: RED }[zone.tone];
    const leftW = 4.1;
    const cardH = CONTENT_BOTTOM - CONTENT_TOP;
    card(slide, M, CONTENT_TOP, leftW, cardH, "NPS do período");
    text(slide, "NPS do período (0 a 100)", { x: M + 0.4, y: CONTENT_TOP + 0.3, w: leftW - 0.8, h: 0.4, fontSize: 18, bold: true, color: INK });
    text(slide, formatNps(nps.nps), { x: M + 0.4, y: CONTENT_TOP + 0.75, w: 2.0, h: 1.35, fontSize: 80, bold: true, color: zoneColor, valign: "middle" });
    // Against the period before and the goal, next to the number.
    const delta = npsDelta(nps.nps, nps.previous.nps);
    const side: PptxGenJS.TextProps[] = [];
    if (delta) side.push({ text: delta.text, options: { bold: true, color: delta.tone === "up" ? GREEN : delta.tone === "down" ? RED : MUTED, fontSize: 15, breakLine: true } });
    if (delta) side.push({ text: "vs. período anterior", options: { color: MUTED, fontSize: 11, breakLine: nps.goal !== null } });
    if (nps.goal !== null) {
      side.push({ text: `Meta ${nps.goal}: ${nps.nps >= nps.goal ? "acima" : "abaixo"}`, options: { bold: true, color: nps.nps >= nps.goal ? GREEN : RED, fontSize: 13 } });
    }
    if (side.length) text(slide, side, { x: M + 2.35, y: CONTENT_TOP + 0.95, w: leftW - 2.6, h: 1.0, valign: "middle", fit: "shrink" });
    slide.addShape(pptx.ShapeType.roundRect, { x: M + 0.4, y: CONTENT_TOP + 2.3, w: 2.9, h: 0.42, rectRadius: 0.5, fill: { color: zoneColor, transparency: 85 }, line: { type: "none" }, objectName: "Faixa da zona do NPS" });
    text(slide, zone.label, { x: M + 0.4, y: CONTENT_TOP + 2.3, w: 2.9, h: 0.42, fontSize: 14, bold: true, color: zoneColor, align: "center", valign: "middle" });
    const rate = nps.sent ? `${percentOf(nps.answered, nps.sent)}% de resposta` : "";
    text(
      slide,
      [
        { text: `${formatNumber(nps.answered)} ${nps.answered === 1 ? "resposta" : "respostas"}`, options: { bold: true, color: INK, breakLine: true } },
        { text: `de ${formatNumber(nps.sent)} ${nps.sent === 1 ? "pesquisa enviada" : "pesquisas enviadas"}${rate ? ` · ${rate}` : ""}`, options: { color: MUTED } },
      ],
      { x: M + 0.4, y: CONTENT_TOP + 3.0, w: leftW - 0.8, h: 0.75, fontSize: 14, valign: "top" }
    );
    if (nps.question) {
      text(slide, whatsappRuns(nps.question, { color: MUTED }), { x: M + 0.4, y: CONTENT_TOP + 3.85, w: leftW - 0.8, h: 1.1, fontSize: 12, valign: "top", fit: "shrink", paraSpaceAfter: 0 });
    }

    const rx = M + leftW + 0.35;
    const rw = CONTENT_W - leftW - 0.35;
    card(slide, rx, CONTENT_TOP, rw, cardH, "Notas de 0 a 10");
    text(slide, "Notas de 0 a 10", { x: rx + 0.4, y: CONTENT_TOP + 0.3, w: rw - 0.8, h: 0.4, fontSize: 18, bold: true, color: INK });
    const scores = Array.from({ length: 11 }, (_, i) => String(i));
    const only = (from: number, to: number) => nps.distribution.map((v, i) => (i >= from && i <= to ? v : 0));
    // One series per group, each zero outside its scores, drawn on top of each other (overlap 100%): every bar
    // takes its group's color and keeps its count above it, even the short ones.
    slide.addChart(
      pptx.ChartType.bar,
      [
        { name: "Detratores (0–6)", labels: scores, values: only(0, 6) },
        { name: "Neutros (7–8)", labels: scores, values: only(7, 8) },
        { name: "Promotores (9–10)", labels: scores, values: only(9, 10) },
      ],
      {
        x: rx + 0.25,
        y: CONTENT_TOP + 0.8,
        w: rw - 0.5,
        h: 2.9,
        barDir: "col",
        barGrouping: "clustered",
        barOverlapPct: 100,
        barGapWidthPct: 45,
        chartColors: [RED, AMBER, GREEN],
        showLegend: false,
        showValue: true,
        dataLabelPosition: "outEnd",
        dataLabelFormatCode: "#,##0;-#,##0;;",
        ...chartText,
        ...quietAxes,
        dataLabelColor: INK,
        objectName: "Gráfico das notas",
      }
    );
    const groups = [
      { label: "Promotores", range: "notas 9 e 10", count: nps.promoters, color: GREEN },
      { label: "Neutros", range: "notas 7 e 8", count: nps.passives, color: AMBER },
      { label: "Detratores", range: "notas de 0 a 6", count: nps.detractors, color: RED },
    ];
    const gw = (rw - 0.8) / 3;
    groups.forEach((g, i) => {
      const gx = rx + 0.4 + i * gw;
      const gy = CONTENT_TOP + 3.9;
      slide.addShape(pptx.ShapeType.ellipse, { x: gx, y: gy + 0.12, w: 0.2, h: 0.2, fill: { color: g.color }, line: { type: "none" }, objectName: `${g.label} (cor)` });
      text(slide, g.label, { x: gx + 0.32, y: gy, w: gw - 0.4, h: 0.44, fontSize: 15, bold: true, color: INK, valign: "middle" });
      text(
        slide,
        [
          { text: `${percentOf(g.count, nps.answered)}%`, options: { fontSize: 24, bold: true, color: g.color } },
          { text: `  ${formatNumber(g.count)} · ${g.range}`, options: { fontSize: 12, color: MUTED } },
        ],
        { x: gx + 0.32, y: gy + 0.45, w: gw - 0.4, h: 0.55, valign: "middle" }
      );
    });
    slide.addNotes(
      [
        `NPS ${formatNps(nps.nps)} de 0 a 100 (${zone.label.toLowerCase()}), com ${formatNumber(nps.answered)} respostas de ${formatNumber(nps.sent)} pesquisas enviadas no período.`,
        `Período anterior: ${nps.previous.nps === null ? "sem respostas" : `NPS ${nps.previous.nps}`}.${nps.goal !== null ? ` Meta: ${nps.goal}.` : ""}`,
        "NPS de 0 a 100: 0 quando todos são detratores (notas 0 a 6), 50 quando promotores (9 e 10) e detratores empatam, 100 quando todos são promotores.",
        "Zonas: 88 ou mais excelência, 75 a 87 qualidade, 50 a 74 aperfeiçoamento, abaixo de 50 crítica.",
        ...(nps.question ? [`Pergunta enviada: ${nps.question}`] : []),
      ].join("\n")
    );
  }

  // ---- 6b-6e. Satisfação em detalhe (Relatórios › Pesquisa de satisfação) ----
  const report = input.satisfactionReport;
  const byAgent = input.satisfaction?.byAgent ?? report?.byAgent ?? null;
  const customerMode = input.satisfaction?.settings.presentationCustomer ?? report?.settings.presentationCustomer ?? "full";
  const goal = input.satisfaction?.settings.npsGoal ?? report?.settings.npsGoal ?? null;
  if (nps && byAgent) {
    const npsColor = (value: number | null) => (value === null ? MUTED : { success: GREEN, primary: C.brand, warning: AMBER, danger: RED }[npsZone(value).tone]);
    const headCell = (h: string, i: number) => ({
      text: h,
      options: { bold: true, color: WHITE, fill: { color: C.deep }, align: i === 0 ? ("left" as const) : ("right" as const), fontSize: 13 },
    });
    const tableOptions = (rows: number, colW: number[], name: string): PptxGenJS.TableProps => ({
      x: M,
      y: CONTENT_TOP,
      w: CONTENT_W,
      colW,
      rowH: Math.min(0.55, Math.max(0.4, (CONTENT_BOTTOM - CONTENT_TOP) / (rows + 1))),
      fontFace: FONT,
      valign: "middle",
      margin: [0.04, 0.12, 0.04, 0.12],
      border: { type: "solid", pt: 0.5, color: LINE },
      autoPage: false,
      objectName: name,
    });
    const average = (v: number | null) => (v === null ? "-" : v.toLocaleString("pt-BR", { minimumFractionDigits: 1, maximumFractionDigits: 1 }));

    // 6b. Por atendente — who the customers rate best, with the full NPS breakdown.
    const agents = byAgent.filter((a) => a.sent > 0);
    const agentPages = Math.ceil(agents.length / AGENT_ROWS_PER_SLIDE);
    for (let page = 0; page < agentPages; page++) {
      const rows = agents.slice(page * AGENT_ROWS_PER_SLIDE, (page + 1) * AGENT_ROWS_PER_SLIDE);
      const slide = contentSlide("Satisfação", "Satisfação dos clientes", agentPages > 1 ? `Satisfação por atendente (${page + 1} de ${agentPages})` : "Satisfação por atendente");
      const header = ["Atendente", "Pesquisas", "Respostas", "Taxa", "Nota média", "NPS (0–100)", "Variação", "Promotores", "Neutros", "Detratores"];
      const body = rows.map((a, r) => {
        const fill = { color: r % 2 === 0 ? WHITE : "F8FAFC" };
        const values = [
          a.agentName,
          formatNumber(a.sent),
          formatNumber(a.answered),
          a.responseRate === null ? "-" : `${a.responseRate}%`,
          average(a.average),
          a.nps === null ? "-" : formatNps(a.nps),
          npsDelta(a.nps, a.previousNps)?.text ?? "-",
          formatNumber(a.promoters),
          formatNumber(a.passives),
          formatNumber(a.detractors),
        ];
        const deltaTone = npsDelta(a.nps, a.previousNps)?.tone;
        return values.map((value, i) => ({
          text: i === 0 && a.answered > 0 && a.answered < NPS_SMALL_SAMPLE ? `${value} *` : value,
          options: {
            fill,
            color: i === 0 ? INK : i === 5 ? npsColor(a.nps) : i === 6 ? (deltaTone === "up" ? GREEN : deltaTone === "down" ? RED : MUTED) : BODY,
            bold: i === 0 || i === 5,
            align: i === 0 ? ("left" as const) : ("right" as const),
            fontSize: 13,
          },
        }));
      });
      slide.addTable([header.map(headCell), ...body], tableOptions(rows.length, [2.6, 1.05, 1.1, 0.85, 1.15, 1.2, 1.25, 1.2, 1.0, 1.13], "Tabela de satisfação por atendente"));
      if (rows.some((a) => a.answered > 0 && a.answered < NPS_SMALL_SAMPLE)) {
        text(slide, `* Amostra pequena: menos de ${NPS_SMALL_SAMPLE} respostas — uma nota só muda muito o NPS.`, { x: M, y: CONTENT_BOTTOM + 0.05, w: CONTENT_W, h: 0.3, fontSize: 11, italic: true, color: MUTED });
      }
      slide.addNotes(
        "Uma linha por atendente, do NPS mais alto para o mais baixo, de 0 a 100. Variação é a diferença para o período anterior de mesmo tamanho. " +
          "Taxa é quantas pesquisas enviadas o cliente respondeu. O NPS de quem tem poucas respostas muda muito com uma nota só: olhe junto com a coluna Respostas." +
          (goal !== null ? ` Meta: ${goal}.` : "")
      );
    }

    // 6c. Ao longo do período.
    if (report && report.trend.length >= 2) {
      const slide = contentSlide("Satisfação", "Satisfação dos clientes", "Evolução da satisfação no período");
      card(slide, M, CONTENT_TOP, CONTENT_W, CONTENT_BOTTOM - CONTENT_TOP, "Evolução do NPS");
      const labels = report.trend.map((t) => t.label);
      const lineOptions = {
        lineSize: 3,
        lineDataSymbol: "circle" as const,
        lineDataSymbolSize: 9,
        showValue: true,
        dataLabelPosition: "t" as const,
        dataLabelFormatCode: "0",
        dataLabelColor: INK,
      };
      // The NPS with its numbers; the goal (when there is one) as a dashed line without numbers, in the same chart.
      const series: PptxGenJS.IChartMulti[] = [
        { type: pptx.ChartType.line, data: [{ name: "NPS", labels, values: report.trend.map((t) => t.nps ?? 0) }], options: { ...lineOptions, chartColors: [C.brand] } },
      ];
      if (goal !== null) {
        series.push({
          type: pptx.ChartType.line,
          data: [{ name: `Meta ${goal}`, labels, values: report.trend.map(() => goal) }],
          options: { chartColors: [GREEN], lineSize: 2, lineDash: "dash", lineDataSymbol: "none", showValue: false },
        });
      }
      // A multi-type chart takes its options in the place of the data (pptxgenjs); the typing asks for data there.
      slide.addChart(series, undefined as unknown as [], {
        x: M + 0.3,
        y: CONTENT_TOP + 0.25,
        w: CONTENT_W - 0.6,
        h: CONTENT_BOTTOM - CONTENT_TOP - 0.5,
        showLegend: goal !== null,
        legendPos: "b",
        valAxisMinVal: 0,
        valAxisMaxVal: 100,
        ...chartText,
        ...quietAxes,
        catAxisLabelFontSize: labels.length > 16 ? 10 : 12,
        objectName: "Gráfico da evolução do NPS",
      });
      slide.addNotes(
        report.trend.map((t) => `${t.label}: NPS ${t.nps === null ? "-" : formatNps(t.nps)}, nota média ${average(t.average)}, ${formatNumber(t.answered)} respostas`).join("\n")
      );
    }

    // 6d. Por conexão, quando há mais de uma.
    if (report && report.byConnection.length > 1) {
      const slide = contentSlide("Satisfação", "Satisfação dos clientes", "Satisfação por conexão");
      const rows = report.byConnection.slice(0, AGENT_ROWS_PER_SLIDE);
      const header = ["Conexão", "Pesquisas", "Respostas", "Taxa", "Nota média", "NPS (0–100)", "Promotores", "Neutros", "Detratores"];
      const body = rows.map((c, r) => {
        const fill = { color: r % 2 === 0 ? WHITE : "F8FAFC" };
        return [
          c.connectionName,
          formatNumber(c.sent),
          formatNumber(c.answered),
          c.responseRate === null ? "-" : `${c.responseRate}%`,
          average(c.average),
          c.nps === null ? "-" : formatNps(c.nps),
          formatNumber(c.promoters),
          formatNumber(c.passives),
          formatNumber(c.detractors),
        ].map((value, i) => ({
          text: value,
          options: { fill, color: i === 0 ? INK : i === 5 ? npsColor(c.nps) : BODY, bold: i === 0 || i === 5, align: i === 0 ? ("left" as const) : ("right" as const), fontSize: 13 },
        }));
      });
      slide.addTable([header.map(headCell), ...body], tableOptions(rows.length, [3.0, 1.1, 1.15, 0.95, 1.25, 1.0, 1.25, 1.1, 1.33], "Tabela de satisfação por conexão"));
      slide.addNotes("Uma linha por número de WhatsApp, do NPS mais alto para o mais baixo.");
    }

    // 6d2. Quem não respondeu a pesquisa — no total (respondidas × sem resposta × ainda no prazo) e por atendente. Só números.
    const surveyTotals = report?.totals ?? input.satisfaction?.totals ?? null;
    if (surveyTotals && surveyTotals.sent > 0) {
      const slide = contentSlide("Satisfação", "Satisfação dos clientes", "Quem não respondeu a pesquisa");
      const leftW = 4.3;
      const cardH = CONTENT_BOTTOM - CONTENT_TOP;
      card(slide, M, CONTENT_TOP, leftW, cardH, "Respostas da pesquisa");
      text(slide, "Pesquisas enviadas", { x: M + 0.4, y: CONTENT_TOP + 0.3, w: leftW - 0.8, h: 0.4, fontSize: 18, bold: true, color: INK });
      const parts = [
        { label: "Responderam", value: surveyTotals.answered, color: GREEN },
        { label: "Não responderam", value: surveyTotals.unanswered, color: RED },
        { label: "Ainda no prazo", value: surveyTotals.awaiting, color: SLATE },
      ];
      slide.addChart(pptx.ChartType.doughnut, [{ name: "Pesquisas", labels: parts.map((p) => p.label), values: parts.map((p) => p.value) }], {
        x: M + 0.55,
        y: CONTENT_TOP + 0.85,
        w: 3.2,
        h: 3.2,
        holeSize: 62,
        chartColors: parts.map((p) => p.color),
        showLegend: false,
        showValue: false,
        showPercent: false,
        showTitle: false,
        dataBorder: { pt: 1.5, color: WHITE },
        objectName: "Gráfico de respostas da pesquisa",
        ...chartText,
      });
      text(
        slide,
        [
          { text: formatNumber(surveyTotals.sent), options: { fontSize: 26, bold: true, color: INK, breakLine: true } },
          { text: "enviadas", options: { fontSize: 12, color: MUTED } },
        ],
        { x: M + 0.55, y: CONTENT_TOP + 2.05, w: 3.2, h: 0.8, align: "center", valign: "middle" }
      );
      parts.forEach((p, i) => {
        const y = CONTENT_TOP + 4.25 + i * 0.27;
        slide.addShape(pptx.ShapeType.ellipse, { x: M + 0.45, y: y + 0.07, w: 0.13, h: 0.13, fill: { color: p.color }, line: { type: "none" }, objectName: `Legenda ${p.label}` });
        text(slide, `${p.label}: ${formatNumber(p.value)} (${percentOf(p.value, surveyTotals.sent)}%)`, { x: M + 0.68, y, w: leftW - 1.0, h: 0.27, fontSize: 12, color: BODY });
      });

      const rightX = M + leftW + 0.3;
      const rightW = CONTENT_W - leftW - 0.3;
      card(slide, rightX, CONTENT_TOP, rightW, cardH, "Sem resposta por atendente");
      text(slide, "Por atendente", { x: rightX + 0.4, y: CONTENT_TOP + 0.3, w: rightW - 0.8, h: 0.4, fontSize: 18, bold: true, color: INK });
      const agents = [...(report?.byAgent ?? [])].filter((a) => a.sent > 0).sort((a, b) => b.unanswered - a.unanswered || b.sent - a.sent).slice(0, MAX_AGENTS_IN_CHART);
      if (agents.length > 0) {
        const bottomUp = [...agents].reverse();
        const box = fitBars(agents.length, CONTENT_TOP + 0.8, cardH - 1.0, 0.5, 0.5);
        slide.addChart(
          pptx.ChartType.bar,
          [
            { name: "Responderam", labels: bottomUp.map((a) => a.agentName), values: bottomUp.map((a) => a.answered) },
            { name: "Não responderam", labels: bottomUp.map((a) => a.agentName), values: bottomUp.map((a) => a.unanswered) },
          ],
          {
            x: rightX + 0.25,
            y: box.start,
            w: rightW - 0.5,
            h: box.size,
            barDir: "bar",
            barGrouping: "stacked",
            barGapWidthPct: 55,
            chartColors: [GREEN, RED],
            showLegend: true,
            legendPos: "b",
            legendFontSize: 12,
            showValue: true,
            dataLabelFormatCode: "#,##0;;",
            ...chartText,
            ...quietAxes,
            dataLabelColor: WHITE,
            dataLabelFontSize: 11,
            catAxisLabelFontSize: 12,
            objectName: "Gráfico de respostas por atendente",
          }
        );
      } else {
        text(slide, "Sem o detalhe por atendente neste período.", { x: rightX + 0.4, y: CONTENT_TOP + 1.0, w: rightW - 0.8, h: 0.4, fontSize: 14, color: MUTED, italic: true });
      }
      slide.addNotes(
        [
          `${formatNumber(surveyTotals.sent)} pesquisas enviadas: ${formatNumber(surveyTotals.answered)} responderam, ${formatNumber(surveyTotals.unanswered)} não responderam no prazo e ${formatNumber(surveyTotals.awaiting)} ainda estão no prazo.`,
          ...agents.map((a) => `${a.agentName}: ${formatNumber(a.unanswered)} sem resposta de ${formatNumber(a.sent)} (${percentOf(a.unanswered, a.sent)}%)`),
          "A lista com os nomes dos clientes está em Relatórios › Pesquisa de satisfação.",
        ].join("\n")
      );
    }

    // 6e. As últimas 5 de cada grupo — detratores, neutros e promotores, com o cliente e o atendente.
    const latestOf = (category: SatisfactionResponseDTO["category"]) =>
      input.satisfaction?.latest?.[category!] ??
      (report?.responses ?? [])
        .filter((r) => r.category === category)
        .sort((x, y) => (y.answeredAt ?? "").localeCompare(x.answeredAt ?? ""))
        .slice(0, 5);
    const groups = [
      { key: "detractor", title: "Detratores", range: "notas 0 a 6", color: RED },
      { key: "passive", title: "Neutros", range: "notas 7 e 8", color: AMBER },
      { key: "promoter", title: "Promotores", range: "notas 9 e 10", color: GREEN },
    ] as const;
    const latest = groups.map((g) => ({ ...g, items: latestOf(g.key) }));
    if (latest.some((g) => g.items.length > 0)) {
      const slide = contentSlide("Satisfação", "Satisfação dos clientes", "Últimas avaliações de cada grupo");
      const gap = 0.3;
      const colW = (CONTENT_W - gap * 2) / 3;
      const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }) : "-");
      const notes: string[] = [];
      latest.forEach((g, gi) => {
        const x = M + gi * (colW + gap);
        card(slide, x, CONTENT_TOP, colW, CONTENT_BOTTOM - CONTENT_TOP, g.title);
        slide.addShape(pptx.ShapeType.rect, { x, y: CONTENT_TOP, w: colW, h: 0.09, fill: { color: g.color }, line: { type: "none" }, objectName: `Faixa ${g.title}` });
        text(
          slide,
          [
            { text: g.title, options: { bold: true, color: INK, fontSize: 18 } },
            { text: `  ${g.range}`, options: { color: MUTED, fontSize: 12 } },
          ],
          { x: x + 0.3, y: CONTENT_TOP + 0.25, w: colW - 0.6, h: 0.45 }
        );
        if (g.items.length === 0) text(slide, "Nenhuma no período", { x: x + 0.3, y: CONTENT_TOP + 0.9, w: colW - 0.6, h: 0.4, fontSize: 12, italic: true, color: MUTED });
        g.items.forEach((r, i) => {
          const y = CONTENT_TOP + 0.85 + i * 0.8;
          const who = customerLabel(r, customerMode);
          slide.addShape(pptx.ShapeType.ellipse, { x: x + 0.3, y: y + 0.05, w: 0.5, h: 0.5, fill: { color: g.color, transparency: 82 }, line: { type: "none" }, objectName: `Nota ${r.score}` });
          text(slide, String(r.score), { x: x + 0.3, y: y + 0.05, w: 0.5, h: 0.5, fontSize: 15, bold: true, color: g.color, align: "center", valign: "middle" });
          text(
            slide,
            [
              { text: who, options: { bold: true, color: INK, fontSize: 12, breakLine: true } },
              { text: `${r.agentName ?? "-"} · ${when(r.answeredAt)}`, options: { color: MUTED, fontSize: 11 } },
            ],
            { x: x + 0.95, y, w: colW - 1.2, h: 0.62, valign: "middle", fit: "shrink" }
          );
          notes.push(`${g.title}: ${who}, nota ${r.score}, ${r.agentName ?? "-"}, ${when(r.answeredAt)}`);
        });
      });
      slide.addNotes(
        "As 5 avaliações mais recentes de cada grupo no período. Cada uma pode ser aberta em Relatórios › Pesquisa de satisfação › Ver conversa.\n" + notes.join("\n")
      );
    }
  }

  // ---- 7-9. Equipe ----
  const ranked = [...data.perAgent].sort((a, b) => b.conversations - a.conversations || a.agentName.localeCompare(b.agentName));
  if (ranked.length > 0) {
    pptx.addSection({ title: "Equipe" });
    const shown = ranked.slice(0, MAX_AGENTS_IN_CHART);
    const left = ranked.length - shown.length;
    const totalConversations = ranked.reduce((sum, a) => sum + a.conversations, 0);

    // 7. Conversas por atendente
    {
      const slide = contentSlide("Equipe", "Equipe", "Conversas por atendente");
      const chartH = CONTENT_BOTTOM - CONTENT_TOP - (left > 0 ? 0.45 : 0);
      card(slide, M, CONTENT_TOP, CONTENT_W, CONTENT_BOTTOM - CONTENT_TOP, "Conversas por atendente");
      // A horizontal bar chart draws its first category at the bottom: reversed, the one with most is on top.
      const bottomUp = [...shown].reverse();
      const box = fitBars(shown.length, CONTENT_TOP + 0.2, chartH - 0.35, 0.62, 0.4);
      slide.addChart(pptx.ChartType.bar, [{ name: "Conversas", labels: bottomUp.map((a) => a.agentName), values: bottomUp.map((a) => a.conversations) }], {
        x: M + 0.3,
        y: box.start,
        w: CONTENT_W - 0.6,
        h: box.size,
        barDir: "bar",
        barGapWidthPct: 55,
        chartColors: [C.brand],
        showLegend: false,
        showValue: true,
        dataLabelPosition: "outEnd",
        dataLabelFormatCode: "#,##0",
        ...chartText,
        ...quietAxes,
        catAxisLabelFontSize: 13,
        dataLabelFontSize: 13,
        dataLabelColor: INK,
        objectName: "Gráfico de conversas por atendente",
      });
      if (left > 0) {
        text(slide, `E mais ${left} ${left === 1 ? "atendente" : "atendentes"} — todos estão na tabela de desempenho.`, { x: M + 0.4, y: CONTENT_BOTTOM - 0.5, w: CONTENT_W - 0.8, h: 0.35, fontSize: 12, color: MUTED, italic: true });
      }
      slide.addNotes(
        shown.map((a, i) => `${i + 1}. ${a.agentName}: ${formatNumber(a.conversations)} conversas (${percentOf(a.conversations, totalConversations)}%)`).join("\n")
      );
    }

    // 8. Mensagens por atendente
    {
      const slide = contentSlide("Equipe", "Equipe", "Mensagens enviadas e recebidas por atendente");
      card(slide, M, CONTENT_TOP, CONTENT_W, CONTENT_BOTTOM - CONTENT_TOP, "Mensagens por atendente");
      const box = fitBars(shown.length, M + 0.3, CONTENT_W - 0.6, 1.4, 1.4);
      slide.addChart(
        pptx.ChartType.bar,
        [
          { name: "Enviadas", labels: shown.map((a) => a.agentName), values: shown.map((a) => a.messagesSent) },
          { name: "Recebidas", labels: shown.map((a) => a.agentName), values: shown.map((a) => a.messagesReceived) },
        ],
        {
          x: box.start,
          y: CONTENT_TOP + 0.2,
          w: box.size,
          h: CONTENT_BOTTOM - CONTENT_TOP - 0.4,
          barDir: "col",
          barGrouping: "clustered",
          barGapWidthPct: 70,
          chartColors: [C.deep, C.mid],
          showLegend: true,
          legendPos: "t",
          legendFontSize: 13,
          legendColor: BODY,
          showValue: shown.length <= 8,
          dataLabelPosition: "outEnd",
          dataLabelFormatCode: "#,##0",
          ...chartText,
          ...quietAxes,
          catAxisLabelFontSize: shown.length > 8 ? 11 : 12,
          objectName: "Gráfico de mensagens por atendente",
        }
      );
      slide.addNotes(shown.map((a) => `${a.agentName}: ${formatNumber(a.messagesSent)} enviadas, ${formatNumber(a.messagesReceived)} recebidas`).join("\n"));
    }

    // 9. Tabela de desempenho (continua em mais de um slide se a equipe for grande)
    const online = new Map((input.team?.agents ?? []).map((a) => [a.agentId, a.onlineMs]));
    const withOnline = online.size > 0;
    const header = ["Atendente", "Conversas", "% da equipe", "Mensagens enviadas", "Mensagens recebidas", "Atendimento (média)", ...(withOnline ? ["Tempo online"] : [])];
    const colW = withOnline ? [3.1, 1.25, 1.35, 1.6, 1.6, 1.6, 1.63] : [3.6, 1.45, 1.5, 1.9, 1.9, 1.78];
    const pages = Math.ceil(ranked.length / AGENT_ROWS_PER_SLIDE);
    for (let page = 0; page < pages; page++) {
      const rows = ranked.slice(page * AGENT_ROWS_PER_SLIDE, (page + 1) * AGENT_ROWS_PER_SLIDE);
      const slide = contentSlide("Equipe", "Equipe", pages > 1 ? `Desempenho por atendente (${page + 1} de ${pages})` : "Desempenho por atendente");
      const head = header.map((h, i) => ({
        text: h,
        options: { bold: true, color: WHITE, fill: { color: C.deep }, align: i === 0 ? ("left" as const) : ("right" as const), fontSize: 13 },
      }));
      const body = rows.map((a, r) => {
        const fill = { color: r % 2 === 0 ? WHITE : "F8FAFC" };
        const cell = (value: string, i: number) => ({ text: value, options: { fill, color: i === 0 ? INK : BODY, bold: i === 0, align: i === 0 ? ("left" as const) : ("right" as const), fontSize: 13 } });
        return [
          a.agentName,
          formatNumber(a.conversations),
          `${percentOf(a.conversations, totalConversations)}%`,
          formatNumber(a.messagesSent),
          formatNumber(a.messagesReceived),
          formatMinutes(a.avgHandlingMs),
          ...(withOnline ? [online.has(a.agentId) ? formatMinutes(online.get(a.agentId)!) : "-"] : []),
        ].map(cell);
      });
      slide.addTable([head, ...body], {
        x: M,
        y: CONTENT_TOP,
        w: CONTENT_W,
        colW,
        // Taller rows when there are few people, so a small team doesn't leave half the slide empty.
        rowH: Math.min(0.55, Math.max(0.4, (CONTENT_BOTTOM - CONTENT_TOP) / (rows.length + 1))),
        fontFace: FONT,
        valign: "middle",
        margin: [0.04, 0.12, 0.04, 0.12],
        border: { type: "solid", pt: 0.5, color: LINE },
        autoPage: false,
        objectName: "Tabela de desempenho por atendente",
      });
      slide.addNotes(
        "Uma linha por atendente, de quem atendeu mais conversas para quem atendeu menos. Atendimento (média) é o tempo do aceite até o encerramento" +
          (withOnline ? "; Tempo online é quanto tempo o atendente ficou online no sistema no período." : ".")
      );
    }
  }

  // ---- 10. Equipe ao longo do dia ----
  if (input.presenceByHour && input.presenceByHour.series.length > 0) {
    const range = input.presenceHourRange;
    const isToday = input.period.period === "today";
    const currentHour = input.now.getHours();
    const points = input.presenceByHour.hours
      .filter((p) => !range || (p.hour >= range.start && p.hour <= range.end))
      .filter((p) => !isToday || p.hour <= currentHour);
    if (points.length > 0) {
      const slide = contentSlide("Equipe", "Equipe", "Equipe ao longo do dia");
      const seriesColors = [C.brand, AMBER, C.deep, SLATE, C.mid, "A855F7", "0EA5E9", "84CC16"];
      const snapshot = isToday && input.team ? input.team.now : null;
      const top = CONTENT_TOP + (snapshot ? 0.95 : 0);
      if (snapshot) {
        const pills = [
          { label: "online agora", value: snapshot.online, color: GREEN },
          { label: "em pausa", value: snapshot.paused, color: AMBER },
          { label: "offline", value: snapshot.offline, color: SLATE },
        ];
        pills.forEach((p, i) => {
          const px = M + i * 2.75;
          card(slide, px, CONTENT_TOP, 2.5, 0.7, `Equipe agora - ${p.label}`);
          slide.addShape(pptx.ShapeType.ellipse, { x: px + 0.25, y: CONTENT_TOP + 0.25, w: 0.2, h: 0.2, fill: { color: p.color }, line: { type: "none" }, objectName: `Equipe agora - ${p.label} (cor)` });
          text(
            slide,
            [
              { text: `${p.value} `, options: { bold: true, color: INK, fontSize: 20 } },
              { text: p.label, options: { color: MUTED, fontSize: 13 } },
            ],
            { x: px + 0.6, y: CONTENT_TOP, w: 1.8, h: 0.7, valign: "middle" }
          );
        });
      }
      card(slide, M, top, CONTENT_W, CONTENT_BOTTOM - top, "Presença por hora");
      const labels = points.map((p) => `${String(p.hour).padStart(2, "0")}h`);
      // People are whole: with a small team the automatic axis would count 0,2 – 0,4 – 0,6 people.
      const tallest = Math.max(...points.map((p) => input.presenceByHour!.series.reduce((sum, key) => sum + (p.counts[key] ?? 0), 0)));
      slide.addChart(
        pptx.ChartType.bar,
        input.presenceByHour.series.map((key) => ({ name: key, labels, values: points.map((p) => p.counts[key] ?? 0) })),
        {
          x: M + 0.3,
          y: top + 0.15,
          w: CONTENT_W - 0.6,
          h: CONTENT_BOTTOM - top - 0.3,
          barDir: "col",
          barGrouping: "stacked",
          barGapWidthPct: 40,
          chartColors: input.presenceByHour.series.map((_, i) => seriesColors[i % seriesColors.length]),
          showLegend: true,
          legendPos: "t",
          legendFontSize: 13,
          legendColor: BODY,
          ...chartText,
          ...quietAxes,
          valAxisHidden: false,
          valAxisLabelColor: MUTED,
          valAxisLabelFontSize: 11,
          valAxisLabelFormatCode: "0",
          ...(tallest <= 5 ? { valAxisMajorUnit: 1, valAxisMaxVal: Math.max(tallest, 1) } : {}),
          valGridLine: { color: LINE, size: 0.75 },
          catAxisLabelFontSize: 11,
          objectName: "Gráfico de presença por hora",
        }
      );
      slide.addNotes(
        "Quantas pessoas da equipe estavam em cada situação (online, em cada motivo de pausa) em cada hora do período" +
          (range ? `, na faixa das ${range.start}h às ${range.end}h escolhida no Dashboard` : "") +
          "." +
          (snapshot ? ` No momento em que o relatório foi gerado: ${snapshot.online} online, ${snapshot.paused} em pausa e ${snapshot.offline} offline.` : "")
      );
    }
  }

  // ---- 10b. Quando as conversas chegam ----
  if (input.arrivalsByHour) {
    const summary = arrivalsSummary(input.arrivalsByHour);
    const range = input.arrivalsHourRange;
    const isToday = input.period.period === "today";
    const currentHour = input.now.getHours();
    const points = input.arrivalsByHour.hours
      .filter((p) => !range || (p.hour >= range.start && p.hour <= range.end))
      .filter((p) => !isToday || p.hour <= currentHour);
    if (summary.total > 0 && points.length > 0) {
      const slide = contentSlide("Equipe", "Equipe", "Quando as conversas chegam");
      const figures = [
        { label: "horário de pico", value: summary.peakHour !== null ? `${String(summary.peakHour).padStart(2, "0")}h` : "—" },
        { label: "conversas no período", value: formatNumber(summary.total) },
        { label: "fora do expediente", value: `${summary.outsideShare}%` },
      ];
      figures.forEach((f, i) => {
        const px = M + i * 2.75;
        card(slide, px, CONTENT_TOP, 2.5, 0.7, `Chegadas - ${f.label}`);
        text(
          slide,
          [
            { text: `${f.value} `, options: { bold: true, color: INK, fontSize: 20 } },
            { text: f.label, options: { color: MUTED, fontSize: 12 } },
          ],
          { x: px + 0.2, y: CONTENT_TOP, w: 2.2, h: 0.7, valign: "middle" }
        );
      });
      const top = CONTENT_TOP + 0.95;
      card(slide, M, top, CONTENT_W, CONTENT_BOTTOM - top, "Conversas por hora");
      const labels = points.map((p) => `${String(p.hour).padStart(2, "0")}h`);
      // A combo chart (columns + a line on its own scale): pptxgenjs takes the options in place of the data here.
      const addCombo = slide.addChart.bind(slide) as unknown as (types: unknown[], options: Record<string, unknown>) => void;
      addCombo(
        [
          {
            type: pptx.ChartType.bar,
            data: [
              { name: "Dentro do expediente", labels, values: points.map((p) => p.inside) },
              { name: "Fora do expediente", labels, values: points.map((p) => p.outside) },
            ],
            options: { barDir: "col", barGrouping: "stacked", barGapWidthPct: 40, chartColors: [C.brand, AMBER] },
          },
          {
            type: pptx.ChartType.line,
            data: [{ name: "Atendentes online (média)", labels, values: points.map((p) => p.onlineAvg) }],
            options: { chartColors: [SLATE], lineSize: 2, lineDataSymbol: "circle", lineDataSymbolSize: 6, secondaryValAxis: true, secondaryCatAxis: true },
          },
        ],
        {
          x: M + 0.3,
          y: top + 0.15,
          w: CONTENT_W - 0.6,
          h: CONTENT_BOTTOM - top - 0.3,
          showLegend: true,
          legendPos: "t",
          legendFontSize: 13,
          legendColor: BODY,
          ...chartText,
          valAxes: [
            { showValAxisTitle: false, valAxisLabelColor: MUTED, valAxisLabelFontSize: 11, valAxisLabelFormatCode: "0", valGridLine: { color: LINE, size: 0.75 } },
            { showValAxisTitle: false, valAxisLabelColor: MUTED, valAxisLabelFontSize: 11, valAxisLabelFormatCode: "0.0", valGridLine: { style: "none" } },
          ],
          catAxes: [{ catAxisTitle: "", catAxisLabelFontSize: 11 }, { catAxisHidden: true }],
          objectName: "Gráfico de conversas por hora",
        }
      );
      slide.addNotes(
        "Conversas novas abertas pelo cliente em cada hora do dia, somando todos os dias do período, separadas entre dentro e fora do Horário de expediente da conexão. A linha mostra quantos atendentes estavam online, em média, em cada hora" +
          (range ? `; faixa das ${range.start}h às ${range.end}h escolhida no Dashboard` : "") +
          `. Horário de pico: ${figures[0].value}; ${summary.outsideShare}% chegaram fora do expediente.`
      );
    }
  }

  // ---- 11. O que os clientes mais falam ----
  const words = [...input.wordCloud].sort((a, b) => b.count - a.count).slice(0, MAX_WORDS);
  if (words.length > 0) {
    pptx.addSection({ title: "Clientes" });
    const slide = contentSlide("Clientes", "Clientes", "O que os clientes mais falam");
    const chartW = 7.6;
    card(slide, M, CONTENT_TOP, chartW, CONTENT_BOTTOM - CONTENT_TOP, "Palavras mais usadas");
    const wordsBottomUp = [...words].reverse();
    const box = fitBars(words.length, CONTENT_TOP + 0.2, CONTENT_BOTTOM - CONTENT_TOP - 0.4, 0.62, 0.4);
    slide.addChart(pptx.ChartType.bar, [{ name: "Menções", labels: wordsBottomUp.map((w) => w.word), values: wordsBottomUp.map((w) => w.count) }], {
      x: M + 0.3,
      y: box.start,
      w: chartW - 0.6,
      h: box.size,
      barDir: "bar",
      barGapWidthPct: 45,
      chartColors: [C.brand],
      showLegend: false,
      showValue: true,
      dataLabelPosition: "outEnd",
      dataLabelFormatCode: "#,##0",
      ...chartText,
      ...quietAxes,
      catAxisLabelFontSize: 13,
      dataLabelFontSize: 13,
      dataLabelColor: INK,
      objectName: "Gráfico de palavras mais usadas",
    });
    const sideX = M + chartW + 0.35;
    const sideW = CONTENT_W - chartW - 0.35;
    card(slide, sideX, CONTENT_TOP, sideW, CONTENT_BOTTOM - CONTENT_TOP, "As três mais citadas", C.soft, C.soft);
    text(slide, "As três mais citadas", { x: sideX + 0.4, y: CONTENT_TOP + 0.35, w: sideW - 0.8, h: 0.4, fontSize: 18, bold: true, color: INK });
    words.slice(0, 3).forEach((w, i) => {
      const wy = CONTENT_TOP + 1.0 + i * 1.15;
      text(slide, String(i + 1), { x: sideX + 0.4, y: wy, w: 0.5, h: 0.85, fontSize: 36, bold: true, color: C.brand, valign: "middle" });
      text(
        slide,
        [
          { text: w.word, options: { fontSize: 22, bold: true, color: INK, breakLine: true } },
          { text: `${formatNumber(w.count)} ${w.count === 1 ? "menção" : "menções"}`, options: { fontSize: 13, color: MUTED } },
        ],
        { x: sideX + 1.0, y: wy, w: sideW - 1.4, h: 0.85, valign: "middle" }
      );
    });
    text(slide, "Palavras das mensagens dos clientes no período, sem artigos, preposições e outras palavras comuns.", {
      x: sideX + 0.4,
      y: CONTENT_BOTTOM - 1.15,
      w: sideW - 0.8,
      h: 0.85,
      fontSize: 12,
      color: MUTED,
      valign: "bottom",
    });
    slide.addNotes(words.map((w) => `${w.word}: ${formatNumber(w.count)}`).join("\n"));
  }

  // ---- 11b. Mensagens automáticas bloqueadas pelas etiquetas ----
  const blocks = input.autoMessageBlocks;
  if (blocks && blocks.total > 0) {
    pptx.addSection({ title: "Mensagens automáticas" });
    const slide = contentSlide("Mensagens automáticas", "Mensagens automáticas", "Mensagens bloqueadas pelas etiquetas");
    const cardH = CONTENT_BOTTOM - CONTENT_TOP;
    const leftW = CONTENT_W * 0.6;
    card(slide, M, CONTENT_TOP, leftW, cardH, "Bloqueadas por mensagem");
    text(slide, `${formatNumber(blocks.total)} ${blocks.total === 1 ? "mensagem não enviada" : "mensagens não enviadas"}`, {
      x: M + 0.4,
      y: CONTENT_TOP + 0.3,
      w: leftW - 0.8,
      h: 0.4,
      fontSize: 18,
      bold: true,
      color: INK,
    });
    const byKind = [...blocks.byKind].reverse();
    const box = fitBars(byKind.length, CONTENT_TOP + 0.85, cardH - 1.05, 0.55, 0.4);
    slide.addChart(pptx.ChartType.bar, [{ name: "Bloqueadas", labels: byKind.map((k) => AUTO_MESSAGE_KIND_LABEL[k.kind] ?? k.kind), values: byKind.map((k) => k.count) }], {
      x: M + 0.25,
      y: box.start,
      w: leftW - 0.5,
      h: box.size,
      barDir: "bar",
      barGapWidthPct: 55,
      chartColors: [C.brand],
      showLegend: false,
      showValue: true,
      dataLabelPosition: "outEnd",
      dataLabelFormatCode: "#,##0",
      ...chartText,
      ...quietAxes,
      catAxisLabelFontSize: 13,
      dataLabelFontSize: 13,
      dataLabelColor: INK,
      objectName: "Gráfico de mensagens bloqueadas por tipo",
    });
    const rightX = M + leftW + 0.3;
    const rightW = CONTENT_W - leftW - 0.3;
    card(slide, rightX, CONTENT_TOP, rightW, cardH, "Etiquetas que mais bloquearam");
    text(slide, "Etiquetas que mais bloquearam", { x: rightX + 0.4, y: CONTENT_TOP + 0.3, w: rightW - 0.8, h: 0.4, fontSize: 18, bold: true, color: INK });
    blocks.byTag.slice(0, 8).forEach((t, i) => {
      const y = CONTENT_TOP + 0.95 + i * 0.5;
      text(slide, t.tagName, { x: rightX + 0.4, y, w: rightW - 1.8, h: 0.4, fontSize: 14, color: BODY, valign: "middle" });
      text(slide, formatNumber(t.count), { x: rightX + rightW - 1.4, y, w: 1.0, h: 0.4, fontSize: 14, bold: true, color: C.deep, align: "right", valign: "middle" });
    });
    slide.addNotes(
      [
        "Mensagens automáticas que não foram enviadas porque o cliente tem uma etiqueta que as bloqueia (Etiquetas › Bloqueia).",
        ...blocks.byKind.map((k) => `${AUTO_MESSAGE_KIND_LABEL[k.kind] ?? k.kind}: ${formatNumber(k.count)}`),
        "O detalhe, conversa por conversa, está em Relatórios › Mensagens bloqueadas.",
      ].join("\n")
    );
  }

  // ---- 12. Como ler os indicadores ----
  {
    pptx.addSection({ title: "Apêndice" });
    const slide = contentSlide("Apêndice", "Apêndice", "Como ler os indicadores");
    const terms: [string, string][] = [
      ["Conversas recebidas", "Conversas que começaram no período, em todas as conexões e atendentes do filtro."],
      ["Atendimentos únicos", "Clientes diferentes atendidos: o mesmo cliente em duas conversas conta uma vez."],
      ["Na fila", "Conversas esperando um atendente no momento em que o relatório foi gerado."],
      ["Aceite", "Tempo médio da entrada na fila até um atendente aceitar a conversa."],
      ["1ª resposta", "Tempo médio do aceite até o atendente escrever — a mensagem automática de aceite não conta."],
      ["Atendimento", "Tempo médio do aceite até o encerramento da conversa."],
      ["NPS (0 a 100)", "Promotores (9–10) e detratores (0–6) numa nota de 0 a 100: 0 todos detratores, 50 empate, 100 todos promotores."],
      ["Período anterior", "Um período do mesmo tamanho logo antes deste — base das setas de comparação."],
    ];
    const gapX = 0.35;
    const gapY = 0.25;
    const cw = (CONTENT_W - gapX) / 2;
    const ch = (CONTENT_BOTTOM - CONTENT_TOP - 3 * gapY) / 4;
    terms.forEach(([term, meaning], i) => {
      const x = M + (i % 2) * (cw + gapX);
      const y = CONTENT_TOP + Math.floor(i / 2) * (ch + gapY);
      card(slide, x, y, cw, ch, `Glossário - ${term}`);
      text(slide, term, { x: x + 0.35, y: y + 0.14, w: cw - 0.7, h: 0.4, fontSize: 16, bold: true, color: C.deep, valign: "middle" });
      text(slide, meaning, { x: x + 0.35, y: y + 0.52, w: cw - 0.7, h: ch - 0.62, fontSize: 13, color: BODY, valign: "top" });
    });
    slide.addNotes("Definições dos números usados nesta apresentação, as mesmas do Dashboard do WhatsAtendende.");
  }

  // ---- 13. Encerramento ----
  {
    const slide = pptx.addSlide({ masterName: MASTER_CLOSING, sectionTitle: "Apêndice" });
    slide.addShape(pptx.ShapeType.ellipse, { x: -2.6, y: 4.6, w: 6.4, h: 6.4, fill: { color: C.brand, transparency: 76 }, line: { type: "none" }, objectName: "Círculo decorativo" });
    const closingLogo = logoBox(2.4, 0.7);
    if (input.logo && closingLogo) {
      const badgeW = closingLogo.w + 0.5;
      card(slide, (W - badgeW) / 2, 1.05, badgeW, closingLogo.h + 0.36, "Fundo do logo");
      slide.addImage({ data: input.logo.data, x: (W - closingLogo.w) / 2, y: 1.23, w: closingLogo.w, h: closingLogo.h, altText: `Logo ${input.companyName}`, objectName: "Logo" });
    }
    slide.addShape(pptx.ShapeType.ellipse, { x: 10.6, y: -1.2, w: 3.6, h: 3.6, fill: { color: C.brand, transparency: 86 }, line: { type: "none" }, objectName: "Círculo decorativo pequeno" });
    text(slide, "Obrigado", { x: 1.5, y: 2.45, w: W - 3, h: 1.1, fontSize: 54, bold: true, color: WHITE, align: "center", valign: "middle" });
    text(slide, `${input.companyName} · Relatório de atendimento · ${periodLine}`, { x: 1.5, y: 3.6, w: W - 3, h: 0.45, fontSize: 18, color: hex(lighten(C.brand, 0.75)), align: "center" });
    text(slide, `Dados do Dashboard do WhatsAtendende, gerados em ${generatedAt}`, { x: 1.5, y: 4.1, w: W - 3, h: 0.4, fontSize: 13, color: hex(lighten(C.brand, 0.5)), align: "center" });
    slide.addNotes("Encerramento. Os números podem ser conferidos no Dashboard do WhatsAtendende, com os mesmos filtros.");
  }

  return pptx;
}
