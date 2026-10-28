import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { GroupListItemDTO, MessageDTO, UserDTO } from "@whatsatendende/types";
import { GroupChatPanel } from "./GroupChatPanel";
import { GroupCard } from "./GroupCard";
import { GroupInfoPanel } from "./GroupInfoPanel";
import { api } from "../../lib/api";
import { useAuthStore } from "../../store/auth-store";

vi.mock("../../lib/api", () => ({
  api: { get: vi.fn(), post: vi.fn(), delete: vi.fn() },
  getApiErrorMessage: () => "Erro",
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), message: vi.fn() } }));

const reader = (name: string, over: Partial<GroupListItemDTO["readers"][number]> = {}) => ({
  userId: name,
  name,
  photoUrl: null,
  neverOpened: false,
  lastReadAt: new Date().toISOString(),
  unreadCount: 0,
  isMe: false,
  ...over,
});

function group(over: Partial<GroupListItemDTO> = {}): GroupListItemDTO {
  return {
    id: "g1",
    name: "Recepção — equipe",
    photoUrl: null,
    participantsCount: 12,
    whatsappConnectionId: "c1",
    whatsappConnectionName: "Recepção",
    whatsappConnectionColor: "#0097B4",
    whatsappConnectionStatus: "CONNECTED",
    lastMessageAt: new Date().toISOString(),
    lastMessagePreview: { senderName: "Ana Souza", text: "Bom dia" },
    unreadCount: 2,
    myLastReadAt: "2026-10-09T10:00:00.000Z",
    muted: false,
    readers: [reader("Bianca", { isMe: true, unreadCount: 2 }), reader("Lucas"), reader("Marta", { neverOpened: true, lastReadAt: null, unreadCount: 3 })],
    ...over,
  };
}

function message(id: string, body: string, createdAt: string, over: Partial<MessageDTO> = {}): MessageDTO {
  return {
    id,
    conversationId: "g1",
    direction: "INBOUND",
    type: "TEXT",
    status: "DELIVERED",
    body,
    senderAgentDisplayName: null,
    createdAt,
    deliveredAt: null,
    readAt: null,
    replyToMessageId: null,
    forwarded: false,
    replyToStory: null,
    linkPreview: null,
    attachments: [],
    reactions: [],
    senderParticipant: { name: "Ana Souza", phone: "5565999990000", color: "#0E7490" },
    ...over,
  };
}

function renderWithClient(node: React.ReactNode) {
  return render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>{node}</QueryClientProvider>);
}

describe("Grupos no Atendimento", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useAuthStore.setState({
      user: { id: "Bianca", role: "AGENT" } as UserDTO,
      permissions: { "atendimento.grupos.visualizar": true, "atendimento.grupos.responder": true } as never,
    });
    vi.mocked(api.get).mockResolvedValue({
      data: {
        items: [
          message("m1", "Mensagem já lida", "2026-10-09T09:00:00.000Z"),
          message("m2", "Primeira não lida", "2026-10-09T10:05:00.000Z"),
          message("m3", "Segunda não lida", "2026-10-09T10:06:00.000Z", { senderParticipant: { name: "Carlos Lima", phone: "5565988887777", color: "#7C3AED" } }),
        ],
        nextCursor: null,
      },
    } as never);
    vi.mocked(api.post).mockResolvedValue({ data: {} } as never);
  });

  it("o card mostra quem está em dia, o contador da própria pessoa e, num grupo novo, que ninguém abriu", () => {
    const { rerender } = render(<GroupCard group={group()} onSelect={() => undefined} />);
    expect(screen.getByText("Visto por Lucas")).toBeInTheDocument();
    expect(screen.getByText("2")).toBeInTheDocument();
    rerender(<GroupCard group={group({ readers: [reader("Bianca", { isMe: true, neverOpened: true, unreadCount: 2 })] })} onSelect={() => undefined} />);
    expect(screen.getByText("ninguém da equipe abriu")).toBeInTheDocument();
  });

  it("abrir o grupo marca como lido só para quem abriu, com o corte de não lidas onde a pessoa parou", async () => {
    renderWithClient(<GroupChatPanel group={group()} />);
    expect(await screen.findByText("Primeira não lida")).toBeInTheDocument();
    const divider = screen.getByRole("separator", { name: "Mensagens não lidas" });
    expect(divider).toHaveTextContent("2 mensagens não lidas");
    // The cut comes right before the first message after where Bianca stopped.
    expect(divider.compareDocumentPosition(screen.getByText("Primeira não lida")) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(divider.compareDocumentPosition(screen.getByText("Mensagem já lida")) & Node.DOCUMENT_POSITION_PRECEDING).toBeTruthy();
    await waitFor(() => expect(api.post).toHaveBeenCalledWith("/groups/g1/read"));
    expect(screen.getByText("Carlos Lima")).toBeInTheDocument();
    expect(screen.getByText(/vai para/)).toHaveTextContent("Sua mensagem vai para todos os 12 participantes do grupo, com o seu nome de exibição no início.");
  });

  it("sem 'Responder em grupos' a pessoa lê, mas não tem a caixa de envio", async () => {
    useAuthStore.setState({ permissions: { "atendimento.grupos.visualizar": true, "atendimento.grupos.responder": false } as never });
    renderWithClient(<GroupChatPanel group={group()} />);
    expect(await screen.findByText("Você pode ler este grupo, mas não tem permissão para responder nele.")).toBeInTheDocument();
    expect(screen.queryByText(/vai para/)).not.toBeInTheDocument();
  });

  it("silenciar fica só para a pessoa", async () => {
    renderWithClient(<GroupChatPanel group={group()} />);
    fireEvent.click(screen.getByRole("button", { name: "Silenciar este grupo" }));
    await waitFor(() => expect(api.post).toHaveBeenCalledWith("/groups/g1/mute"));
  });

  it("'Carregar mensagens anteriores' mostra primeiro o que já está guardado e, acabando, pede ao WhatsApp", async () => {
    const page = (items: MessageDTO[], nextCursor: string | null) => ({ data: { items, nextCursor } }) as never;
    vi.mocked(api.get)
      .mockResolvedValueOnce(page([message("m9", "Mais recente", "2026-10-09T10:09:00.000Z")], "m9"))
      .mockResolvedValueOnce(page([message("m1", "Guardada mais antiga", "2026-10-08T10:00:00.000Z")], null));
    renderWithClient(<GroupChatPanel group={group({ unreadCount: 0 })} />);
    fireEvent.click(await screen.findByRole("button", { name: "Carregar mensagens anteriores" }));
    expect(await screen.findByText("Guardada mais antiga")).toBeInTheDocument();
    expect(api.get).toHaveBeenLastCalledWith("/groups/g1/messages", { params: { limit: 100, cursor: "m9" } });
    expect(api.post).not.toHaveBeenCalledWith("/groups/g1/older-history");

    fireEvent.click(screen.getByRole("button", { name: "Carregar mensagens anteriores" }));
    await waitFor(() => expect(api.post).toHaveBeenCalledWith("/groups/g1/older-history"));
    expect(await screen.findByRole("button", { name: /Buscando no WhatsApp/ })).toBeDisabled();
  });

  it("Leitura da equipe: quem leu tudo, quem abriu e tem não lidas, e quem não abriu", () => {
    vi.mocked(api.get).mockResolvedValue({ data: [] } as never);
    renderWithClient(
      <GroupInfoPanel
        group={group({ readers: [reader("Bianca", { isMe: true, unreadCount: 2 }), reader("Lucas"), reader("Marta", { neverOpened: true, lastReadAt: null, unreadCount: 3 })] })}
        onClose={() => undefined}
      />
    );
    const team = screen.getByRole("region", { name: "Leitura da equipe" });
    expect(team).toHaveTextContent("Bianca (você)");
    expect(team).toHaveTextContent(/Abriu às \d\d:\d\d · 2 não lidas/);
    expect(team).toHaveTextContent(/Lucas.*Leu tudo · abriu às/);
    expect(team).toHaveTextContent("Marta");
    expect(team).toHaveTextContent("Não abriu · 3 não lidas");
  });
});
