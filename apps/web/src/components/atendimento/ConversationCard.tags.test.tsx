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

function conversation(tags: ConversationListItemDTO["tags"], preview: string | null = null): ConversationListItemDTO {
  const now = new Date().toISOString();
  return {
    id: "c1",
    contact: { id: "k1", name: "Ana Lima 456-CNP", phone: "5565977770001", photoUrl: null },
    status: "WAITING",
    assignedAgentId: null,
    assignedAgentName: null,
    channel: "WHATSAPP",
    whatsappConnectionId: "w1",
    whatsappConnectionName: "Suporte",
    whatsappConnectionColor: "#0097B4",
    whatsappConnectionStatus: "CONNECTED",
    enteredQueueAt: now,
    acceptedAt: null,
    lastMessageAt: now,
    lastMessagePreview: preview,
    awaitingReplySince: null,
    unreadCount: 0,
    isNew: true,
    pendingTransferDeadline: null,
    transfer: null,
    tags,
  } as unknown as ConversationListItemDTO;
}

const tag = (id: string, name: string) => ({ id, name, color: "#E24B4A" });

describe("Card do atendimento: etiquetas do contato", () => {
  it("mostra até 3 etiquetas ao lado do número e o resto como +N", () => {
    render(<ConversationCard conversation={conversation([tag("1", "Inadimplente"), tag("2", "Plano Ouro"), tag("3", "Cidade CNP"), tag("4", "VIP"), tag("5", "Prioridade")])} onAccept={() => {}} />);
    expect(screen.getByText("Inadimplente")).toBeInTheDocument();
    expect(screen.getByText("Cidade CNP")).toBeInTheDocument();
    expect(screen.queryByText("VIP")).not.toBeInTheDocument();
    const more = screen.getByText("+2");
    expect(more).toHaveAttribute("title", "VIP, Prioridade");
    expect(screen.getByLabelText("Etiquetas: Inadimplente, Plano Ouro, Cidade CNP, VIP, Prioridade")).toBeInTheDocument();
  });

  it("sem etiqueta o card fica como antes; na fila a mensagem do cliente não aparece", () => {
    render(<ConversationCard conversation={conversation([], null)} onAccept={() => {}} />);
    expect(screen.queryByLabelText(/^Etiquetas:/)).not.toBeInTheDocument();
    expect(screen.getByText("+55 65 97777-0001")).toBeInTheDocument();
  });
});
