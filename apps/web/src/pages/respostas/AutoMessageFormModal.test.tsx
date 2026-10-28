import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { AutoMessageTemplateDTO, AutoMessageTrigger } from "@whatsatendende/types";
import { AutoMessageFormModal, type AutoMessageFormValues } from "./AutoMessageFormModal";
import { api } from "../../lib/api";

vi.mock("../../lib/api", () => ({ api: { get: vi.fn() } }));

const USERS = [
  { id: "u-ana", displayName: "Ana", presence: "ONLINE", whatsappConnectionName: "Suporte" },
  { id: "u-bruno", displayName: "Bruno", presence: "OFFLINE", whatsappConnectionName: null },
];

function renderForm(trigger: AutoMessageTrigger, template: AutoMessageTemplateDTO | null = null) {
  vi.mocked(api.get).mockImplementation(((url: string) => Promise.resolve({ data: url === "/agents/transfer-targets" ? USERS : [] })) as never);
  const onSubmit = vi.fn<(values: AutoMessageFormValues) => Promise<void>>().mockResolvedValue(undefined);
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <AutoMessageFormModal trigger={trigger} template={template} onClose={() => undefined} onSubmit={onSubmit} />
    </QueryClientProvider>
  );
  return onSubmit;
}

const usersGroup = () => screen.getByRole("radiogroup", { name: "Quem pode usar" });

describe("Respostas › Aceite: quem pode usar a mensagem", () => {
  beforeEach(() => vi.mocked(api.get).mockReset());

  it("nova mensagem de aceite vale para todos os usuários; escolhendo, envia só os marcados", async () => {
    const onSubmit = renderForm("ACCEPT");
    fireEvent.change(screen.getByPlaceholderText("Ex: Aviso padrão"), { target: { value: "Da Ana" } });
    fireEvent.change(screen.getByRole("textbox", { name: "" }), { target: { value: "Olá, {{cliente}}!" } });
    expect(within(usersGroup()).getByRole("radio", { name: "Todos os usuários" })).toHaveAttribute("aria-checked", "true");

    fireEvent.click(within(usersGroup()).getByRole("radio", { name: "Escolher usuários" }));
    fireEvent.click(await screen.findByRole("checkbox", { name: /Ana/ }));
    fireEvent.click(screen.getByRole("button", { name: "Salvar" }));

    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect(onSubmit.mock.calls[0][0].userScope).toEqual({ allUsers: false, userIds: ["u-ana"] });
  });

  it("escolher usuários sem marcar ninguém não salva", async () => {
    const onSubmit = renderForm("ACCEPT");
    fireEvent.change(screen.getByPlaceholderText("Ex: Aviso padrão"), { target: { value: "Ninguém" } });
    fireEvent.change(screen.getByRole("textbox", { name: "" }), { target: { value: "Oi" } });
    fireEvent.click(within(usersGroup()).getByRole("radio", { name: "Escolher usuários" }));
    fireEvent.click(screen.getByRole("button", { name: "Salvar" }));
    expect(await screen.findByText("Escolha pelo menos um usuário ou marque todos os usuários")).toBeInTheDocument();
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("ao editar, já vem com os usuários escolhidos", async () => {
    renderForm("ACCEPT", {
      id: "t1",
      trigger: "ACCEPT",
      name: "Do Bruno",
      text: "Oi",
      showSenderName: true,
      active: true,
      connectionScope: { allConnections: true, connections: [] },
      userScope: { allUsers: false, users: [{ id: "u-bruno", displayName: "Bruno" }] },
      createdAt: "2026-10-09T10:00:00.000Z",
      updatedAt: "2026-10-09T10:00:00.000Z",
    });
    expect(await screen.findByRole("checkbox", { name: /Bruno/ })).toBeChecked();
    expect(screen.getByRole("checkbox", { name: /Ana/ })).not.toBeChecked();
  });

  it("a mensagem de transferência não tem a escolha de usuários", () => {
    renderForm("TRANSFER");
    expect(screen.queryByRole("radiogroup", { name: "Quem pode usar" })).not.toBeInTheDocument();
  });
});
