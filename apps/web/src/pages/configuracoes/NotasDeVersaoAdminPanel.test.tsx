import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReleaseDTO } from "@whatsatendende/types";
import { NotasDeVersaoAdminPanel, nextVersionAfter } from "./NotasDeVersaoAdminPanel";
import { api } from "../../lib/api";

vi.mock("../../lib/api", () => ({
  api: { get: vi.fn(), post: vi.fn(), put: vi.fn(), delete: vi.fn() },
  getApiErrorMessage: (_err: unknown, fallback = "erro") => fallback,
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const RELEASES: ReleaseDTO[] = [
  {
    id: "r2",
    version: "2.2.0",
    date: "08 out 2026",
    name: "Apresentação do Dashboard",
    summary: "PowerPoint para a diretoria.",
    notes: [
      {
        type: "novo",
        area: "dashboard",
        title: "Apresentação de PowerPoint",
        text: "Baixa uma apresentação.",
        steps: ["Clique em Apresentação (PPT) {1}."],
        roles: ["ADMIN", "MANAGER"],
        images: [{ src: "/notas-de-versao/dashboard-apresentacao.webp", caption: "{1} Apresentação (PPT)" }],
      },
    ],
  },
  { id: "r1", version: "2.1.9", date: "08 out 2026", name: "Abrir arquivos", summary: "PDF e Word.", notes: [{ type: "correcao", area: "atendimento", title: "PDF em branco", before: "Não abria", after: "Abre" }] },
];

function renderPanel() {
  vi.mocked(api.get).mockResolvedValue({ data: RELEASES } as never);
  vi.mocked(api.put).mockImplementation(((_url: string, body: object) => Promise.resolve({ data: { id: "r2", ...body } })) as never);
  vi.mocked(api.post).mockImplementation(((url: string, body: object) =>
    Promise.resolve({ data: url === "/release-notes/images" ? { src: "/uploads/release-notes/novo-print.png" } : { id: "r3", ...body } })) as never);
  vi.mocked(api.delete).mockResolvedValue({ data: null } as never);
  return render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <NotasDeVersaoAdminPanel />
    </QueryClientProvider>
  );
}

const preview = () => screen.getByRole("complementary", { name: "Prévia" });
const note = (n: number) => screen.getByRole("region", { name: `Nota ${n}` });

describe("Configurações › Notas de versão", () => {
  beforeEach(() => vi.clearAllMocks());

  it("lista as versões, a mais nova como atual; Nova versão espera a lista chegar", async () => {
    renderPanel();
    expect(screen.getByRole("button", { name: "Nova versão" })).toBeDisabled();
    const current = (await screen.findByText("Apresentação do Dashboard")).closest("tr")!;
    expect(within(current).getByText("Atual")).toBeInTheDocument();
    expect(screen.getByText("Abrir arquivos")).toBeInTheDocument();
  });

  it("editar: a prévia mostra a nota com as marcações de sempre e muda enquanto se escreve; salvar envia a versão inteira", async () => {
    renderPanel();
    fireEvent.click(await screen.findByRole("button", { name: "Editar versão 2.2.0" }));

    expect(within(preview()).getByText("Novo")).toBeInTheDocument();
    expect(within(preview()).getByText("Como usar")).toBeInTheDocument();
    expect(within(preview()).getByRole("img", { name: "(1) Apresentação (PPT)" })).toHaveAttribute("src", "/notas-de-versao/dashboard-apresentacao.webp");

    fireEvent.change(within(note(1)).getByLabelText("Título"), { target: { value: "Apresentação para a diretoria" } });
    fireEvent.click(within(note(1)).getByRole("radio", { name: "Melhoria" }));
    fireEvent.change(within(note(1)).getByLabelText(/^Antes/), { target: { value: "Slides simples" } });
    fireEvent.change(within(note(1)).getByLabelText(/^Agora/), { target: { value: "Visual do Dashboard" } });
    expect(within(preview()).getByRole("heading", { name: "Apresentação para a diretoria" })).toBeInTheDocument();
    expect(within(preview()).getByText("Melhoria")).toBeInTheDocument();
    expect(within(preview()).getByText("Antes")).toBeInTheDocument();
    expect(within(preview()).getByText("Agora")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Salvar versão" }));
    await waitFor(() => expect(api.put).toHaveBeenCalledTimes(1));
    const [url, body] = vi.mocked(api.put).mock.calls[0] as [string, ReleaseDTO];
    expect(url).toBe("/release-notes/r2");
    expect(body.notes[0]).toEqual({
      type: "melhoria",
      area: "dashboard",
      title: "Apresentação para a diretoria",
      text: "Baixa uma apresentação.",
      before: "Slides simples",
      after: "Visual do Dashboard",
      steps: ["Clique em Apresentação (PPT) {1}."],
      images: [{ src: "/notas-de-versao/dashboard-apresentacao.webp", caption: "{1} Apresentação (PPT)" }],
      roles: ["ADMIN", "MANAGER"],
    });
  });

  it("Antes sem Agora não salva, e diz em qual nota está o problema", async () => {
    renderPanel();
    fireEvent.click(await screen.findByRole("button", { name: "Editar versão 2.2.0" }));
    fireEvent.change(within(note(1)).getByLabelText(/^Antes/), { target: { value: "Só o antes" } });
    expect(screen.getByRole("status")).toHaveTextContent("Nota 1: preencha o Antes e o Agora juntos");
    expect(screen.getByRole("button", { name: "Salvar versão" })).toBeDisabled();
  });

  it("nova versão: começa no número seguinte, com uma nota; adicionar imagem envia o arquivo e ela aparece na prévia", async () => {
    renderPanel();
    await screen.findByText("Apresentação do Dashboard");
    fireEvent.click(screen.getByRole("button", { name: "Nova versão" }));
    expect(screen.getByLabelText(/^Versão/)).toHaveValue("2.2.1");

    fireEvent.change(screen.getByLabelText("Nome da versão"), { target: { value: "Ajustes" } });
    fireEvent.change(screen.getByLabelText(/^Resumo/), { target: { value: "Correções pequenas." } });
    fireEvent.change(within(note(1)).getByLabelText("Título"), { target: { value: "Novo print" } });
    fireEvent.change(within(note(1)).getByLabelText("Quem vê"), { target: { value: "admins" } });
    const file = new File(["png"], "print.png", { type: "image/png" });
    fireEvent.change(within(note(1)).getByLabelText("Arquivo de imagem da nota 1"), { target: { files: [file] } });
    // No caption yet: an image without alt text, found by its address.
    await waitFor(() => expect(preview().querySelector('img[src="/uploads/release-notes/novo-print.png"]')).not.toBeNull());
    fireEvent.change(within(note(1)).getByLabelText("Legenda da imagem 1 da nota 1"), { target: { value: "{1} Botão novo" } });
    expect(within(preview()).getByLabelText("marcação 1")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Salvar versão" }));
    await waitFor(() => expect(vi.mocked(api.post).mock.calls.some(([url]) => url === "/release-notes")).toBe(true));
    const body = vi.mocked(api.post).mock.calls.find(([url]) => url === "/release-notes")![1] as ReleaseDTO;
    expect(body).toMatchObject({ version: "2.2.1", name: "Ajustes", notes: [{ title: "Novo print", roles: ["ADMIN"], images: [{ src: "/uploads/release-notes/novo-print.png", caption: "{1} Botão novo" }] }] });
  });

  it("um número de versão que já existe não salva", async () => {
    renderPanel();
    await screen.findByText("Apresentação do Dashboard");
    fireEvent.click(screen.getByRole("button", { name: "Nova versão" }));
    fireEvent.change(screen.getByLabelText(/^Versão/), { target: { value: "2.1.9" } });
    expect(screen.getByRole("status")).toHaveTextContent("Já existe a versão 2.1.9.");
  });

  it("excluir pede confirmação", async () => {
    renderPanel();
    fireEvent.click(await screen.findByRole("button", { name: "Excluir versão 2.1.9" }));
    fireEvent.click(within(screen.getByRole("dialog", { name: "Excluir versão" })).getByRole("button", { name: "Excluir" }));
    await waitFor(() => expect(api.delete).toHaveBeenCalledWith("/release-notes/r1"));
  });

  it("número da próxima versão", () => {
    expect(nextVersionAfter(["2.1.9", "2.10.0", "2.2.0"])).toBe("2.10.1");
    expect(nextVersionAfter([])).toBe("1.0.0");
  });
});
