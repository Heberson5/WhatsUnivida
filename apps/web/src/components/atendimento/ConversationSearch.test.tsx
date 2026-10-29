import { describe, it, expect, vi } from "vitest";
import { act, fireEvent, render, renderHook, screen } from "@testing-library/react";
import type { MessageDTO } from "@whatsatendende/types";
import { ConversationSearchBar, useConversationSearch } from "./ConversationSearch";

function message(id: string, body: string | null, fileName?: string): MessageDTO {
  return {
    id,
    conversationId: "c1",
    direction: "INBOUND",
    type: fileName ? "DOCUMENT" : "TEXT",
    status: "DELIVERED",
    body,
    senderAgentDisplayName: null,
    createdAt: new Date().toISOString(),
    deliveredAt: null,
    readAt: null,
    replyToMessageId: null,
    forwarded: false,
    replyToStory: null,
    linkPreview: null,
    attachments: fileName ? [{ id: `a-${id}`, fileName, mimeType: "application/pdf", sizeBytes: 1, url: "#", kind: "DOCUMENT" } as MessageDTO["attachments"][number]] : [],
    reactions: [],
  } as MessageDTO;
}

const messages = [message("m1", "Bom dia, preciso da segunda via"), message("m2", "Não consigo pagar"), message("m3", null, "boleto-outubro.pdf"), message("m4", "nao recebi o boleto")];

describe("pesquisar dentro da conversa (Atendimento e Gestão)", () => {
  it("acha sem acento e sem diferenciar maiúsculas, também no nome do PDF, começando pela mais recente", () => {
    const scrollTo = vi.fn();
    const { result } = renderHook(() => useConversationSearch(messages, scrollTo));
    act(() => result.current.openSearch());
    act(() => result.current.setQuery("NÃO"));
    expect(result.current.matches.map((m) => m.id)).toEqual(["m2", "m4"]);
    expect(result.current.currentId).toBe("m4");
    expect(scrollTo).toHaveBeenLastCalledWith("m4");

    act(() => result.current.setQuery("boleto"));
    expect(result.current.matches.map((m) => m.id)).toEqual(["m3", "m4"]);
    act(() => result.current.goTo(1));
    expect(result.current.currentId).toBe("m3"); // wraps around
    act(() => result.current.close());
    expect(result.current.open).toBe(false);
    expect(result.current.currentId).toBeNull();
  });

  it("a barra mostra a posição, navega com Enter e fecha com Esc", () => {
    function Harness() {
      const search = useConversationSearch(messages, () => undefined);
      return (
        <>
          <button onClick={search.openSearch}>abrir</button>
          <ConversationSearchBar search={search} loadingOlder={false} />
        </>
      );
    }
    render(<Harness />);
    fireEvent.click(screen.getByText("abrir"));
    const input = screen.getByPlaceholderText("Pesquisar nesta conversa");
    fireEvent.change(input, { target: { value: "boleto" } });
    expect(screen.getByText("2/2")).toBeInTheDocument();
    fireEvent.keyDown(input, { key: "Enter" });
    expect(screen.getByText("1/2")).toBeInTheDocument();
    fireEvent.keyDown(input, { key: "Escape" });
    expect(screen.queryByPlaceholderText("Pesquisar nesta conversa")).not.toBeInTheDocument();
  });
});
