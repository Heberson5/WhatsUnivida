import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ConversationListItemDTO, PermissionMap } from "@whatsatendende/types";
import GestaoPage from "./GestaoPage";
import { api } from "../../lib/api";
import { useAuthStore } from "../../store/auth-store";

vi.mock("../../lib/api", () => ({
  api: { get: vi.fn(), post: vi.fn() },
  getApiErrorMessage: () => "erro",
  withAuthToken: (url: string) => url,
}));

// The read-only conversation (Visualizar) loads its own messages; here it only has to show it opened.
vi.mock("../../components/gestao/ReadOnlyConversationDrawer", () => ({
  ReadOnlyConversationDrawer: ({ conversation }: { conversation: ConversationListItemDTO }) => (
    <div role="dialog" aria-label={`Conversa com ${conversation.contact.name}`} />
  ),
}));

const hoursAgo = (hours: number) => new Date(Date.now() - hours * 3_600_000).toISOString();

function row(
  id: string,
  name: string,
  lastMessageAt: string,
  status: ConversationListItemDTO["status"] = "IN_PROGRESS",
  awaitingReplySince: string | null = null
): ConversationListItemDTO {
  return {
    id,
    contact: { id: `c-${id}`, name, phone: "5511990001111", photoUrl: null },
    status,
    assignedAgentId: null,
    assignedAgentName: "Ana",
    channel: "WHATSAPP",
    whatsappConnectionId: "w1",
    whatsappConnectionName: "Suporte",
    whatsappConnectionColor: "#0097B4",
    enteredQueueAt: lastMessageAt,
    acceptedAt: null,
    lastMessageAt,
    lastMessagePreview: `última de ${name}`,
    awaitingReplySince,
    unreadCount: 0,
    isNew: false,
    pendingTransferDeadline: null,
    transfer: null,
  } as unknown as ConversationListItemDTO;
}

function oversightCalls() {
  return vi
    .mocked(api.get)
    .mock.calls.filter(([url]) => url === "/conversations/oversight/page")
    .map(([, config]) => (config as { params: Record<string, unknown> }).params);
}

/** What the API answers for one page: the status filter, the total and the chip counts over every row. */
function pageOf(rows: ConversationListItemDTO[], params: Record<string, unknown>) {
  const statuses = typeof params.status === "string" ? params.status.split(",") : null;
  const matching = statuses ? rows.filter((r) => statuses.includes(r.status)) : rows;
  const page = Number(params.page ?? 1);
  const pageSize = Number(params.pageSize ?? 50);
  const statusCounts: Record<string, number> = {};
  for (const r of rows) statusCounts[r.status] = (statusCounts[r.status] ?? 0) + 1;
  return { items: matching.slice((page - 1) * pageSize, page * pageSize), total: matching.length, page, pageSize, statusCounts };
}

function renderPage(url = "/gestao", rows: ConversationListItemDTO[] = []) {
  vi.mocked(api.get).mockImplementation(((url: string, config?: { params?: Record<string, unknown> }) => {
    if (url === "/conversations/oversight/page") return Promise.resolve({ data: pageOf(rows, config?.params ?? {}) });
    return Promise.resolve({ data: [] }); // /agents, /whatsapp/connections
  }) as never);
  useAuthStore.setState({ permissions: {} as PermissionMap, user: { role: "ADMIN" } as never });
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[url]}>
        <GestaoPage />
      </MemoryRouter>
    </QueryClientProvider>
  );
}

describe("Gestão: filtro de período", () => {
  beforeEach(() => {
    vi.mocked(api.get).mockReset();
  });

  it("abre em Hoje e pede ao servidor o período Hoje, no fuso deste navegador", async () => {
    renderPage();
    await waitFor(() => expect(oversightCalls().length).toBeGreaterThan(0));
    const [first] = oversightCalls();
    expect(first.period).toBe("today");
    expect(first.tzOffsetMinutes).toBe(new Date().getTimezoneOffset());
    expect(first.from).toBeUndefined();
    expect(first.to).toBeUndefined();
    expect(screen.getByDisplayValue("Hoje")).toBeInTheDocument();
  });

  it("trocar para Ontem pede Ontem", async () => {
    renderPage();
    await waitFor(() => expect(oversightCalls().length).toBeGreaterThan(0));
    fireEvent.change(screen.getByDisplayValue("Hoje"), { target: { value: "yesterday" } });
    await waitFor(() => expect(oversightCalls().at(-1)?.period).toBe("yesterday"));
  });

  it("Todo o período não manda período nenhum", async () => {
    renderPage();
    await waitFor(() => expect(oversightCalls().length).toBeGreaterThan(0));
    fireEvent.change(screen.getByDisplayValue("Hoje"), { target: { value: "all" } });
    await waitFor(() => expect(oversightCalls().at(-1)?.period).toBeUndefined());
    expect(screen.getByDisplayValue("Todo o período")).toBeInTheDocument();
  });

  it("Personalizado manda as duas datas escolhidas", async () => {
    renderPage();
    await waitFor(() => expect(oversightCalls().length).toBeGreaterThan(0));
    fireEvent.change(screen.getByDisplayValue("Hoje"), { target: { value: "custom" } });
    const [from, to] = Array.from(document.querySelectorAll('input[type="date"]'));
    fireEvent.change(from, { target: { value: "2026-10-01" } });
    fireEvent.change(to, { target: { value: "2026-10-07" } });
    await waitFor(() => expect(oversightCalls().at(-1)).toMatchObject({ period: "custom", from: "2026-10-01", to: "2026-10-07" }));
  });

  it("o atalho Aguardando do Dashboard (status, sem período) abre em Todo o período, não em Hoje", async () => {
    renderPage("/gestao?status=NEW,WAITING");
    await waitFor(() => expect(screen.getByDisplayValue("Todo o período")).toBeInTheDocument());
    await waitFor(() => expect(oversightCalls().at(-1)?.period).toBeUndefined());
  });

  it("o atalho do Dashboard com período mantém esse período", async () => {
    renderPage("/gestao?status=CLOSED&period=yesterday");
    await waitFor(() => expect(screen.getByDisplayValue("Ontem")).toBeInTheDocument());
    await waitFor(() => expect(oversightCalls().at(-1)?.period).toBe("yesterday"));
  });
});

describe("Gestão: última atividade", () => {
  beforeEach(() => {
    vi.mocked(api.get).mockReset();
  });

  it("mostra quando cada conversa teve movimento, com hoje e ontem por extenso", async () => {
    renderPage("/gestao", [row("1", "Maria", hoursAgo(0.01)), row("2", "João", hoursAgo(30))]);
    const maria = (await screen.findByText("Maria")).closest("tr") as HTMLElement;
    const joao = screen.getByText("João").closest("tr") as HTMLElement;
    expect(within(maria).getByText(/^hoje \d{2}:\d{2}$/)).toBeInTheDocument();
    expect(within(joao).getByText(/^(ontem|\d{2}\/\d{2}) \d{2}:\d{2}$/)).toBeInTheDocument();
    expect(screen.getByText("Última atividade")).toBeInTheDocument();
  });
});

describe("Gestão: conversas pelo celular", () => {
  beforeEach(() => {
    vi.mocked(api.get).mockReset();
  });

  it("mostra há quanto tempo o cliente espera resposta, já que a mensagem dele não entra na fila", async () => {
    renderPage("/gestao", [row("1", "Maria", hoursAgo(2), "HANDLED_EXTERNALLY", hoursAgo(2)), row("2", "João", hoursAgo(2), "HANDLED_EXTERNALLY", null)]);
    const maria = (await screen.findByText("Maria")).closest("tr") as HTMLElement;
    const joao = screen.getByText("João").closest("tr") as HTMLElement;
    expect(within(maria).getByText(/sem resposta há/)).toBeInTheDocument();
    expect(within(joao).queryByText(/sem resposta há/)).not.toBeInTheDocument();
  });
});

describe("Gestão: filtro de atendentes", () => {
  beforeEach(() => {
    vi.mocked(api.get).mockReset();
  });

  it("lista atendentes, gestores e administradores separados, com o próprio nome marcado, e filtra pelo escolhido", async () => {
    vi.mocked(api.get).mockImplementation(((url: string) => {
      if (url === "/agents/attendants") {
        return Promise.resolve({
          data: [
            { id: "a1", displayName: "Admin", role: "ADMIN", isSelf: true },
            { id: "g1", displayName: "Gestora", role: "MANAGER", isSelf: false },
            { id: "t1", displayName: "Maria", role: "AGENT", isSelf: false },
          ],
        });
      }
      return Promise.resolve({ data: [] });
    }) as never);
    useAuthStore.setState({ permissions: {} as PermissionMap, user: { role: "ADMIN" } as never });
    render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <MemoryRouter initialEntries={["/gestao"]}>
          <GestaoPage />
        </MemoryRouter>
      </QueryClientProvider>
    );

    const filter = screen.getByRole("combobox", { name: "Filtrar por atendente" });
    expect(await within(filter).findByRole("option", { name: "Admin (você)" })).toBeInTheDocument();
    const groups = within(filter).getAllByRole("group");
    expect(groups.map((g) => g.getAttribute("label"))).toEqual(["Atendentes", "Gestores", "Administradores"]);
    expect(within(groups[1]).getByRole("option", { name: "Gestora" })).toBeInTheDocument();

    fireEvent.change(filter, { target: { value: "g1" } });
    await waitFor(() => expect(oversightCalls().at(-1)?.agentId).toBe("g1"));
  });
});

describe("Gestão no celular", () => {
  const originalMatchMedia = window.matchMedia;
  beforeEach(() => {
    vi.mocked(api.get).mockReset();
    window.matchMedia = ((query: string) => ({ ...originalMatchMedia(query), matches: query === "(max-width: 767px)" })) as typeof window.matchMedia;
  });
  afterEach(() => {
    window.matchMedia = originalMatchMedia;
  });

  it("mostra cada conversa como cartão, sem tabela, e tocar no cartão abre a conversa", async () => {
    renderPage("/gestao", [row("1", "Bruna Lima", hoursAgo(1))]);
    const name = await screen.findByText("Bruna Lima");
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
    const card = name.closest("[role=button]") as HTMLElement;
    expect(within(card).getByText("Atendente")).toBeInTheDocument();
    expect(within(card).getByText("Ana")).toBeInTheDocument();
    expect(within(card).getByRole("button", { name: /Visualizar/ })).toBeInTheDocument();

    fireEvent.click(card);
    expect(await screen.findByRole("dialog", { name: "Conversa com Bruna Lima" })).toBeInTheDocument();
  });
});

describe("Gestão: linhas por página e páginas", () => {
  beforeEach(() => {
    vi.mocked(api.get).mockReset();
    localStorage.removeItem("gestao-page-size");
  });

  const many = (count: number) =>
    Array.from({ length: count }, (_, i) => row(`r${i}`, `Cliente ${i}`, new Date(2026, 9, 22, 10, 0, 0, -i * 1000).toISOString(), i % 2 ? "CLOSED" : "IN_PROGRESS"));

  it("mostra 50 por padrão, o total da busca e quantas páginas; as setas trocam de página", async () => {
    renderPage("/gestao", many(120));
    expect(await screen.findByText("Mostrando 50 de 120 conversas")).toBeInTheDocument();
    expect(screen.getByText("Página 1 de 3")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Página anterior" })).toBeDisabled();

    fireEvent.click(screen.getByRole("button", { name: "Próxima página" }));
    await waitFor(() => expect(oversightCalls().at(-1)).toMatchObject({ page: 2, pageSize: 50 }));
    expect(await screen.findByText("Página 2 de 3")).toBeInTheDocument();
  });

  it("trocar as linhas por página volta para a página 1 e fica guardado", async () => {
    renderPage("/gestao", many(120));
    await screen.findByText("Página 1 de 3");
    fireEvent.click(screen.getByRole("button", { name: "Próxima página" }));
    await screen.findByText("Página 2 de 3");

    fireEvent.change(screen.getByRole("combobox", { name: "Linhas por página" }), { target: { value: "100" } });
    await waitFor(() => expect(oversightCalls().at(-1)).toMatchObject({ page: 1, pageSize: 100 }));
    expect(await screen.findByText("Página 1 de 2")).toBeInTheDocument();
    expect(localStorage.getItem("gestao-page-size")).toBe("100");
  });

  it("o filtro de status vai para o servidor e o número de cada filtro cobre a busca toda", async () => {
    renderPage("/gestao", many(120));
    expect(await screen.findByRole("button", { name: "Em atendimento · 60" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Em atendimento · 60" }));
    await waitFor(() => expect(oversightCalls().at(-1)).toMatchObject({ status: "IN_PROGRESS,TRANSFERRED", page: 1 }));
    expect(await screen.findByText("Mostrando 50 de 60 conversas")).toBeInTheDocument();
  });
});
