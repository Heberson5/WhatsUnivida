import type { ReactElement } from "react";
import { describe, it, expect, vi } from "vitest";
import { render as rtlRender, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ConversationListItemDTO } from "@whatsatendende/types";
import { ConversationCard } from "./ConversationCard";

vi.mock("../../lib/api", () => ({
  api: { get: vi.fn(() => Promise.resolve({ data: {} })) },
  getApiErrorMessage: () => "erro",
  withAuthToken: (url: string) => url,
}));

const render = (ui: ReactElement) => rtlRender(<QueryClientProvider client={new QueryClient()}>{ui}</QueryClientProvider>);

function conversation(overrides: Partial<ConversationListItemDTO> = {}): ConversationListItemDTO {
  const now = new Date().toISOString();
  return {
    id: "c1",
    contact: { id: "k1", name: "Ana Lima", phone: "5565977770001", photoUrl: null },
    status: "IN_PROGRESS",
    assignedAgentId: "u1",
    assignedAgentName: "Ana",
    channel: "WHATSAPP",
    whatsappConnectionId: "w1",
    whatsappConnectionName: "Suporte",
    whatsappConnectionColor: "#0097B4",
    whatsappConnectionStatus: "DISCONNECTED",
    enteredQueueAt: now,
    acceptedAt: now,
    lastMessageAt: now,
    lastMessagePreview: null,
    awaitingReplySince: null,
    unreadCount: 0,
    isNew: false,
    pendingTransferDeadline: null,
    transfer: null,
    tags: [],
    ...overrides,
  } as unknown as ConversationListItemDTO;
}

describe("Card do atendimento: conexão desconectada e borda", () => {
  it("mostra o selo quando a página ainda não avisa sobre essa conexão", () => {
    render(<ConversationCard conversation={conversation()} onSelect={() => {}} />);
    expect(screen.getByText("Conexão desconectada")).toBeInTheDocument();
  });

  it("não repete o selo em cada card quando o aviso do topo já fala dessa conexão", () => {
    render(<ConversationCard conversation={conversation()} onSelect={() => {}} connectionWarningShown />);
    expect(screen.queryByText("Conexão desconectada")).not.toBeInTheDocument();
  });

  it("o card selecionado ganha a borda esquerda colorida (que afina nos cantos arredondados)", () => {
    render(<ConversationCard conversation={conversation({ whatsappConnectionStatus: "CONNECTED" } as Partial<ConversationListItemDTO>)} onSelect={() => {}} selected />);
    const card = screen.getByRole("button", { current: true });
    expect(card).toHaveClass("rounded-lg", "border-l-[5px]", "border-l-primary");
  });
});
