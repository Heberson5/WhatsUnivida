import { describe, it, expect } from "vitest";
import PptxGen from "pptxgenjs";
import JSZip from "jszip";
import { buildDashboardPresentation, buildHighlights, fitBars, relativeChange, type DashboardSnapshot, type PresentationInput } from "./dashboardPresentation";

const NOW = new Date(2026, 9, 8, 17, 42);
const PIXEL = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

function agent(name: string, conversations: number, i: number) {
  return { agentId: `a${i}`, agentName: name, conversations, messagesSent: conversations * 6, messagesReceived: conversations * 5, avgHandlingMs: 40 * 60000 };
}

function snapshot(overrides: Partial<DashboardSnapshot> = {}): DashboardSnapshot {
  return {
    conversations: { received: 1284, unique: 1031, inProgress: 23, closed: 1240, closedNoReturn: 0, waiting: 4 },
    messages: { received: 6725, sent: 7306, total: 14031 },
    timings: { avgAcceptMs: 4 * 60000, avgFirstResponseMs: 3 * 60000, avgHandlingMs: 43 * 60000, avgClosingMs: 49 * 60000 },
    perAgent: [agent("Ana Souza", 312, 1), agent("Bruno Lima", 268, 2), agent("Carla Mendes", 231, 3)],
    users: { online: 6, active: 9, total: 11 },
    previous: { received: 1146, unique: 958, closed: 1107, messagesTotal: 13110, avgFirstResponseMs: 4 * 60000 },
    ...overrides,
  };
}

const SATISFACTION: PresentationInput["satisfaction"] = {
  totals: {
    sent: 1102,
    answered: 412,
    unanswered: 0,
    responseRate: 37,
    average: 8.7,
    nps: 81,
    promoters: 298,
    passives: 73,
    detractors: 41,
    distribution: [6, 2, 3, 4, 5, 9, 12, 24, 49, 98, 200],
    awaiting: 0,
  },
  previous: { from: "2026-09-01T03:00:00.000Z", to: "2026-10-01T02:59:59.000Z", nps: 75, average: 8.4, answered: 380, responseRate: 35 },
  currentQuestion: "*Pesquisa* 😊\nDe _0 a 10_, o quanto você recomendaria?",
  settings: { npsGoal: 80, presentationCustomer: "full" },
  byAgent: null,
  latest: null,
};

function input(overrides: Partial<PresentationInput> = {}): PresentationInput {
  return {
    companyName: "Empresa Demo",
    primaryColor: "#0097B4",
    logo: { data: PIXEL, width: 400, height: 100 },
    icons: { inbox: PIXEL, timer: PIXEL },
    period: { period: "month" },
    scopeLabel: "Todas as conexões · todos os atendentes",
    data: snapshot(),
    satisfaction: SATISFACTION,
    team: null,
    wordCloud: [
      { word: "boleto", count: 41 },
      { word: "entrega", count: 30 },
    ],
    presenceByHour: { series: ["Online", "Pausa: Almoço"], hours: [8, 9, 10].map((hour) => ({ hour, counts: { Online: 5, "Pausa: Almoço": hour === 9 ? 1 : 0 } })) },
    presenceHourRange: null,
    now: NOW,
    ...overrides,
  };
}

/** The deck as files: the text of each slide (in order), its notes, and the raw parts. */
async function open(presentation: PresentationInput) {
  const buffer = (await buildDashboardPresentation(PptxGen, presentation).write({ outputType: "arraybuffer" })) as ArrayBuffer;
  const zip = await JSZip.loadAsync(buffer);
  const slideNames = Object.keys(zip.files)
    .filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n))
    .sort((a, b) => Number(a.match(/\d+/)![0]) - Number(b.match(/\d+/)![0]));
  const textOf = (xml: string) => [...xml.matchAll(/<a:t>([^<]*)<\/a:t>/g)].map((m) => m[1]).join(" ");
  const slides = await Promise.all(slideNames.map(async (n) => textOf(await zip.file(n)!.async("string"))));
  const notes = Object.keys(zip.files).filter((n) => /^ppt\/notesSlides\/notesSlide\d+\.xml$/.test(n));
  const charts = Object.keys(zip.files).filter((n) => /^ppt\/charts\/chart\d+\.xml$/.test(n));
  const xmlParts = await Promise.all(Object.keys(zip.files).filter((n) => n.endsWith(".xml") || n.endsWith(".rels")).map(async (n) => [n, await zip.file(n)!.async("string")] as const));
  return { slides, notes, charts, xmlParts };
}

const titleIndex = (slides: string[], title: string) => slides.findIndex((s) => s.includes(title));

/** Position and size, in inches, of the shape or chart named `name` (its objectName) on the slides. */
function frameOf(xmlParts: (readonly [string, string])[], name: string) {
  const EMU = 914400;
  for (const [part, xml] of xmlParts) {
    if (!/^ppt\/slides\/slide\d+\.xml$/.test(part)) continue;
    const at = xml.indexOf(`name="${name}"`);
    if (at === -1) continue;
    const m = /<a:off x="(\d+)" y="(\d+)"\/><a:ext cx="(\d+)" cy="(\d+)"\/>/.exec(xml.slice(at))!;
    return { x: Number(m[1]) / EMU, y: Number(m[2]) / EMU, w: Number(m[3]) / EMU, h: Number(m[4]) / EMU };
  }
  throw new Error(`no shape named ${name}`);
}

/** The chart part whose data has a series or category called `label`. */
const chartWith = (xmlParts: (readonly [string, string])[], label: string) =>
  xmlParts.find(([part, xml]) => /^ppt\/charts\/chart\d+\.xml$/.test(part) && xml.includes(`<c:v>${label}</c:v>`))![1];

describe("apresentação do Dashboard", () => {
  it("monta capa, resumo, indicadores, volume, jornada, NPS, equipe, presença, palavras, glossário e encerramento — nessa ordem", async () => {
    const { slides } = await open(input());
    const order = [
      "Desempenho do atendimento",
      "O período em resumo",
      "Indicadores do período",
      "Volume do período",
      "Tempos médios da jornada do cliente",
      "Como os clientes avaliam o atendimento",
      "Conversas por atendente",
      "Mensagens enviadas e recebidas por atendente",
      "Desempenho por atendente",
      "Equipe ao longo do dia",
      "O que os clientes mais falam",
      "Como ler os indicadores",
      "Obrigado",
    ];
    expect(slides).toHaveLength(order.length);
    order.forEach((title, i) => expect(slides[i]).toContain(title));
  });

  it("a capa traz a empresa, o período com as datas e os filtros do Dashboard", async () => {
    const { slides } = await open(input());
    expect(slides[0]).toContain("Este mês · outubro de 2026, até 08/10");
    expect(slides[0]).toContain("Todas as conexões · todos os atendentes");
    expect(slides[0]).toContain("Empresa Demo · gerado em 08/10/2026");
  });

  it("os cartões são os do Dashboard, com a comparação com o período anterior", async () => {
    const { slides } = await open(input());
    const kpis = slides[titleIndex(slides, "Indicadores do período")];
    for (const label of ["Conversas recebidas", "Atendimentos únicos", "Na fila ao gerar o relatório", "1ª resposta (média)", "Encerradas", "Mensagens"]) expect(kpis).toContain(label);
    expect(kpis).toContain("1.284");
    expect(kpis).toContain("▲ 12% vs período anterior");
    expect(kpis).toContain("▼ 25% vs período anterior"); // 1ª resposta: 4 → 3 min
    expect(kpis).toContain("aguardando um atendente às 17:42");
  });

  it("cada slide tem notas do apresentador", async () => {
    const { slides, notes } = await open(input());
    expect(notes).toHaveLength(slides.length);
  });

  it("os gráficos são nativos do PowerPoint (editáveis), não imagens", async () => {
    const { charts } = await open(input());
    // 2 roscas, notas do NPS, conversas e mensagens por atendente, presença, palavras
    expect(charts).toHaveLength(7);
  });

  it("toda cor no arquivo é hexadecimal de 6 dígitos (cor com # ou com transparência no hex corrompe o arquivo)", async () => {
    const { xmlParts } = await open(input());
    for (const [, xml] of xmlParts) {
      for (const match of xml.matchAll(/<a:srgbClr val="([^"]*)"/g)) expect(match[1]).toMatch(/^[0-9A-F]{6}$/i);
    }
  });

  it("um nome de empresa com & e < não estraga o arquivo", async () => {
    const { xmlParts, slides } = await open(input({ companyName: "Silva & Filhos <Ltda>" }));
    for (const [name, xml] of xmlParts) {
      const parsed = new DOMParser().parseFromString(xml, "application/xml");
      expect(parsed.getElementsByTagName("parsererror"), name).toHaveLength(0);
    }
    expect(slides[slides.length - 1]).toContain("Silva &amp; Filhos &lt;Ltda&gt;");
  });

  it("sem pesquisa respondida não há slide de NPS, e o resumo fala das conversas encerradas", async () => {
    const { slides } = await open(input({ satisfaction: null }));
    expect(titleIndex(slides, "Como os clientes avaliam o atendimento")).toBe(-1);
    expect(slides[titleIndex(slides, "O período em resumo")]).toContain("conversas encerradas");
  });

  it("com o relatório da pesquisa: satisfação por atendente, evolução, por conexão e as últimas 5 de cada grupo, com o cliente", async () => {
    const stats = (sent: number, answered: number, nps: number | null, promoters: number, passives: number, detractors: number, average: number | null) => ({
      sent,
      answered,
      unanswered: 0,
      responseRate: sent ? Math.round((answered / sent) * 100) : null,
      average,
      nps,
      promoters,
      passives,
      detractors,
    });
    const response = (contactName: string, agentName: string, score: number) => ({
      surveyId: contactName,
      conversationId: `c-${contactName}`,
      sentAt: "2026-10-05T12:00:00.000Z",
      answeredAt: "2026-10-05T12:05:00.000Z",
      contactName,
      contactPhone: "5565999990000",
      agentName,
      connectionName: "Suporte",
      surveyName: "Pesquisa",
      question: "De 0 a 10?",
      score,
      answerText: String(score),
      rereadScore: null,
      correction: null,
      category: (score >= 9 ? "promoter" : score >= 7 ? "passive" : "detractor") as "promoter" | "passive" | "detractor",
      status: "answered" as const,
    });
    const report: NonNullable<PresentationInput["satisfactionReport"]> = {
      totals: { ...stats(20, 12, 25, 6, 3, 3, 7.8), distribution: [0, 0, 1, 1, 0, 0, 1, 1, 2, 3, 3], awaiting: 2 },
      byAgent: [
        { ...stats(12, 8, 75, 5, 2, 1, 8.4), agentId: "a1", agentName: "Ana Souza", lowest: 3, highest: 10, previousNps: 69 },
        { ...stats(8, 4, 38, 1, 1, 2, 6.5), agentId: "a2", agentName: "Bruno Lima", lowest: 2, highest: 9, previousNps: 45 },
      ],
      byConnection: [
        { ...stats(14, 9, 67, 5, 2, 2, 8.0), connectionId: "s", connectionName: "Suporte", connectionColor: "#0097B4" },
        { ...stats(6, 3, 50, 1, 1, 1, 7.0), connectionId: "v", connectionName: "Vendas", connectionColor: "#7C3AED" },
      ],
      trend: [
        { start: "2026-10-01T03:00:00.000Z", label: "01/10", answered: 5, average: 8.2, nps: 70 },
        { start: "2026-10-02T03:00:00.000Z", label: "02/10", answered: 7, average: 7.5, nps: 57 },
      ],
      responses: [response("Marina Alves", "Ana Souza", 10), response("Rita Prado", "Bruno Lima", 3), response("Carlos Dias", "Bruno Lima", 2)],
      previous: SATISFACTION!.previous,
      currentQuestion: SATISFACTION!.currentQuestion,
      settings: { npsGoal: 80, presentationCustomer: "full" },
    };
    const { slides, notes } = await open(input({ satisfactionReport: report }));
    const byAgent = titleIndex(slides, "Satisfação por atendente");
    const trend = titleIndex(slides, "Evolução da satisfação no período");
    const byConnection = titleIndex(slides, "Satisfação por conexão");
    const attention = titleIndex(slides, "Últimas avaliações de cada grupo");
    const npsSlide = titleIndex(slides, "Como os clientes avaliam o atendimento");
    expect([npsSlide, byAgent, trend, byConnection, attention].every((i) => i > 0)).toBe(true);
    expect(npsSlide < byAgent && byAgent < trend && trend < byConnection && byConnection < attention).toBe(true);
    expect(slides[byAgent]).toContain("Ana Souza");
    expect(slides[byAgent]).toContain("NPS (0–100)");
    expect(slides[byAgent]).toContain("▲ 6 pontos");
    expect(slides[byAgent]).toContain("▼ 7 pontos");
    expect(slides[byAgent]).toContain("Bruno Lima *"); // amostra pequena
    // Name and number of the customer, in each group.
    expect(slides[attention]).toContain("Rita Prado · (65) 99999-0000");
    expect(slides[attention]).toContain("Carlos Dias");
    expect(slides[attention]).toContain("Marina Alves");
    expect(slides[attention]).toContain("Promotores");
    expect(notes.length).toBe(slides.length);
    // Nothing on the −100…+100 scale anywhere.
    expect(slides.join(" ")).not.toMatch(/-100|\+100|−100/);

    // Only the initials when the survey settings say so.
    const initials = await open(input({ satisfactionReport: { ...report, settings: { npsGoal: null, presentationCustomer: "initials" } }, satisfaction: { ...SATISFACTION!, settings: { npsGoal: null, presentationCustomer: "initials" } } }));
    const latest = initials.slides[titleIndex(initials.slides, "Últimas avaliações de cada grupo")];
    expect(latest).toContain("R. P.");
    expect(latest).not.toContain("Rita Prado");

    // Without answers in the period, none of these slides.
    const empty = await open(input({ satisfaction: { ...SATISFACTION!, totals: { ...SATISFACTION!.totals, answered: 0, nps: null } }, satisfactionReport: report }));
    expect(titleIndex(empty.slides, "Satisfação por atendente")).toBe(-1);
  });

  it("o slide de NPS traz 0 a 100, a comparação, a meta e a pergunta formatada como o cliente recebe", async () => {
    const { slides, xmlParts } = await open(input());
    const nps = slides[titleIndex(slides, "Como os clientes avaliam o atendimento")];
    expect(nps).toContain("NPS do período (0 a 100)");
    expect(nps).toContain("81");
    expect(nps).toContain("▲ 6 pontos");
    expect(nps).toContain("Meta 80: acima");
    // *Pesquisa* in bold, _0 a 10_ in italic — the marks themselves don't show.
    expect(nps).not.toContain("*Pesquisa*");
    expect(nps).not.toContain("_0 a 10_");
    const xml = xmlParts.map(([, x]) => x).find((x) => x.includes("<a:t>Pesquisa</a:t>") && x.includes("recomendaria"))!;
    expect(xml).toMatch(/<a:rPr[^>]*b="1"[^>]*>(?:(?!<\/a:r>).)*<a:t>Pesquisa<\/a:t>/s);
    expect(xml).toMatch(/<a:rPr[^>]*i="1"[^>]*>(?:(?!<\/a:r>).)*<a:t>0 a 10<\/a:t>/s);
  });

  it("período sem movimento: sem jornada, sem equipe, sem presença e sem palavras — só o que tem número", async () => {
    const empty = snapshot({
      conversations: { received: 0, unique: 0, inProgress: 0, closed: 0, closedNoReturn: 0, waiting: 0 },
      messages: { received: 0, sent: 0, total: 0 },
      timings: { avgAcceptMs: null, avgFirstResponseMs: null, avgHandlingMs: null, avgClosingMs: null },
      perAgent: [],
      previous: { received: 0, unique: 0, closed: 0, messagesTotal: 0, avgFirstResponseMs: null },
    });
    const { slides } = await open(input({ data: empty, satisfaction: null, wordCloud: [], presenceByHour: null }));
    expect(slides).toHaveLength(6); // capa, resumo, indicadores, volume, glossário, encerramento
    expect(titleIndex(slides, "Tempos médios da jornada")).toBe(-1);
    expect(titleIndex(slides, "Conversas por atendente")).toBe(-1);
    expect(slides[titleIndex(slides, "Volume do período")]).toContain("Sem conversas no período");
    expect(slides[titleIndex(slides, "Indicadores do período")]).toContain("sem período anterior para comparar");
  });

  it("equipe grande: o gráfico mostra os 12 primeiros e a tabela continua em outro slide", async () => {
    const many = Array.from({ length: 15 }, (_, i) => agent(`Pessoa ${String(i + 1).padStart(2, "0")}`, 100 - i, i));
    const { slides } = await open(input({ data: snapshot({ perAgent: many }) }));
    expect(slides[titleIndex(slides, "Conversas por atendente")]).toContain("E mais 3 atendentes");
    expect(titleIndex(slides, "Desempenho por atendente (1 de 2)")).toBeGreaterThan(-1);
    const second = slides[titleIndex(slides, "Desempenho por atendente (2 de 2)")];
    expect(second).toContain("Pessoa 12");
    expect(second).toContain("Pessoa 15");
    expect(second).not.toContain("Pessoa 11");
  });

  it("equipe pequena: com 1 atendente as barras têm a espessura de sempre, no meio do cartão — não uma barra do tamanho do slide", async () => {
    const one = await open(input({ data: snapshot({ perAgent: [agent("Ana Souza", 6, 1)] }), wordCloud: [{ word: "boleto", count: 3 }] }));
    const eight = await open(input({ data: snapshot({ perAgent: Array.from({ length: 8 }, (_, i) => agent(`Pessoa ${i + 1}`, 50 - i, i)) }) }));
    const conversations = frameOf(one.xmlParts, "Gráfico de conversas por atendente");
    expect(conversations.h).toBeLessThan(1.2);
    expect(conversations.y).toBeGreaterThan(3);
    expect(frameOf(eight.xmlParts, "Gráfico de conversas por atendente").h).toBeGreaterThan(4.5);
    const messages = frameOf(one.xmlParts, "Gráfico de mensagens por atendente");
    expect(messages.w).toBeLessThan(3);
    expect(messages.x + messages.w / 2).toBeCloseTo(13.333 / 2, 1);
    expect(frameOf(eight.xmlParts, "Gráfico de mensagens por atendente").w).toBeGreaterThan(11);
    expect(frameOf(one.xmlParts, "Gráfico de palavras mais usadas").h).toBeLessThan(1.2);
  });

  it("presença de uma equipe pequena conta pessoas inteiras no eixo (0, 1, 2…), nunca 0,2 pessoa", async () => {
    const small = await open(input({ presenceByHour: { series: ["Online"], hours: [8, 9, 10].map((hour) => ({ hour, counts: { Online: hour === 9 ? 1 : 0 } })) } }));
    const chart = chartWith(small.xmlParts, "Online");
    expect(chart).toContain('<c:majorUnit val="1"/>');
    expect(chart).toMatch(/<c:max val="1"\/>/);
  });

  it("jornada com etapas sem tempo diz “sem dados” em vez de um traço solto", async () => {
    const timings = { avgAcceptMs: 4 * 60000, avgFirstResponseMs: null, avgHandlingMs: null, avgClosingMs: null };
    const { slides } = await open(input({ data: snapshot({ timings }) }));
    const journey = slides[titleIndex(slides, "Tempos médios da jornada do cliente")];
    expect(journey).toContain("4 min");
    expect(journey.match(/sem dados/g)).toHaveLength(3);
    expect(journey).not.toMatch(/(^| )- /);
  });

  it("resumo com só dois destaques fica no meio do slide, não grudado no título", async () => {
    const quiet = snapshot({
      previous: { received: 0, unique: 0, closed: 0, messagesTotal: 0, avgFirstResponseMs: null },
      timings: { avgAcceptMs: null, avgFirstResponseMs: null, avgHandlingMs: null, avgClosingMs: null },
      perAgent: [agent("Ana Souza", 10, 1)],
    });
    const { xmlParts } = await open(input({ data: quiet, satisfaction: null }));
    const first = frameOf(xmlParts, "Destaque 1");
    expect(first.y).toBeGreaterThan(2.5);
    expect(first.y + first.h / 2).toBeCloseTo((1.65 + 6.75) / 2, 1);
  });

  it("no período Hoje mostra também quem está online, em pausa e offline", async () => {
    const team: PresentationInput["team"] = { now: { online: 6, paused: 2, offline: 3, pausedUsers: [] }, agents: [] };
    const today = await open(input({ period: { period: "today" }, team, now: new Date(2026, 9, 8, 23, 0) }));
    expect(today.slides[titleIndex(today.slides, "Equipe ao longo do dia")]).toContain("online agora");
    const month = await open(input({ team }));
    expect(month.slides[titleIndex(month.slides, "Equipe ao longo do dia")]).not.toContain("online agora");
  });
});

describe("o período em resumo", () => {
  it("volume, velocidade, NPS e quem mais atendeu, só com números do Dashboard", () => {
    const items = buildHighlights({ data: snapshot(), satisfaction: SATISFACTION });
    expect(items.map((h) => `${h.value} ${h.title} — ${h.detail}`)).toEqual([
      "1.284 conversas recebidas — 12% a mais que no período anterior · 1.031 clientes diferentes",
      "3 min até a 1ª resposta, em média — 25% mais rápido que no período anterior",
      "81 de NPS, de 0 a 100 (satisfação dos clientes) — Zona de qualidade · 412 respostas · ▲ 6 pontos vs. período anterior",
      "312 conversas com Ana Souza — Quem mais atendeu: 38% das conversas da equipe",
    ]);
  });

  it("menos conversas e resposta mais lenta também são ditas como são", () => {
    const data = snapshot({
      conversations: { received: 900, unique: 1, inProgress: 0, closed: 0, closedNoReturn: 0, waiting: 0 },
      timings: { avgAcceptMs: null, avgFirstResponseMs: 5 * 60000, avgHandlingMs: null, avgClosingMs: null },
    });
    const [volume, speed] = buildHighlights({ data, satisfaction: null });
    expect(volume.detail).toBe("21% a menos que no período anterior · 1 cliente diferente");
    expect(speed.detail).toBe("25% mais lento que no período anterior");
  });

  it("sem período anterior, sem 1ª resposta e com um atendente só, não inventa comparação nem ranking", () => {
    const data = snapshot({
      previous: { received: 0, unique: 0, closed: 0, messagesTotal: 0, avgFirstResponseMs: null },
      timings: { avgAcceptMs: null, avgFirstResponseMs: null, avgHandlingMs: null, avgClosingMs: null },
      perAgent: [agent("Ana Souza", 10, 1)],
    });
    const items = buildHighlights({ data, satisfaction: null });
    expect(items.map((h) => h.icon)).toEqual(["inbox", "check"]);
    expect(items[0].detail).toBe("1.031 clientes diferentes");
  });

  it("caixa do gráfico do tamanho das barras: poucas ficam no meio, muitas ocupam tudo", () => {
    expect(fitBars(1, 2, 5, 0.6, 0.4)).toEqual({ start: 2 + (5 - 1) / 2, size: 1 });
    expect(fitBars(12, 2, 5, 0.6, 0.4)).toEqual({ start: 2, size: 5 });
  });

  it("variação relativa arredondada, nula sem base", () => {
    expect(relativeChange(112, 100)).toBe(12);
    expect(relativeChange(75, 100)).toBe(-25);
    expect(relativeChange(5, 0)).toBeNull();
    expect(relativeChange(null, 5)).toBeNull();
  });
});
