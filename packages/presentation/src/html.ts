import { ANNOUNCEMENT_KIND_LABEL, AUTO_MESSAGE_KIND_LABEL, NPS_SMALL_SAMPLE, SAUBERLICH_CREDIT, type SatisfactionResponseDTO, type SeriesChartKind } from "@whatsatendende/types";
import { darken, lighten } from "./colors";
import { arrivalsSummary } from "./shared";
import { compareWithPrevious, describePeriod, formatMinutes, formatNps, formatNumber, npsDelta, npsZone, percentOf, type StatDelta } from "./metrics";
import { buildHighlights, customerLabel, type PresentationIconName, type PresentationInput } from "./presentation";

/**
 * The Dashboard's presentation as one HTML page — the same sections and numbers as the PowerPoint, for a browser:
 * one slide per screen on a computer (arrows, space, swipe, F for full screen, an index), the sections one under
 * the other on a phone. Charts show their numbers on hover or touch, legends turn series on and off, tables sort
 * by column and a low score opens its reason. Everything is inside the file — styles, script, charts (SVG and
 * HTML), logo and icons — so it opens offline and never fetches anything. The numbers are those of the moment it
 * was exported.
 */

const GREEN = "#16A34A";
const RED = "#DC2626";
const AMBER = "#F59E0B";
const SLATE = "#64748B";
const MAX_AGENTS_IN_CHART = 12;
const MAX_WORDS = 12;

const esc = (value: string | number) =>
  String(value).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

type Series = { name: string; color: string; values: number[] };

/** *negrito*, _itálico_ and ~riscado~ of a WhatsApp text, as the customer reads it. */
function whatsappHtml(value: string): string {
  return esc(value)
    .replace(/\*([^*\n]+)\*/g, "<b>$1</b>")
    .replace(/_([^_\n]+)_/g, "<i>$1</i>")
    .replace(/~([^~\n]+)~/g, "<s>$1</s>")
    .replace(/\n/g, "<br>");
}

function legend(series: { name: string; color: string }[]): string {
  if (series.length < 2) return "";
  return `<div class="lg">${series
    .map((s, i) => `<button type="button" data-s="${i}" aria-pressed="true"><i style="background:${s.color}"></i>${esc(s.name)}</button>`)
    .join("")}</div>`;
}

/** Bars lying down, one row per category — HTML, so the names stay readable on a phone. */
function hbars(labels: string[], series: Series[], options: { stacked?: boolean; suffix?: string; rowColors?: string[] } = {}): string {
  const suffix = options.suffix ?? "";
  const totals = labels.map((_, i) => series.reduce((sum, s) => sum + (s.values[i] ?? 0), 0));
  const max = Math.max(1, ...(options.stacked ? totals : series.flatMap((s) => s.values)));
  const rows = labels
    .map((label, i) => {
      const tip = (s: Series) => `${label} · ${s.name}: ${formatNumber(s.values[i] ?? 0)}${suffix}`;
      const track = options.stacked
        ? `<div class="hb-t">${series
            .map((s, si) =>
              (s.values[i] ?? 0) > 0
                ? `<span data-s="${si}" data-tip="${esc(tip(s))}" style="width:${((s.values[i] ?? 0) / max) * 100}%;background:${s.color}"></span>`
                : ""
            )
            .join("")}</div>`
        : `<div class="hb-g">${series
            .map(
              (s, si) =>
                `<div class="hb-t" data-s="${si}"><span data-tip="${esc(tip(s))}" style="width:${((s.values[i] ?? 0) / max) * 100}%;background:${options.rowColors?.[i] ?? s.color}"></span><em>${formatNumber(s.values[i] ?? 0)}${suffix}</em></div>`
            )
            .join("")}</div>`;
      return `<div class="hb-r"><span class="hb-l" title="${esc(label)}">${esc(label)}</span>${track}${options.stacked ? `<em>${formatNumber(totals[i])}${suffix}</em>` : ""}</div>`;
    })
    .join("");
  return `<div class="chart">${legend(series)}<div class="hb">${rows}</div></div>`;
}

/** The value axis: 4 or 5 round steps from 0 — whole ones for people and conversations (no "2,5 conversas"). */
function axisSteps(value: number, whole: boolean): { max: number; step: number } {
  if (value <= 0) return { max: 1, step: whole ? 1 : 0.25 };
  if (whole && value <= 5) return { max: Math.ceil(value), step: 1 };
  const rough = value / 4;
  const magnitude = 10 ** Math.floor(Math.log10(rough));
  const candidates = (whole && magnitude < 10 ? [1, 2, 5, 10] : [1, 2, 2.5, 5, 10]).map((n) => n * magnitude);
  const step = candidates.find((c) => c >= rough) ?? 10 * magnitude;
  return { max: Math.ceil(value / step) * step, step };
}

/**
 * Columns, a line or an area over categories (hours, attendants, scores) — SVG, scrolling sideways on a narrow
 * screen. `secondary` is a line on its own scale at the right (online attendants); `reference` a dashed line (a goal).
 */
interface ColsOptions {
  kind?: SeriesChartKind;
  stacked?: boolean;
  whole?: boolean;
  max?: number;
  barColors?: string[];
  secondary?: { name: string; color: string; values: number[] };
  reference?: { label: string; value: number; color: string };
  showValues?: boolean;
}

function cols(labels: string[], series: Series[], options: ColsOptions = {}): string {
  const kind = options.kind ?? "bar";
  const all = [...series, ...(options.secondary ? [{ ...options.secondary }] : [])];
  // Two drawings of the same chart: wide for a computer, narrow (bigger letters) for a phone.
  const wide = drawCols(760, 300, labels, series, options, kind);
  const narrow = drawCols(380, 260, labels, series, options, kind);
  const narrowMin = Math.max(300, labels.length * 30);
  return `<div class="chart">${legend(all)}<div class="scroll"><svg viewBox="0 0 760 300" class="cols wide" role="img">${wide}</svg><svg viewBox="0 0 380 260" class="cols narrow" role="img" style="min-width:${narrowMin}px">${narrow}</svg></div></div>`;
}

function drawCols(W: number, H: number, labels: string[], series: Series[], options: ColsOptions, kind: SeriesChartKind): string {
  const small = W < 500;
  const left = small ? 34 : 44;
  const right = options.secondary ? (small ? 34 : 44) : small ? 8 : 16;
  const top = 18;
  const bottom = labels.some((l) => l.length > 6) && labels.length > (small ? 3 : 6) ? 70 : 34;
  const plotW = W - left - right;
  const plotH = H - top - bottom;
  const stack = options.stacked && kind !== "line";
  const sums = labels.map((_, i) => series.reduce((s, x) => s + (x.values[i] ?? 0), 0));
  const rawMax = Math.max(0, ...(stack ? sums : series.flatMap((s) => s.values)), options.reference?.value ?? 0);
  const axis = options.max ? { max: options.max, step: options.max / 4 } : axisSteps(rawMax, Boolean(options.whole));
  const max = axis.max;
  const y = (v: number) => top + plotH - (v / max) * plotH;
  const band = plotW / Math.max(labels.length, 1);
  const cx = (i: number) => left + band * i + band / 2;
  const parts: string[] = [];
  // Grid and value axis.
  for (let v = 0; v <= max + 1e-9; v += axis.step) {
    const gy = y(v);
    parts.push(`<line x1="${left}" x2="${W - right}" y1="${gy}" y2="${gy}" class="grid"/>`);
    const text = v.toLocaleString("pt-BR", { maximumFractionDigits: 1 });
    parts.push(`<text x="${left - 6}" y="${gy + 4}" class="ax" text-anchor="end">${text}</text>`);
  }
  // Categories.
  const rotate = bottom > 34;
  labels.forEach((l, i) => {
    parts.push(
      rotate
        ? `<text transform="translate(${cx(i)},${top + plotH + 12}) rotate(-38)" class="ax" text-anchor="end">${esc(l.length > (small ? 12 : 18) ? `${l.slice(0, small ? 11 : 17)}…` : l)}</text>`
        : `<text x="${cx(i)}" y="${top + plotH + 20}" class="ax" text-anchor="middle">${esc(l)}</text>`
    );
  });
  if (kind === "bar") {
    const groupW = band * 0.72;
    labels.forEach((label, i) => {
      let base = 0;
      series.forEach((s, si) => {
        const v = s.values[i] ?? 0;
        const tip = esc(`${label} · ${s.name}: ${formatNumber(v)}`);
        const color = options.barColors?.[i] ?? s.color;
        if (stack) {
          if (v > 0) parts.push(`<rect data-s="${si}" data-tip="${tip}" x="${cx(i) - groupW / 2}" y="${y(base + v)}" width="${groupW}" height="${y(base) - y(base + v)}" rx="2" fill="${color}"/>`);
          base += v;
        } else {
          const w = groupW / series.length;
          const x = cx(i) - groupW / 2 + w * si;
          parts.push(`<rect data-s="${si}" data-tip="${tip}" x="${x + 1}" y="${y(v)}" width="${Math.max(w - 2, 1)}" height="${Math.max(top + plotH - y(v), v > 0 ? 1 : 0)}" rx="2" fill="${color}"/>`);
          if (options.showValues && v > 0) parts.push(`<text data-s="${si}" x="${x + w / 2}" y="${y(v) - 5}" class="val" text-anchor="middle">${formatNumber(v)}</text>`);
        }
      });
    });
  } else {
    const base = labels.map(() => 0);
    series.forEach((s, si) => {
      const tops = labels.map((_, i) => (stack ? base[i] + (s.values[i] ?? 0) : s.values[i] ?? 0));
      const line = tops.map((v, i) => `${i === 0 ? "M" : "L"}${cx(i)},${y(v)}`).join(" ");
      if (kind === "area") {
        const back = labels.map((_, i) => labels.length - 1 - i).map((i, k) => `${k === 0 ? "L" : "L"}${cx(i)},${y(stack ? base[i] : 0)}`).join(" ");
        parts.push(`<path data-s="${si}" d="${line} ${back} Z" fill="${s.color}" fill-opacity="0.35" stroke="${s.color}" stroke-width="2"/>`);
      } else {
        parts.push(`<path data-s="${si}" d="${line}" fill="none" stroke="${s.color}" stroke-width="2.5" stroke-linejoin="round"/>`);
      }
      tops.forEach((v, i) =>
        parts.push(`<circle data-s="${si}" data-tip="${esc(`${labels[i]} · ${s.name}: ${formatNumber(s.values[i] ?? 0)}`)}" cx="${cx(i)}" cy="${y(v)}" r="${kind === "line" ? 4 : 3}" fill="${s.color}"/>`)
      );
      if (stack) tops.forEach((v, i) => (base[i] = v));
    });
  }
  if (options.reference) {
    const ry = y(options.reference.value);
    parts.push(`<line x1="${left}" x2="${W - right}" y1="${ry}" y2="${ry}" stroke="${options.reference.color}" stroke-width="2" stroke-dasharray="6 5"/>`);
    parts.push(`<text x="${W - right}" y="${ry - 6}" class="ax" text-anchor="end" fill="${options.reference.color}">${esc(options.reference.label)}</text>`);
  }
  if (options.secondary) {
    const sec = options.secondary;
    const saxis = axisSteps(Math.max(0, ...sec.values), false);
    const smax = saxis.max;
    const sy = (v: number) => top + plotH - (v / smax) * plotH;
    const si = series.length;
    for (let v = 0; v <= smax + 1e-9; v += saxis.step) {
      parts.push(`<text x="${W - right + 6}" y="${sy(v) + 4}" class="ax">${v.toLocaleString("pt-BR", { maximumFractionDigits: 1 })}</text>`);
    }
    parts.push(`<path data-s="${si}" d="${sec.values.map((v, i) => `${i === 0 ? "M" : "L"}${cx(i)},${sy(v)}`).join(" ")}" fill="none" stroke="${sec.color}" stroke-width="2" stroke-dasharray="5 4"/>`);
    sec.values.forEach((v, i) =>
      parts.push(`<circle data-s="${si}" data-tip="${esc(`${labels[i]} · ${sec.name}: ${v.toLocaleString("pt-BR", { maximumFractionDigits: 1 })}`)}" cx="${cx(i)}" cy="${sy(v)}" r="3.5" fill="${sec.color}"/>`)
    );
  }
  return parts.join("");
}

/** Parts of a whole: a rosca or a pizza (SVG) with the legend carrying the numbers, or one bar per part. */
function distribution(parts: { label: string; value: number; color: string }[], kind: string | undefined, unit: string): string {
  const total = parts.reduce((sum, p) => sum + p.value, 0);
  if (total === 0) return `<p class="empty">Sem ${esc(unit)} no período</p>`;
  const legendHtml = `<ul class="dl">${parts
    .map((p) => `<li><i style="background:${p.color}"></i><span>${esc(p.label)}</span><b>${formatNumber(p.value)}</b><small>${percentOf(p.value, total)}%</small></li>`)
    .join("")}</ul>`;
  if (kind === "bar") {
    return `<div class="dist">${hbars(
      parts.map((p) => p.label),
      [{ name: unit, color: parts[0].color, values: parts.map((p) => p.value) }],
      { rowColors: parts.map((p) => p.color) }
    )}${legendHtml}</div>`;
  }
  const r = 90;
  const inner = kind === "pie" ? 0 : 56;
  let angle = -Math.PI / 2;
  const arcs = parts
    .filter((p) => p.value > 0)
    .map((p) => {
      const sweep = (p.value / total) * Math.PI * 2;
      const tip = esc(`${p.label}: ${formatNumber(p.value)} (${percentOf(p.value, total)}%)`);
      if (sweep >= Math.PI * 2 - 1e-6) {
        angle += sweep;
        return inner
          ? `<circle data-tip="${tip}" cx="100" cy="100" r="${(r + inner) / 2}" fill="none" stroke="${p.color}" stroke-width="${r - inner}"/>`
          : `<circle data-tip="${tip}" cx="100" cy="100" r="${r}" fill="${p.color}"/>`;
      }
      const a0 = angle;
      const a1 = angle + sweep;
      angle = a1;
      const large = sweep > Math.PI ? 1 : 0;
      const p0 = [100 + r * Math.cos(a0), 100 + r * Math.sin(a0)];
      const p1 = [100 + r * Math.cos(a1), 100 + r * Math.sin(a1)];
      const d = inner
        ? `M${p0} A${r},${r} 0 ${large} 1 ${p1} L${100 + inner * Math.cos(a1)},${100 + inner * Math.sin(a1)} A${inner},${inner} 0 ${large} 0 ${100 + inner * Math.cos(a0)},${100 + inner * Math.sin(a0)} Z`
        : `M100,100 L${p0} A${r},${r} 0 ${large} 1 ${p1} Z`;
      return `<path data-tip="${tip}" d="${d}" fill="${p.color}" stroke="var(--card)" stroke-width="2"/>`;
    })
    .join("");
  const center = inner ? `<text x="100" y="98" class="dc-n" text-anchor="middle">${formatNumber(total)}</text><text x="100" y="118" class="dc-u" text-anchor="middle">${esc(unit)}</text>` : "";
  return `<div class="dist"><svg viewBox="0 0 200 200" class="donut" role="img">${arcs}${center}</svg>${legendHtml}</div>`;
}

/** A table whose columns sort with a click; each cell is [shown text, sort value]. */
function table(header: string[], rows: { cells: [string, number | string][]; className?: string }[], options: { colored?: (row: number, col: number) => string | null } = {}): string {
  const head = header.map((h, i) => `<th data-col="${i}" class="${i === 0 ? "l" : ""}" title="Ordenar">${esc(h)}</th>`).join("");
  const body = rows
    .map(
      (row, r) =>
        `<tr>${row.cells
          .map(([text, sort], c) => {
            const color = options.colored?.(r, c);
            return `<td data-v="${esc(String(sort))}" class="${c === 0 ? "l" : ""}"${color ? ` style="color:${color};font-weight:700"` : ""}>${esc(text)}</td>`;
          })
          .join("")}</tr>`
    )
    .join("");
  return `<div class="tw"><table class="st"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>`;
}

export function buildDashboardHtml(input: PresentationInput): string {
  const { data } = input;
  const kinds = input.chartKinds ?? {};
  const brand = input.primaryColor;
  const deep = darken(brand, 0.35);
  const dark = darken(brand, 0.66);
  const mid = lighten(brand, 0.45);
  const soft = lighten(brand, 0.9);
  const period = describePeriod(input.period, input.now);
  const periodLine = `${period.name} · ${period.dates}`;
  const generatedAt = input.now.toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" });
  const prevLabel = data.previous.label ?? "período anterior";
  const icon = (name: PresentationIconName, color = brand) =>
    `<span class="ic" style="background:${color}">${input.icons[name] ? `<img src="${input.icons[name]}" alt="">` : ""}</span>`;
  const delta = (d: StatDelta | null) =>
    !d ? `<span class="muted">sem base para comparar</span>` : d.text.startsWith("igual") ? `<span class="muted">= ${esc(d.text)}</span>` : `<span style="color:${d.good ? GREEN : RED}"><b>${d.up ? "▲" : "▼"} ${esc(d.text)}</b></span>`;
  const npsColor = (v: number | null) => (v === null ? SLATE : { success: GREEN, primary: brand, warning: AMBER, danger: RED }[npsZone(v).tone]);

  const slides: { section: string; title: string; body: string; kind?: "cover" | "closing" }[] = [];
  const add = (section: string, title: string, body: string) => slides.push({ section, title, body });

  // 1. Capa
  slides.push({
    section: "Abertura",
    title: "Capa",
    kind: "cover",
    body: `${input.logo ? `<div class="logo-badge"><img src="${input.logo.data}" alt="Logo ${esc(input.companyName)}"></div>` : `<p class="co">${esc(input.companyName)}</p>`}
      <p class="eyebrow">Relatório de atendimento</p>
      <h1>Desempenho do atendimento</h1>
      <p class="period">${esc(periodLine)}</p>
      <p class="scope">${esc(input.scopeLabel)}</p>
      <p class="gen">${esc(input.companyName)} · gerado em ${esc(generatedAt)}</p>`,
  });

  // 2. Resumo
  const highlights = buildHighlights(input);
  add(
    "Visão geral",
    "O período em resumo",
    `<div class="grid g2">${highlights
      .map((h) => `<div class="card hl">${icon(h.icon)}<div><p class="big" style="color:var(--accent)">${esc(h.value)}</p><p class="t">${esc(h.title)}</p><p class="muted">${esc(h.detail)}</p></div></div>`)
      .join("")}</div>`
  );

  // 3. Indicadores
  const generatedTime = input.now.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
  const kpis: { label: string; value: string; icon: PresentationIconName; delta?: StatDelta | null; hint?: string; alert?: boolean }[] = [
    { label: "Conversas recebidas", value: formatNumber(data.conversations.received), icon: "inbox", delta: compareWithPrevious(data.conversations.received, data.previous.received, false, prevLabel, true) },
    { label: "Atendimentos únicos", value: formatNumber(data.conversations.unique), icon: "users", delta: compareWithPrevious(data.conversations.unique, data.previous.unique, false, prevLabel, true) },
    {
      label: "Na fila ao gerar o relatório",
      value: formatNumber(data.conversations.waiting),
      icon: "clock",
      hint: data.conversations.waiting > 0 ? `aguardando um atendente às ${generatedTime}` : `ninguém esperando às ${generatedTime}`,
      alert: data.conversations.waiting > 0,
    },
    { label: "1ª resposta (média)", value: formatMinutes(data.timings.avgFirstResponseMs), icon: "timer", delta: compareWithPrevious(data.timings.avgFirstResponseMs, data.previous.avgFirstResponseMs, true, prevLabel) },
    { label: "Encerradas", value: formatNumber(data.conversations.closed), icon: "check", delta: compareWithPrevious(data.conversations.closed, data.previous.closed, false, prevLabel, true) },
    { label: "Mensagens", value: formatNumber(data.messages.total), icon: "messages", delta: compareWithPrevious(data.messages.total, data.previous.messagesTotal, false, prevLabel, true) },
  ];
  add(
    "Visão geral",
    "Indicadores do período",
    `<div class="grid g3">${kpis
      .map(
        (k) =>
          `<div class="card kpi${k.alert ? " alert" : ""}"><div class="kh">${icon(k.icon, k.alert ? AMBER : brand)}<span>${esc(k.label)}</span></div><p class="big">${esc(k.value)}</p><p class="kd">${
            k.hint ? `<span class="${k.alert ? "warn" : "muted"}">${esc(k.hint)}</span>` : delta(k.delta ?? null)
          }</p></div>`
      )
      .join("")}</div>`
  );

  // 4. Volume
  add(
    "Atendimento",
    "Volume do período",
    `<div class="grid g2">
      <div class="card"><h3>Conversas por status</h3>${distribution(
        [
          { label: "Aguardando (agora)", value: data.conversations.waiting, color: AMBER },
          { label: "Em atendimento", value: data.conversations.inProgress, color: brand },
          { label: "Encerradas", value: data.conversations.closed, color: SLATE },
        ],
        kinds.conversationsByStatus,
        "conversas"
      )}</div>
      <div class="card"><h3>Mensagens recebidas x enviadas</h3>${distribution(
        [
          { label: "Recebidas", value: data.messages.received, color: brand },
          { label: "Enviadas", value: data.messages.sent, color: deep },
        ],
        kinds.messagesReceivedSent,
        "mensagens"
      )}</div>
    </div>`
  );

  // 5. Jornada
  const t = data.timings;
  if (Object.values(t).some((ms) => ms !== null)) {
    const time = (ms: number | null) => (ms === null ? `<span class="nodata">sem dados</span>` : `<b class="acc">${esc(formatMinutes(ms))}</b>`);
    const firstDelta = compareWithPrevious(t.avgFirstResponseMs, data.previous.avgFirstResponseMs, true, prevLabel);
    add(
      "Atendimento",
      "Tempos médios da jornada do cliente",
      `<div class="card journey">
        <ol class="stops">
          <li>${icon("inbox", deep)}<span>Entrou na fila</span></li>
          <li class="seg"><p>${time(t.avgAcceptMs)}</p><small>esperando na fila até o aceite</small></li>
          <li>${icon("headset")}<span>Aceita por um atendente</span></li>
          <li class="seg"><p>${time(t.avgFirstResponseMs)}</p><small>do aceite até a 1ª resposta</small>${firstDelta ? `<small>${delta(firstDelta)}</small>` : ""}</li>
          <li>${icon("messages")}<span>1ª resposta enviada</span></li>
          <li class="seg"><small class="muted"><i>a conversa segue até ser resolvida</i></small></li>
          <li>${icon("flag", deep)}<span>Conversa encerrada</span></li>
        </ol>
        <div class="spans">
          <p><span class="sp" style="border-color:${brand}">${time(t.avgHandlingMs)} de atendimento</span> <small class="muted">aceite → encerramento</small></p>
          <p><span class="sp" style="border-color:${deep}">${time(t.avgClosingMs)} do início ao fim</span> <small class="muted">fila → encerramento</small></p>
        </div>
      </div>`
    );
  }

  // 6. Satisfação
  const sat = input.satisfaction;
  const nps = sat && sat.totals.answered > 0 && sat.totals.nps !== null ? { ...sat.totals, nps: sat.totals.nps } : null;
  const report = input.satisfactionReport;
  if (nps && sat) {
    const zone = npsZone(nps.nps);
    const zoneColor = npsColor(nps.nps);
    const d = npsDelta(nps.nps, sat.previous.nps);
    const goal = sat.settings.npsGoal;
    const only = (from: number, to: number) => nps.distribution.map((v, i) => (i >= from && i <= to ? v : 0));
    add(
      "Satisfação",
      "Como os clientes avaliam o atendimento",
      `<div class="grid g12">
        <div class="card"><h3>NPS do período (0 a 100)</h3>
          <div class="npsrow"><p class="huge" style="color:${zoneColor}">${esc(formatNps(nps.nps))}</p><div>
            ${d ? `<p style="color:${d.tone === "up" ? GREEN : d.tone === "down" ? RED : SLATE}"><b>${esc(d.text)}</b></p><p class="muted">vs. ${esc(sat.previous.label ?? "período anterior")}</p>` : ""}
            ${goal !== null ? `<p style="color:${nps.nps >= goal ? GREEN : RED}"><b>Meta ${goal}: ${nps.nps >= goal ? "acima" : "abaixo"}</b></p>` : ""}
          </div></div>
          <p class="zone" style="color:${zoneColor};background:${zoneColor}1f">${esc(zone.label)}</p>
          <p><b>${formatNumber(nps.answered)} ${nps.answered === 1 ? "resposta" : "respostas"}</b><br><span class="muted">de ${formatNumber(nps.sent)} ${nps.sent === 1 ? "pesquisa enviada" : "pesquisas enviadas"}${nps.sent ? ` · ${percentOf(nps.answered, nps.sent)}% de resposta` : ""}</span></p>
          ${sat.currentQuestion ? `<p class="q">${whatsappHtml(sat.currentQuestion)}</p>` : ""}
        </div>
        <div class="card"><h3>Notas de 0 a 10</h3>${cols(
          Array.from({ length: 11 }, (_, i) => String(i)),
          [
            { name: "Detratores (0–6)", color: RED, values: only(0, 6) },
            { name: "Neutros (7–8)", color: AMBER, values: only(7, 8) },
            { name: "Promotores (9–10)", color: GREEN, values: only(9, 10) },
          ],
          { stacked: true, whole: true }
        )}
          <div class="grid g3 groups">${[
            { label: "Promotores", range: "notas 9 e 10", count: nps.promoters, color: GREEN },
            { label: "Neutros", range: "notas 7 e 8", count: nps.passives, color: AMBER },
            { label: "Detratores", range: "notas de 0 a 6", count: nps.detractors, color: RED },
          ]
            .map((g) => `<div><p><i class="dot" style="background:${g.color}"></i><b>${g.label}</b></p><p><b class="mid" style="color:${g.color}">${percentOf(g.count, nps.answered)}%</b> <span class="muted">${formatNumber(g.count)} · ${g.range}</span></p></div>`)
            .join("")}</div>
        </div>
      </div>`
    );

    const byAgent = sat.byAgent ?? report?.byAgent ?? null;
    const customerMode = sat.settings.presentationCustomer ?? "full";
    const average = (v: number | null) => (v === null ? "-" : v.toLocaleString("pt-BR", { minimumFractionDigits: 1, maximumFractionDigits: 1 }));
    if (byAgent) {
      const agents = byAgent.filter((a) => a.sent > 0);
      if (agents.length > 0) {
        const small = agents.some((a) => a.answered > 0 && a.answered < NPS_SMALL_SAMPLE);
        add(
          "Satisfação",
          "Satisfação por atendente",
          `<div class="card">${table(
            ["Atendente", "Pesquisas", "Respostas", "Taxa", "Nota média", "NPS (0–100)", "Variação", "Promotores", "Neutros", "Detratores"],
            agents.map((a) => ({
              cells: [
                [a.answered > 0 && a.answered < NPS_SMALL_SAMPLE ? `${a.agentName} *` : a.agentName, a.agentName],
                [formatNumber(a.sent), a.sent],
                [formatNumber(a.answered), a.answered],
                [a.responseRate === null ? "-" : `${a.responseRate}%`, a.responseRate ?? -1],
                [average(a.average), a.average ?? -1],
                [a.nps === null ? "-" : formatNps(a.nps), a.nps ?? -1],
                [npsDelta(a.nps, a.previousNps)?.text ?? "-", a.nps !== null && a.previousNps !== null ? a.nps - a.previousNps : -999],
                [formatNumber(a.promoters), a.promoters],
                [formatNumber(a.passives), a.passives],
                [formatNumber(a.detractors), a.detractors],
              ],
            })),
            { colored: (r, c) => (c === 5 ? npsColor(agents[r].nps) : null) }
          )}${small ? `<p class="foot">* Amostra pequena: menos de ${NPS_SMALL_SAMPLE} respostas — uma nota só muda muito o NPS.</p>` : ""}</div>`
        );
      }
    }

    if (report && report.trend.length >= 2) {
      add(
        "Satisfação",
        "Evolução da satisfação no período",
        `<div class="card">${cols(
          report.trend.map((p) => p.label),
          [{ name: "NPS", color: brand, values: report.trend.map((p) => p.nps ?? 0) }],
          { kind: "line", max: 100, reference: goal !== null ? { label: `Meta ${goal}`, value: goal, color: GREEN } : undefined }
        )}</div>`
      );
    }

    if (report && report.byConnection.length > 1) {
      add(
        "Satisfação",
        "Satisfação por conexão",
        `<div class="card">${table(
          ["Conexão", "Pesquisas", "Respostas", "Taxa", "Nota média", "NPS (0–100)", "Promotores", "Neutros", "Detratores"],
          report.byConnection.map((c) => ({
            cells: [
              [c.connectionName, c.connectionName],
              [formatNumber(c.sent), c.sent],
              [formatNumber(c.answered), c.answered],
              [c.responseRate === null ? "-" : `${c.responseRate}%`, c.responseRate ?? -1],
              [average(c.average), c.average ?? -1],
              [c.nps === null ? "-" : formatNps(c.nps), c.nps ?? -1],
              [formatNumber(c.promoters), c.promoters],
              [formatNumber(c.passives), c.passives],
              [formatNumber(c.detractors), c.detractors],
            ],
          })),
          { colored: (r, c) => (c === 5 ? npsColor(report.byConnection[r].nps) : null) }
        )}</div>`
      );
    }

    const surveyTotals = report?.totals ?? sat.totals;
    if (surveyTotals.sent > 0) {
      const agents = [...(report?.byAgent ?? sat.byAgent ?? [])].filter((a) => a.sent > 0).sort((a, b) => b.unanswered - a.unanswered || b.sent - a.sent).slice(0, MAX_AGENTS_IN_CHART);
      const survey = [
        { name: "Responderam", color: GREEN, values: agents.map((a) => a.answered) },
        { name: "Não responderam", color: RED, values: agents.map((a) => a.unanswered) },
      ];
      add(
        "Satisfação",
        "Quem não respondeu a pesquisa",
        `<div class="grid g12">
          <div class="card"><h3>Pesquisas enviadas</h3>${distribution(
            [
              { label: "Responderam", value: surveyTotals.answered, color: GREEN },
              { label: "Não responderam", value: surveyTotals.unanswered, color: RED },
              { label: "Ainda no prazo", value: surveyTotals.awaiting, color: SLATE },
            ],
            "donut",
            "enviadas"
          )}</div>
          <div class="card"><h3>Por atendente</h3>${
            agents.length === 0
              ? `<p class="empty">Sem o detalhe por atendente neste período.</p>`
              : !kinds.surveyByAgent || kinds.surveyByAgent === "bar"
                ? hbars(agents.map((a) => a.agentName), survey, { stacked: true })
                : cols(agents.map((a) => a.agentName), survey, { kind: kinds.surveyByAgent, stacked: true, whole: true })
          }</div>
        </div>`
      );
    }

    const groups = [
      { key: "detractor", title: "Detratores", range: "notas 0 a 6", color: RED },
      { key: "passive", title: "Neutros", range: "notas 7 e 8", color: AMBER },
      { key: "promoter", title: "Promotores", range: "notas 9 e 10", color: GREEN },
    ] as const;
    const latestOf = (category: SatisfactionResponseDTO["category"]) =>
      sat.latest?.[category!] ??
      (report?.responses ?? [])
        .filter((r) => r.category === category)
        .sort((x, y) => (y.answeredAt ?? "").localeCompare(x.answeredAt ?? ""))
        .slice(0, 5);
    const latest = groups.map((g) => ({ ...g, items: latestOf(g.key) }));
    if (latest.some((g) => g.items.length > 0)) {
      const shiftMs = (input.clockShiftMinutes ?? 0) * 60_000;
      const when = (iso: string | null) => (iso ? new Date(Date.parse(iso) - shiftMs).toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }) : "-");
      add(
        "Satisfação",
        "Últimas avaliações de cada grupo",
        `<div class="grid g3">${latest
          .map(
            (g) =>
              `<div class="card ev" style="border-top:5px solid ${g.color}"><h3>${g.title} <small class="muted">${g.range}</small></h3>${
                g.items.length === 0
                  ? `<p class="empty">Nenhuma no período</p>`
                  : g.items
                      .map((r) => {
                        const head = `<span class="sc" style="color:${g.color};background:${g.color}22">${r.score}</span><span><b>${esc(customerLabel(r, customerMode))}</b><small class="muted">${esc(r.agentName ?? "-")} · ${esc(when(r.answeredAt))}</small></span>`;
                        return r.reasonText
                          ? `<details><summary>${head}<em class="why">motivo</em></summary><p class="reason">“${esc(r.reasonText)}”</p></details>`
                          : `<div class="row">${head}</div>`;
                      })
                      .join("")
              }</div>`
          )
          .join("")}</div>`
      );
    }
  }

  // 7-9. Equipe
  const ranked = [...data.perAgent].sort((a, b) => b.conversations - a.conversations || a.agentName.localeCompare(b.agentName));
  if (ranked.length > 0) {
    const shown = ranked.slice(0, MAX_AGENTS_IN_CHART);
    const left = ranked.length - shown.length;
    const total = ranked.reduce((sum, a) => sum + a.conversations, 0);
    const conversations = [{ name: "Conversas", color: brand, values: shown.map((a) => a.conversations) }];
    add(
      "Equipe",
      "Conversas por atendente",
      `<div class="card">${
        !kinds.conversationsByAgent || kinds.conversationsByAgent === "bar"
          ? hbars(shown.map((a) => a.agentName), conversations)
          : cols(shown.map((a) => a.agentName), conversations, { kind: kinds.conversationsByAgent, whole: true })
      }${left > 0 ? `<p class="foot">E mais ${left} ${left === 1 ? "atendente" : "atendentes"} — todos estão na tabela de desempenho.</p>` : ""}</div>`
    );
    add(
      "Equipe",
      "Mensagens enviadas e recebidas por atendente",
      `<div class="card">${cols(
        shown.map((a) => a.agentName),
        [
          { name: "Enviadas", color: deep, values: shown.map((a) => a.messagesSent) },
          { name: "Recebidas", color: mid, values: shown.map((a) => a.messagesReceived) },
        ],
        { kind: kinds.messagesByAgent ?? "bar", whole: true, showValues: shown.length <= 8 }
      )}</div>`
    );
    const online = new Map((input.team?.agents ?? []).map((a) => [a.agentId, a.onlineMs]));
    const withOnline = online.size > 0;
    add(
      "Equipe",
      "Desempenho por atendente",
      `<div class="card">${table(
        ["Atendente", "Conversas", "% da equipe", "Mensagens enviadas", "Mensagens recebidas", "Atendimento (média)", ...(withOnline ? ["Tempo online"] : [])],
        ranked.map((a) => ({
          cells: [
            [a.agentName, a.agentName],
            [formatNumber(a.conversations), a.conversations],
            [`${percentOf(a.conversations, total)}%`, a.conversations],
            [formatNumber(a.messagesSent), a.messagesSent],
            [formatNumber(a.messagesReceived), a.messagesReceived],
            [formatMinutes(a.avgHandlingMs), a.avgHandlingMs ?? -1],
            ...(withOnline ? ([[online.has(a.agentId) ? formatMinutes(online.get(a.agentId)!) : "-", online.get(a.agentId) ?? -1]] as [string, number][]) : []),
          ],
        }))
      )}<p class="foot">Clique no nome de uma coluna para ordenar.</p></div>`
    );
  }

  // 10. Presença
  const isToday = input.period.period === "today";
  const currentHour = input.now.getHours();
  if (input.presenceByHour && input.presenceByHour.series.length > 0) {
    const range = input.presenceHourRange;
    const points = input.presenceByHour.hours.filter((p) => (!range || (p.hour >= range.start && p.hour <= range.end)) && (!isToday || p.hour <= currentHour));
    if (points.length > 0) {
      const colors = [brand, AMBER, deep, SLATE, mid, "#A855F7", "#0EA5E9", "#84CC16"];
      const snapshot = isToday && input.team ? input.team.now : null;
      add(
        "Equipe",
        "Equipe ao longo do dia",
        `${
          snapshot
            ? `<div class="pills">${[
                { label: "online agora", value: snapshot.online, color: GREEN },
                { label: "em pausa", value: snapshot.paused, color: AMBER },
                { label: "offline", value: snapshot.offline, color: SLATE },
              ]
                .map((p) => `<span class="card pill"><i class="dot" style="background:${p.color}"></i><b>${p.value}</b> ${p.label}</span>`)
                .join("")}</div>`
            : ""
        }<div class="card">${cols(
          points.map((p) => `${String(p.hour).padStart(2, "0")}h`),
          input.presenceByHour.series.map((key, i) => ({ name: key, color: colors[i % colors.length], values: points.map((p) => p.counts[key] ?? 0) })),
          { kind: kinds.presenceByHour ?? "bar", stacked: true, whole: true }
        )}</div>`
      );
    }
  }

  // 10b. Chegadas
  if (input.arrivalsByHour) {
    const summary = arrivalsSummary(input.arrivalsByHour);
    const range = input.arrivalsHourRange;
    const points = input.arrivalsByHour.hours.filter((p) => (!range || (p.hour >= range.start && p.hour <= range.end)) && (!isToday || p.hour <= currentHour));
    if (summary.total > 0 && points.length > 0) {
      add(
        "Equipe",
        "Quando as conversas chegam",
        `<div class="pills">${[
          { label: "horário de pico", value: summary.peakHour !== null ? `${String(summary.peakHour).padStart(2, "0")}h` : "—" },
          { label: "conversas no período", value: formatNumber(summary.total) },
          { label: "fora do expediente", value: `${summary.outsideShare}%` },
        ]
          .map((f) => `<span class="card pill"><b>${esc(f.value)}</b> ${f.label}</span>`)
          .join("")}</div><div class="card">${cols(
          points.map((p) => `${String(p.hour).padStart(2, "0")}h`),
          [
            { name: "Dentro do expediente", color: brand, values: points.map((p) => p.inside) },
            { name: "Fora do expediente", color: AMBER, values: points.map((p) => p.outside) },
          ],
          { kind: kinds.arrivalsByHour ?? "bar", stacked: true, whole: true, secondary: { name: "Atendentes online (média)", color: SLATE, values: points.map((p) => p.onlineAvg) } }
        )}</div>`
      );
    }
  }

  // 11. Palavras
  const words = [...input.wordCloud].sort((a, b) => b.count - a.count).slice(0, MAX_WORDS);
  if (words.length > 0) {
    add(
      "Clientes",
      "O que os clientes mais falam",
      `<div class="grid g21"><div class="card">${hbars(
        words.map((w) => w.word),
        [{ name: "Menções", color: brand, values: words.map((w) => w.count) }]
      )}</div><div class="card soft"><h3>As três mais citadas</h3><ol class="top3">${words
        .slice(0, 3)
        .map((w, i) => `<li><span style="color:${brand}">${i + 1}</span><p><b>${esc(w.word)}</b><small class="muted">${formatNumber(w.count)} ${w.count === 1 ? "menção" : "menções"}</small></p></li>`)
        .join("")}</ol><p class="foot">Palavras das mensagens dos clientes no período, sem artigos, preposições e outras palavras comuns.</p></div></div>`
    );
  }

  // 11b. Bloqueadas
  const blocks = input.autoMessageBlocks;
  if (blocks && blocks.total > 0) {
    add(
      "Mensagens automáticas",
      "Mensagens bloqueadas pelas etiquetas",
      `<div class="grid g21"><div class="card"><h3>${formatNumber(blocks.total)} ${blocks.total === 1 ? "mensagem não enviada" : "mensagens não enviadas"}</h3>${hbars(
        blocks.byKind.map((k) => AUTO_MESSAGE_KIND_LABEL[k.kind] ?? k.kind),
        [{ name: "Bloqueadas", color: brand, values: blocks.byKind.map((k) => k.count) }]
      )}</div><div class="card"><h3>Etiquetas que mais bloquearam</h3><ul class="kv">${blocks.byTag
        .slice(0, 8)
        .map((t) => `<li><span>${esc(t.tagName)}</span><b style="color:var(--accent)">${formatNumber(t.count)}</b></li>`)
        .join("")}</ul></div></div>`
    );
  }

  // 11c. Comunicados
  const notices = input.announcements;
  if (notices && notices.published > 0) {
    const pct = (v: number | null) => (v === null ? "-" : `${v}%`);
    const share = (part: number, whole: number) => (whole ? Math.round((part / whole) * 100) : 0);
    const items = notices.items.slice(0, 6);
    const owing = notices.items.filter((it) => it.requireAck && it.pendingNames.length > 0);
    add(
      "Comunicados",
      "Os avisos chegaram à equipe?",
      `<div class="pills">${[
        { label: notices.published === 1 ? "aviso no período" : "avisos no período", value: formatNumber(notices.published), color: brand },
        { label: "leram", value: pct(notices.readRate), color: GREEN },
        { label: "confirmaram o ciente", value: pct(notices.ackRate), color: notices.ackRate !== null && notices.ackRate < 80 ? AMBER : GREEN },
      ]
        .map((f) => `<span class="card pill"><b style="color:${f.color}">${esc(f.value)}</b> ${f.label}</span>`)
        .join("")}</div>
      <div class="grid g21"><div class="card"><h3>Leitura e ciente por aviso</h3>${hbars(
        items.map((it) => it.title),
        [
          { name: "Leram", color: brand, values: items.map((it) => share(it.read, it.audience)) },
          { name: "Ciente", color: GREEN, values: items.map((it) => (it.requireAck ? share(it.acked, it.audience) : 0)) },
        ],
        { suffix: "%" }
      )}</div><div class="card soft"><h3>Aguardando o ciente</h3>${
        owing.length === 0
          ? `<p>${notices.items.some((it) => it.requireAck) ? "Todos confirmaram os avisos que pediam ciente." : "Nenhum aviso do período pedia confirmação."}</p>`
          : owing
              .map(
                (it) =>
                  `<details><summary><b>${esc(it.title)}</b> <small class="muted">${it.pendingNames.length} de ${it.audience} · ${esc(ANNOUNCEMENT_KIND_LABEL[it.kind])}</small></summary><p>${esc(it.pendingNames.join(", "))}</p></details>`
              )
              .join("")
      }</div></div>`
    );
  }

  // 12. Glossário
  const terms: [string, string][] = [
    ["Conversas recebidas", "Conversas que começaram no período, em todas as conexões e atendentes do filtro."],
    ["Atendimentos únicos", "Clientes diferentes atendidos: o mesmo cliente em duas conversas conta uma vez."],
    ["Na fila", "Conversas esperando um atendente no momento em que o relatório foi gerado."],
    ["Aceite", "Tempo médio da entrada na fila até um atendente aceitar a conversa."],
    ["1ª resposta", "Tempo médio do aceite até o atendente escrever — a mensagem automática de aceite não conta."],
    ["Atendimento", "Tempo médio do aceite até o encerramento da conversa."],
    ["NPS (0 a 100)", "Promotores (9–10) e detratores (0–6) numa nota de 0 a 100: 0 todos detratores, 50 empate, 100 todos promotores."],
    [
      "Comparação",
      prevLabel === "período anterior"
        ? "Um período do mesmo tamanho logo antes deste — base das setas de comparação."
        : `Os cartões comparam com ${prevLabel}, conforme o Horário de expediente e os Feriados.`,
    ],
  ];
  add("Apêndice", "Como ler os indicadores", `<div class="grid g2">${terms.map(([term, meaning]) => `<div class="card"><h3 style="color:var(--accent)">${esc(term)}</h3><p>${esc(meaning)}</p></div>`).join("")}</div>`);

  // 13. Encerramento
  slides.push({
    section: "Apêndice",
    title: "Encerramento",
    kind: "closing",
    body: `${input.logo ? `<div class="logo-badge"><img src="${input.logo.data}" alt="Logo ${esc(input.companyName)}"></div>` : ""}<h1>Obrigado</h1><p class="period">${esc(input.companyName)} · Relatório de atendimento · ${esc(periodLine)}</p><p class="gen">Dados do Dashboard do WhatsAtendende, gerados em ${esc(generatedAt)}</p>`,
  });

  const options = slides.map((s, i) => `<option value="${i}">${i + 1}. ${esc(s.kind ? s.title : `${s.section} — ${s.title}`)}</option>`).join("");
  const sections = slides
    .map((s, i) =>
      s.kind
        ? `<section class="slide ${s.kind}" id="s${i + 1}" aria-label="${esc(s.title)}"><div class="inner">${s.body}<p class="credit">${SAUBERLICH_CREDIT}</p></div></section>`
        : `<section class="slide" id="s${i + 1}" aria-label="${esc(s.title)}"><div class="inner"><p class="kicker">${esc(s.section)}</p><h2>${esc(s.title)}</h2>${s.body}</div><footer>${esc(input.companyName)} · Relatório de atendimento · ${esc(periodLine)} · ${SAUBERLICH_CREDIT}<span>${i + 1} / ${slides.length}</span></footer></section>`
    )
    .join("");

  return `<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>${esc(`Relatório de atendimento — ${input.companyName} — ${periodLine}`)}</title>
<style>${css(brand, deep, dark, mid, soft)}</style>
</head>
<body>
<header class="bar">
  <span class="ttl">${input.logo ? `<img src="${input.logo.data}" alt="">` : ""}<span>${esc(input.companyName)} · ${esc(periodLine)}</span></span>
  <nav>
    <select id="idx" aria-label="Ir para o slide">${options}</select>
    <button type="button" id="prev" aria-label="Slide anterior">‹</button>
    <span id="count"></span>
    <button type="button" id="next" aria-label="Próximo slide">›</button>
    <button type="button" id="mode" title="Alternar entre apresentar e rolar a página">Rolar</button>
    <button type="button" id="full" title="Tela cheia (F)">⛶</button>
  </nav>
</header>
<main>${sections}</main>
<div id="tip" role="tooltip"></div>
<script>${SCRIPT}</script>
</body>
</html>`;
}

function css(brand: string, deep: string, dark: string, mid: string, soft: string): string {
  const off = Array.from({ length: 10 }, (_, i) => `.chart.off${i} [data-s="${i}"]{visibility:hidden}.chart.off${i} .lg [data-s="${i}"]{visibility:visible;opacity:.45}`).join("");
  return `
:root{--brand:${brand};--deep:${deep};--accent:${deep};--dark:${dark};--mid:${mid};--soft:${soft};--page:#F4F6F9;--card:#fff;--ink:#0F172A;--body:#334155;--muted:#64748B;--line:#E2E8F0;--alt:#F8FAFC}
@media (prefers-color-scheme:dark){:root{--page:#0B1220;--card:#111A2B;--ink:#F1F5F9;--body:#CBD5E1;--muted:#94A3B8;--line:#24324A;--alt:#162238;--soft:#16243A;--accent:${mid}}}
*{box-sizing:border-box}html{scroll-behavior:smooth}
body{margin:0;background:var(--page);color:var(--body);font:15px/1.45 Calibri,"Segoe UI",system-ui,-apple-system,Roboto,Arial,sans-serif;-webkit-text-size-adjust:100%}
.bar{position:sticky;top:0;z-index:20;display:flex;align-items:center;justify-content:space-between;gap:12px;padding:8px 16px;background:var(--card);border-bottom:1px solid var(--line)}
.ttl{display:flex;align-items:center;gap:10px;min-width:0;font-weight:700;color:var(--ink);font-size:14px}.ttl img{height:26px;max-width:110px;object-fit:contain}.ttl span{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
nav{display:flex;align-items:center;gap:6px;flex-shrink:0}nav button,nav select{font:inherit;font-size:13px;border:1px solid var(--line);background:var(--card);color:var(--ink);border-radius:8px;padding:5px 10px;cursor:pointer}nav select{max-width:220px}#count{font-size:13px;color:var(--muted);min-width:52px;text-align:center}
.slide{position:relative;padding:22px 16px 18px;border-bottom:1px solid var(--line);scroll-margin-top:60px}
.inner{max-width:1180px;margin:0 auto}
.kicker{margin:0;color:var(--brand);font-weight:700;letter-spacing:.14em;text-transform:uppercase;font-size:12px}
h2{margin:2px 0 16px;color:var(--ink);font-size:clamp(22px,3vw,32px);line-height:1.15}h3{margin:0 0 12px;color:var(--ink);font-size:17px}
.credit{color:#94A3B8;font-size:12px;margin:28px 0 0}footer{max-width:1180px;margin:18px auto 0;display:flex;justify-content:space-between;gap:12px;color:var(--muted);font-size:12px}footer span{white-space:nowrap}
.grid{display:grid;gap:16px}.g2{grid-template-columns:repeat(auto-fit,minmax(min(100%,420px),1fr))}.g3{grid-template-columns:repeat(auto-fit,minmax(min(100%,340px),1fr))}.g12{grid-template-columns:minmax(0,1fr) minmax(0,2fr)}.g21{grid-template-columns:minmax(0,2fr) minmax(0,1fr)}
@media (max-width:899px){.g12,.g21{grid-template-columns:1fr}}
.card{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:18px;box-shadow:0 2px 10px rgba(15,23,42,.06);min-width:0}.card.soft{background:var(--soft);border-color:transparent}
.muted{color:var(--muted)}.warn{color:#B45309;font-weight:700}.empty{color:var(--muted);font-style:italic;text-align:center;padding:24px 0}.foot{margin:10px 0 0;color:var(--muted);font-size:12.5px;font-style:italic}
.ic{display:inline-flex;align-items:center;justify-content:center;width:44px;height:44px;border-radius:50%;flex-shrink:0}.ic img{width:24px;height:24px}
.hl{display:flex;gap:16px;align-items:flex-start}.hl p{margin:0}.big{font-size:clamp(30px,4vw,42px);font-weight:700;color:var(--ink);line-height:1.1;margin:8px 0}.hl .t{font-weight:700;color:var(--ink);font-size:17px;margin:2px 0 4px}
.kpi .kh{display:flex;align-items:center;gap:12px;font-weight:700;color:var(--body)}.kpi.alert{background:#FFFBEB;border-color:#FCD34D;color:#334155}.kpi.alert .big{color:#0F172A}.acc{color:var(--accent)}.kd{margin:0;font-size:14px}
.dist{display:flex;flex-wrap:wrap;align-items:center;gap:18px}.dist .chart{flex:1 1 260px}.donut{width:min(220px,60vw);flex-shrink:0}.dc-n{font-size:24px;font-weight:700;fill:var(--ink)}.dc-u{font-size:12px;fill:var(--muted)}
.dl{list-style:none;margin:0;padding:0;flex:1 1 180px}.dl li{display:grid;grid-template-columns:14px 1fr auto auto;gap:8px;align-items:center;padding:7px 0;border-bottom:1px solid var(--line)}.dl i,.lg i,.dot{display:inline-block;width:11px;height:11px;border-radius:50%}.dl b{color:var(--ink)}.dl small{color:var(--muted);min-width:38px;text-align:right}
.lg{display:flex;flex-wrap:wrap;gap:6px;margin-bottom:10px}.lg button{display:inline-flex;align-items:center;gap:6px;font:inherit;font-size:12.5px;color:var(--body);background:transparent;border:1px solid var(--line);border-radius:99px;padding:3px 10px;cursor:pointer}
.hb{display:flex;flex-direction:column;gap:9px}.hb-r{display:grid;grid-template-columns:minmax(80px,30%) 1fr auto;gap:10px;align-items:center}.hb-l{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--ink);font-size:14px}
.hb-t{display:flex;align-items:center;gap:6px;height:22px}.hb-t span{display:block;height:100%;border-radius:4px;min-width:2px;cursor:pointer}.hb-g{display:flex;flex-direction:column;gap:3px}.hb-g .hb-t{height:14px}.hb-r>em,.hb-t em{font-style:normal;font-weight:700;color:var(--ink);font-size:13px}
.scroll{overflow-x:auto}.cols{width:100%;height:auto;display:block}.cols.narrow{display:none}@media (max-width:640px){.cols.wide{display:none}.cols.narrow{display:block}}.cols .grid{stroke:var(--line);stroke-dasharray:3 4}.cols .ax{font-size:12px;fill:var(--muted)}.cols .val{font-size:11px;fill:var(--ink);font-weight:700}.cols [data-tip]{cursor:pointer}
${off}
.journey .stops{list-style:none;margin:6px 0 18px;padding:0;display:grid;grid-template-columns:auto 1fr auto 1fr auto 1fr auto;align-items:start;gap:8px}.stops>li{display:flex;flex-direction:column;align-items:center;text-align:center;gap:6px;font-weight:700;color:var(--ink);font-size:13.5px}.stops .seg{border-top:3px solid var(--mid);padding-top:8px;margin-top:20px;font-weight:400}.stops .seg p{margin:0;font-size:22px}.stops small{color:var(--muted)}.nodata{color:var(--muted);font-style:italic;font-size:16px}
@media (max-width:899px){.journey .stops{grid-template-columns:1fr}.stops .seg{border-top:0;border-left:3px solid var(--mid);margin:0 0 0 21px;padding:4px 0 4px 14px;align-items:flex-start;text-align:left}}
.spans p{margin:8px 0}.sp{display:inline-block;border:2px solid;border-radius:99px;padding:3px 12px;color:var(--ink)}
.npsrow{display:flex;align-items:center;gap:18px}.npsrow p{margin:2px 0}.huge{font-size:clamp(56px,8vw,84px);font-weight:700;line-height:1}.zone{display:inline-block;border-radius:99px;padding:5px 14px;font-weight:700;margin:6px 0 12px}.q{font-size:13px;color:var(--muted);border-left:3px solid var(--line);padding-left:10px}.groups{margin-top:12px}.groups p{margin:2px 0}.mid{font-size:22px}
.tw{overflow-x:auto}.st{width:100%;border-collapse:collapse;font-size:14px}.st th{background:var(--deep);color:#fff;text-align:right;padding:9px 10px;cursor:pointer;white-space:nowrap;user-select:none}.st th.l,.st td.l{text-align:left}.st th[aria-sort]::after{content:" ▾"}.st th[aria-sort=ascending]::after{content:" ▴"}.st td{text-align:right;padding:8px 10px;border-bottom:1px solid var(--line);white-space:nowrap}.st td.l{color:var(--ink);font-weight:700}.st tbody tr:nth-child(even){background:var(--alt)}
.ev details,.ev .row{border-bottom:1px solid var(--line)}.ev summary,.ev .row{display:flex;align-items:center;gap:10px;padding:9px 2px;list-style:none;cursor:default}.ev summary{cursor:pointer}.ev summary::-webkit-details-marker{display:none}.ev summary>span:nth-child(2),.ev .row>span:nth-child(2){display:flex;flex-direction:column;min-width:0;flex:1}.ev small{font-size:12px}
.sc{display:inline-flex;align-items:center;justify-content:center;width:34px;height:34px;border-radius:50%;font-weight:700;flex-shrink:0}.why{font-style:normal;font-size:12px;color:var(--brand);border:1px solid currentColor;border-radius:99px;padding:1px 8px}.reason{margin:0 0 10px 44px;font-style:italic;color:var(--ink)}
.pills{display:flex;flex-wrap:wrap;gap:10px;margin-bottom:14px}.pill{padding:10px 16px;display:inline-flex;align-items:center;gap:8px}.pill b{font-size:20px;color:var(--ink)}
.top3{list-style:none;margin:0;padding:0}.top3 li{display:flex;gap:14px;align-items:center;margin:10px 0}.top3 li>span{font-size:34px;font-weight:700;width:30px}.top3 p{margin:0;display:flex;flex-direction:column}.top3 b{font-size:20px;color:var(--ink)}
.kv{list-style:none;margin:0;padding:0}.kv li{display:flex;justify-content:space-between;padding:8px 0;border-bottom:1px solid var(--line)}
.cover,.closing{background:var(--dark);color:#fff;overflow:hidden}.cover .inner,.closing .inner{position:relative;z-index:1;padding:32px 0}.cover::before,.closing::before{content:"";position:absolute;width:520px;height:520px;border-radius:50%;background:var(--brand);opacity:.28;right:-140px;top:-160px}.cover::after{content:"";position:absolute;width:300px;height:300px;border-radius:50%;background:var(--brand);opacity:.16;right:40px;bottom:-120px}
.logo-badge{display:inline-block;background:#fff;border-radius:12px;padding:12px 18px;margin-bottom:28px}.logo-badge img{height:56px;max-width:220px;object-fit:contain;display:block}
.cover .eyebrow{color:var(--mid);letter-spacing:.2em;font-weight:700;text-transform:uppercase;margin:0}.cover h1,.closing h1{font-size:clamp(34px,6vw,58px);margin:8px 0 10px;color:#fff;line-height:1.08}.period{font-size:clamp(17px,2.4vw,24px);color:#E2E8F0;margin:0 0 6px}.scope,.gen,.co{color:#CBD5E1;margin:4px 0}.gen{margin-top:40px;font-size:13px}.co{font-weight:700;font-size:22px;color:#fff}.closing{text-align:center}.closing .logo-badge{margin-top:10px}
#tip{position:fixed;z-index:50;pointer-events:none;background:#0F172A;color:#fff;font-size:13px;padding:6px 10px;border-radius:8px;box-shadow:0 6px 18px rgba(0,0,0,.25);opacity:0;transition:opacity .1s;max-width:280px}#tip.on{opacity:1}
body.deck main{height:calc(100vh - 51px);overflow:hidden}body.deck .slide{display:none;height:100%;overflow:auto;padding:28px 40px 16px;border:0;flex-direction:column}body.deck .slide.on{display:flex}body.deck .slide>.inner{width:100%;flex:1}body.deck .cover,body.deck .closing{overflow:hidden}body.deck .cover>.inner,body.deck .closing>.inner{display:flex;flex-direction:column;justify-content:center}body.deck footer{width:100%}
body:not(.deck) #prev,body:not(.deck) #next,body:not(.deck) #count{display:none}
@media (max-width:640px){.slide{scroll-margin-top:96px}.bar{flex-wrap:wrap}.ttl{width:100%}nav{width:100%}nav select{flex:1;max-width:none}#mode,#full{display:none}.slide{padding:18px 14px}.card{padding:14px}.hb-r{grid-template-columns:minmax(70px,34%) 1fr auto}}
@media print{.bar,#tip{display:none}body.deck main{height:auto;overflow:visible}.slide,body.deck .slide{display:block!important;height:auto;page-break-after:always;break-after:page;border:0}.cover,.closing{-webkit-print-color-adjust:exact;print-color-adjust:exact}}
`;
}

// The page's behaviour: slides on a wide screen (keys, buttons, swipe, index, full screen), scrolling on a narrow
// one; tooltips; legends that turn series off; tables that sort. Plain script — the page needs nothing else.
const SCRIPT = `(function(){
var d=document,b=d.body,slides=[].slice.call(d.querySelectorAll('.slide')),i=0,wide=matchMedia('(min-width: 900px)'),forced=null;
var idx=d.getElementById('idx'),count=d.getElementById('count'),modeBtn=d.getElementById('mode');
function deck(){return forced===null?wide.matches:forced}
function show(n,scroll){i=Math.max(0,Math.min(slides.length-1,n));slides.forEach(function(s,k){s.classList.toggle('on',k===i)});count.textContent=(i+1)+' / '+slides.length;idx.value=String(i);if(history.replaceState)history.replaceState(null,'','#s'+(i+1));if(!deck()&&scroll)slides[i].scrollIntoView({behavior:'smooth'})}
function mode(){b.classList.toggle('deck',deck());modeBtn.textContent=deck()?'Rolar':'Apresentar';if(deck())show(i);else if(i>0)slides[i].scrollIntoView()}
var h=/^#s(\\d+)$/.exec(location.hash);if(h)i=Number(h[1])-1;
wide.addEventListener?wide.addEventListener('change',mode):wide.addListener(mode);mode();show(i,i>0);
d.getElementById('prev').onclick=function(){show(i-1)};d.getElementById('next').onclick=function(){show(i+1)};
idx.onchange=function(){show(Number(idx.value),true)};
modeBtn.onclick=function(){forced=!deck();mode()};
function full(){if(d.fullscreenElement)d.exitFullscreen();else if(d.documentElement.requestFullscreen)d.documentElement.requestFullscreen()}
d.getElementById('full').onclick=full;
d.addEventListener('keydown',function(e){if(e.target.tagName==='SELECT'||e.altKey||e.ctrlKey||e.metaKey)return;var k=e.key;
if(k==='f'||k==='F'){full();return}if(!deck())return;
if(k==='ArrowRight'||k==='PageDown'||k===' '){e.preventDefault();show(i+1)}else if(k==='ArrowLeft'||k==='PageUp'){e.preventDefault();show(i-1)}else if(k==='Home')show(0);else if(k==='End')show(slides.length-1)});
var x0=null;d.addEventListener('touchstart',function(e){x0=e.touches[0].clientX},{passive:true});
d.addEventListener('touchend',function(e){if(x0===null||!deck())return;var dx=e.changedTouches[0].clientX-x0;if(Math.abs(dx)>60)show(i+(dx<0?1:-1));x0=null});
if(!deck()&&'IntersectionObserver' in window){var io=new IntersectionObserver(function(es){es.forEach(function(en){if(en.isIntersecting&&!deck()){var n=slides.indexOf(en.target);i=n;count.textContent=(n+1)+' / '+slides.length;idx.value=String(n)}})},{threshold:.5});slides.forEach(function(s){io.observe(s)})}
var tip=d.getElementById('tip');
function place(x,y){var w=tip.offsetWidth,hh=tip.offsetHeight;tip.style.left=Math.max(8,Math.min(innerWidth-w-8,x+12))+'px';tip.style.top=Math.max(8,y-hh-12)+'px'}
d.addEventListener('mouseover',function(e){var t=e.target.closest&&e.target.closest('[data-tip]');if(!t)return;tip.textContent=t.getAttribute('data-tip');tip.classList.add('on');place(e.clientX,e.clientY)});
d.addEventListener('mousemove',function(e){if(tip.classList.contains('on'))place(e.clientX,e.clientY)});
d.addEventListener('mouseout',function(e){if(e.target.closest&&e.target.closest('[data-tip]'))tip.classList.remove('on')});
d.addEventListener('click',function(e){var t=e.target.closest&&e.target.closest('[data-tip]');if(t){var r=t.getBoundingClientRect();tip.textContent=t.getAttribute('data-tip');tip.classList.add('on');place(r.left+r.width/2,r.top);clearTimeout(tip._t);tip._t=setTimeout(function(){tip.classList.remove('on')},2500)}
var l=e.target.closest&&e.target.closest('.lg button');if(l){var c=l.closest('.chart'),s=l.getAttribute('data-s'),off=c.classList.toggle('off'+s);l.setAttribute('aria-pressed',String(!off))}
var th=e.target.closest&&e.target.closest('th[data-col]');if(th){var tb=th.closest('table'),body=tb.tBodies[0],col=Number(th.getAttribute('data-col')),asc=th.getAttribute('aria-sort')!=='ascending';
[].forEach.call(tb.querySelectorAll('th'),function(x){x.removeAttribute('aria-sort')});th.setAttribute('aria-sort',asc?'ascending':'descending');
var rows=[].slice.call(body.rows);rows.sort(function(a,b2){var va=a.cells[col].getAttribute('data-v'),vb=b2.cells[col].getAttribute('data-v'),na=Number(va),nb=Number(vb);var r=(!isNaN(na)&&!isNaN(nb)&&va!==''&&vb!=='')?na-nb:va.localeCompare(vb,'pt-BR');return asc?r:-r});rows.forEach(function(r){body.appendChild(r)})}});
})();`;
