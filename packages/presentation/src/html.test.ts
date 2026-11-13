// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { buildDashboardHtml } from "./html";
import type { DashboardSnapshot, PresentationInput } from "./presentation";

const NOW = new Date(2026, 10, 3, 14, 18);
const PIXEL = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

const agent = (name: string, conversations: number, i: number) => ({
  agentId: `a${i}`,
  agentName: name,
  conversations,
  messagesSent: conversations * 6,
  messagesReceived: conversations * 5,
  avgHandlingMs: 40 * 60000,
});

const data: DashboardSnapshot = {
  conversations: { received: 27, unique: 24, inProgress: 3, closed: 23, closedNoReturn: 1, waiting: 2 },
  messages: { received: 160, sent: 145, total: 305 },
  timings: { avgAcceptMs: 60000, avgFirstResponseMs: 120000, avgHandlingMs: 30 * 60000, avgClosingMs: 35 * 60000 },
  perAgent: [agent("Ana Souza", 15, 1), agent("Bruno Lima", 8, 2), agent("Carla Mendes", 4, 3)],
  users: { online: 3, active: 5, total: 5 },
  previous: { received: 2, unique: 2, closed: 2, messagesTotal: 5, avgFirstResponseMs: 180000, label: "sex 30/10 até 14:18" },
};

const response = (id: string, name: string, score: number, category: "promoter" | "passive" | "detractor", reason: string | null) => ({
  surveyId: id,
  conversationId: id,
  sentAt: "2026-11-03T15:00:00.000Z",
  answeredAt: "2026-11-03T15:10:00.000Z",
  contactName: name,
  contactPhone: "5565999990000",
  agentName: "Ana Souza",
  connectionName: "Suporte",
  surveyName: "Pesquisa",
  question: "?",
  score,
  answerText: String(score),
  reasonText: reason,
  rereadScore: null,
  correction: null,
  category,
  status: "answered" as const,
});

function input(overrides: Partial<PresentationInput> = {}): PresentationInput {
  return {
    companyName: "Empresa Demo",
    primaryColor: "#2563EB",
    logo: { data: PIXEL, width: 400, height: 100 },
    icons: { inbox: PIXEL },
    period: { period: "today" },
    scopeLabel: "Todas as conexões · todos os atendentes",
    data,
    satisfaction: {
      totals: { sent: 10, answered: 8, unanswered: 1, responseRate: 80, average: 8, nps: 50, promoters: 5, passives: 1, detractors: 2, distribution: [0, 0, 0, 1, 0, 1, 0, 1, 0, 2, 3], awaiting: 1 },
      previous: { from: "", to: "", label: "sex 30/10 até 14:18", nps: 40, average: 7, answered: 5, responseRate: 70 },
      currentQuestion: "*Pesquisa*\nDe 0 a 10?",
      settings: { npsGoal: 75, presentationCustomer: "full" },
      byAgent: null,
      latest: {
        detractor: [response("d1", "Mariana Alves", 3, "detractor", "Demorou muito para me responderem")],
        passive: [],
        promoter: [response("p1", "José Neto", 10, "promoter", null)],
      },
    },
    team: null,
    wordCloud: [{ word: "boleto", count: 12 }],
    presenceByHour: { series: ["Online"], hours: [8, 9, 10].map((hour) => ({ hour, counts: { Online: 3 } })) },
    presenceHourRange: null,
    now: NOW,
    ...overrides,
  };
}

const parse = (html: string) => new DOMParser().parseFromString(html, "text/html");

describe("apresentação em HTML", () => {
  it("traz as mesmas seções do PowerPoint, da capa ao encerramento", () => {
    const doc = parse(buildDashboardHtml(input()));
    const titles = [...doc.querySelectorAll("section.slide")].map((s) => s.getAttribute("aria-label"));
    expect(titles[0]).toBe("Capa");
    expect(titles).toEqual(
      expect.arrayContaining([
        "O período em resumo",
        "Indicadores do período",
        "Volume do período",
        "Tempos médios da jornada do cliente",
        "Como os clientes avaliam o atendimento",
        "Últimas avaliações de cada grupo",
        "Conversas por atendente",
        "Desempenho por atendente",
        "Equipe ao longo do dia",
        "O que os clientes mais falam",
        "Como ler os indicadores",
      ])
    );
    expect(titles.at(-1)).toBe("Encerramento");
    // The index lists every slide.
    expect(doc.querySelectorAll("#idx option")).toHaveLength(titles.length);
  });

  it("os cartões dizem com que dia comparam, como no Dashboard", () => {
    const doc = parse(buildDashboardHtml(input()));
    const kpis = doc.querySelector('section[aria-label="Indicadores do período"]')!.textContent!;
    expect(kpis).toContain("+25 vs 2 em sex 30/10 até 14:18");
  });

  it("cada slide leva a marca Desenvolvido por Sauberlich System", () => {
    const html = buildDashboardHtml(input());
    const slides = html.match(/<section class="slide[\s\S]*?<\/section>/g) ?? [];
    expect(slides.length).toBeGreaterThan(5);
    for (const slide of slides) expect(slide).toContain("Desenvolvido por Sauberlich System");
  });

  it("funciona sem internet: nada no arquivo aponta para fora", () => {
    const html = buildDashboardHtml(input());
    expect(html).not.toMatch(/(src|href)="https?:/);
    expect(html).not.toMatch(/url\(\s*['"]?https?:/);
    expect(html).not.toMatch(/@import/);
  });

  it("um nome de empresa com & e < não quebra a página", () => {
    const doc = parse(buildDashboardHtml(input({ companyName: 'Lima & <Filhos> "Ltda"' })));
    expect(doc.querySelector(".cover")!.textContent).toContain('Lima & <Filhos> "Ltda"');
    expect(doc.querySelector("Filhos")).toBeNull();
  });

  it("o motivo da nota baixa abre ao clicar, e o cliente aparece como a configuração manda", () => {
    const full = parse(buildDashboardHtml(input()));
    const detail = full.querySelector(".ev details")!;
    expect(detail.querySelector("summary")!.textContent).toContain("Mariana Alves");
    expect(detail.querySelector(".reason")!.textContent).toContain("Demorou muito para me responderem");

    const initials = buildDashboardHtml(input({ satisfaction: { ...input().satisfaction!, settings: { npsGoal: 75, presentationCustomer: "initials" } } }));
    expect(initials).not.toContain("Mariana Alves");
    expect(parse(initials).querySelector(".ev summary")!.textContent).toContain("M. A.");
  });

  it("os gráficos saem no tipo padrão do Dashboard e mostram o número ao passar o mouse", () => {
    const bars = parse(buildDashboardHtml(input()));
    const conversations = bars.querySelector('section[aria-label="Conversas por atendente"]')!;
    expect(conversations.querySelector(".hb")).not.toBeNull();
    expect(conversations.querySelector('[data-tip="Ana Souza · Conversas: 15"]')).not.toBeNull();

    const line = parse(buildDashboardHtml(input({ chartKinds: { conversationsByAgent: "line", conversationsByStatus: "pie" } })));
    expect(line.querySelector('section[aria-label="Conversas por atendente"] svg path')).not.toBeNull();
    // A pie has no hole: no total written in the middle.
    const [status, messages] = [...line.querySelectorAll('section[aria-label="Volume do período"] .card')];
    expect(status.querySelector(".dc-n")).toBeNull();
    expect(messages.querySelector(".dc-n")).not.toBeNull();
  });

  it("a tabela de desempenho ordena pelas colunas e o script da página é válido", () => {
    const html = buildDashboardHtml(input());
    const doc = parse(html);
    expect(doc.querySelectorAll('section[aria-label="Desempenho por atendente"] th[data-col]').length).toBeGreaterThan(5);
    const script = doc.querySelector("script")!.textContent!;
    expect(() => new Function(script)).not.toThrow();
  });
});
