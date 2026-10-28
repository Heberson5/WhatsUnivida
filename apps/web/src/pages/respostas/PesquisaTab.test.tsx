import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { PERMISSION, type PermissionMap, type SatisfactionSurveyDTO } from "@whatsatendende/types";
import { PesquisaTab } from "./PesquisaTab";
import { api } from "../../lib/api";
import { useAuthStore } from "../../store/auth-store";

vi.mock("../../lib/api", () => ({
  api: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: vi.fn(), put: vi.fn() },
  getApiErrorMessage: () => "erro",
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const survey = (overrides: Partial<SatisfactionSurveyDTO>): SatisfactionSurveyDTO => ({
  id: "s1",
  name: "Pesquisa do suporte",
  active: true,
  connectionScope: { allConnections: true, connections: [] },
  question: "De 0 a 10, o quanto você recomendaria o atendimento?",
  thanks: "Obrigado pela sua avaliação!",
  answerWindowHours: 24,
  closingWaitMinutes: 30,
  createdAt: "2026-10-09T10:00:00.000Z",
  updatedAt: "2026-10-09T10:00:00.000Z",
  ...overrides,
});

const SURVEYS = [
  survey({}),
  survey({ id: "m1", name: "Modelo – Agilidade", active: false, connectionScope: { allConnections: false, connections: [] }, question: "De 0 a 10, como você avalia a rapidez?" }),
];

type Perms = Partial<Record<"ADICIONAR" | "EDITAR" | "EXCLUIR", boolean>>;

function renderTab(perms: Perms = { ADICIONAR: true, EDITAR: true, EXCLUIR: true }) {
  vi.mocked(api.get).mockImplementation(((url: string) =>
    Promise.resolve({
      data: url === "/satisfaction-survey/surveys" ? SURVEYS : url === "/satisfaction-survey/settings" ? { npsGoal: null, presentationCustomer: "full" } : [],
    })) as never);
  vi.mocked(api.post).mockImplementation(((_url: string, body: object) => Promise.resolve({ data: { ...survey({}), ...body, id: "novo" } })) as never);
  vi.mocked(api.patch).mockImplementation(((_url: string, body: object) => Promise.resolve({ data: { ...survey({}), ...body } })) as never);
  useAuthStore.setState({
    permissions: {
      [PERMISSION.RESPOSTAS_PESQUISA_ADICIONAR]: Boolean(perms.ADICIONAR),
      [PERMISSION.RESPOSTAS_PESQUISA_EDITAR]: Boolean(perms.EDITAR),
      [PERMISSION.RESPOSTAS_PESQUISA_EXCLUIR]: Boolean(perms.EXCLUIR),
    } as unknown as PermissionMap,
  });
  return render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <PesquisaTab />
    </QueryClientProvider>
  );
}

const waitField = () => screen.findByLabelText(/Se o cliente não responder, enviar a mensagem de encerramento em/);

describe("Respostas › Pesquisa: lista de pesquisas", () => {
  beforeEach(() => {
    vi.mocked(api.get).mockReset();
    vi.mocked(api.post).mockReset();
    vi.mocked(api.patch).mockReset();
  });

  it("lista as pesquisas com o status, e o modelo sem conexão aparece como tal", async () => {
    renderTab();
    const model = (await screen.findByText("Modelo – Agilidade")).closest("tr")!;
    expect(within(model).getByText("Desligada")).toBeInTheDocument();
    expect(within(model).getByText("Nenhuma conexão")).toBeInTheDocument();
    const active = screen.getByText("Pesquisa do suporte").closest("tr")!;
    expect(within(active).getByText("Ligada")).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("1 pesquisa ligada.");
  });

  it("duplicar um modelo abre uma pesquisa nova, desligada, com os textos dele — e cria, sem mexer no modelo", async () => {
    renderTab();
    fireEvent.click(await screen.findByRole("button", { name: "Duplicar Modelo – Agilidade" }));
    expect(screen.getByLabelText("Nome")).toHaveValue("Cópia de Modelo – Agilidade");
    expect(screen.getByRole("switch")).not.toBeChecked();
    fireEvent.click(screen.getByRole("button", { name: "Salvar" }));
    await waitFor(() => expect(api.post).toHaveBeenCalledTimes(1));
    expect(vi.mocked(api.post).mock.calls[0][1]).toMatchObject({ name: "Cópia de Modelo – Agilidade", active: false, question: "De 0 a 10, como você avalia a rapidez?" });
    expect(api.patch).not.toHaveBeenCalled();
  });

  it("para ligar, precisa escolher conexões", async () => {
    renderTab();
    fireEvent.click(await screen.findByRole("button", { name: "Editar Modelo – Agilidade" }));
    fireEvent.click(screen.getByRole("switch"));
    expect(screen.getByText("Escolha pelo menos uma conexão para ligar a pesquisa.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Salvar" })).toBeDisabled();
  });

  it("editar muda o tempo de espera e salva na mesma pesquisa", async () => {
    renderTab();
    fireEvent.click(await screen.findByRole("button", { name: "Editar Pesquisa do suporte" }));
    expect(await waitField()).toHaveValue(30);
    fireEvent.change(await waitField(), { target: { value: "45" } });
    fireEvent.click(screen.getByRole("button", { name: "Salvar" }));
    await waitFor(() => expect(api.patch).toHaveBeenCalledTimes(1));
    expect(vi.mocked(api.patch).mock.calls[0][0]).toBe("/satisfaction-survey/surveys/s1");
    expect(vi.mocked(api.patch).mock.calls[0][1]).toMatchObject({ closingWaitMinutes: 45, answerWindowHours: 24 });
  });

  it.each(["0", "721", ""])("a espera %j não pode ser salva", async (value) => {
    renderTab();
    fireEvent.click(await screen.findByRole("button", { name: "Editar Pesquisa do suporte" }));
    fireEvent.change(await waitField(), { target: { value } });
    expect(screen.getByRole("button", { name: "Salvar" })).toBeDisabled();
    expect(screen.getByText("Use um valor de 1 a 720 minutos.")).toBeInTheDocument();
  });

  it("a espera não pode passar do tempo que o cliente tem para responder", async () => {
    renderTab();
    fireEvent.click(await screen.findByRole("button", { name: "Editar Pesquisa do suporte" }));
    const field = await waitField();
    fireEvent.change(screen.getByLabelText(/Aceitar resposta por até \(horas\)/), { target: { value: "1" } });
    fireEvent.change(field, { target: { value: "90" } });
    expect(screen.getByRole("alert")).toHaveTextContent("A espera não pode ser maior que o tempo para o cliente responder (1 h).");
    expect(screen.getByRole("button", { name: "Salvar" })).toBeDisabled();
    fireEvent.change(field, { target: { value: "60" } });
    expect(screen.getByRole("button", { name: "Salvar" })).toBeEnabled();
  });

  it("quem só pode ver abre a pesquisa travada, sem criar, duplicar nem excluir", async () => {
    renderTab({});
    fireEvent.click(await screen.findByRole("button", { name: "Ver Pesquisa do suporte" }));
    expect(await waitField()).toBeDisabled();
    expect(screen.queryByRole("button", { name: "Salvar" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Nova pesquisa" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Duplicar/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Excluir/ })).not.toBeInTheDocument();
  });

  it("relatórios e apresentação: salva a meta de NPS e o cliente só com iniciais no PPT", async () => {
    vi.mocked(api.put).mockImplementation(((_url: string, body: object) => Promise.resolve({ data: body })) as never);
    renderTab();
    const goal = await screen.findByLabelText(/Meta de NPS \(0 a 100\)/);
    await waitFor(() => expect(screen.getByRole("radio", { name: /Nome e número/ })).toBeChecked());
    fireEvent.change(goal, { target: { value: "120" } });
    expect(screen.getByText("Informe um número inteiro de 0 a 100.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Salvar configurações" })).toBeDisabled();
    fireEvent.change(goal, { target: { value: "80" } });
    fireEvent.click(screen.getByRole("radio", { name: /Só as iniciais/ }));
    fireEvent.click(screen.getByRole("button", { name: "Salvar configurações" }));
    await waitFor(() => expect(api.put).toHaveBeenCalledWith("/satisfaction-survey/settings", { npsGoal: 80, presentationCustomer: "initials" }));
  });
});
