import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { MessageDTO } from "@whatsatendende/types";
import { AudioTranscription } from "./AudioTranscription";
import { api } from "../../lib/api";

vi.mock("../../lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/api")>();
  return { ...actual, api: { get: vi.fn(), post: vi.fn() } };
});

const audio = { id: "m1", conversationId: "c1", direction: "INBOUND", type: "AUDIO", transcription: null } as unknown as MessageDTO;

function renderIt(message: MessageDTO) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <AudioTranscription message={message} />
    </QueryClientProvider>
  );
}

describe("Transcrever áudio no atendimento", () => {
  beforeEach(() => {
    vi.mocked(api.get).mockReset();
    vi.mocked(api.post).mockReset();
  });

  it("desligado nas Configurações: sem botão", async () => {
    vi.mocked(api.get).mockResolvedValue({ data: { agentTranscription: false } });
    renderIt(audio);
    await waitFor(() => expect(api.get).toHaveBeenCalledWith("/ai-features"));
    expect(screen.queryByText("Transcrever")).toBeNull();
  });

  it("ligado: o botão transcreve e mostra o texto embaixo do áudio", async () => {
    vi.mocked(api.get).mockResolvedValue({ data: { agentTranscription: true } });
    vi.mocked(api.post).mockResolvedValue({ data: { transcription: "quero o boleto" } });
    renderIt(audio);
    fireEvent.click(await screen.findByText("Transcrever"));
    expect(await screen.findByText("quero o boleto")).toBeTruthy();
    expect(api.post).toHaveBeenCalledWith("/conversations/c1/messages/m1/transcribe", undefined, { timeout: 300_000 });
  });

  it("já transcrito (pelo assistente): mostra o texto e não pergunta nada ao servidor", () => {
    renderIt({ ...audio, transcription: "segunda via por favor" } as MessageDTO);
    expect(screen.getByText("segunda via por favor")).toBeTruthy();
    expect(api.get).not.toHaveBeenCalled();
  });
});
