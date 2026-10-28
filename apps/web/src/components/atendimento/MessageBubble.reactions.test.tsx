import { describe, it, expect } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import type { MessageDTO, MessageReactionDTO } from "@whatsatendende/types";
import { MessageBubble } from "./MessageBubble";

function message(reactions: MessageReactionDTO[]): MessageDTO {
  return {
    id: "m1",
    conversationId: "c1",
    direction: "INBOUND",
    type: "TEXT",
    status: "DELIVERED",
    body: "Oi, preciso de ajuda",
    senderAgentDisplayName: null,
    createdAt: new Date(2026, 9, 8, 10, 0).toISOString(),
    deliveredAt: null,
    readAt: null,
    replyToMessageId: null,
    forwarded: false,
    replyToStory: null,
    linkPreview: null,
    attachments: [],
    reactions,
  };
}

const reaction = (id: string, emoji: string, userDisplayName: string): MessageReactionDTO => ({ id, emoji, userId: id, userDisplayName });

function renderBubble(reactions: MessageReactionDTO[]) {
  return render(<MessageBubble message={message(reactions)} onReply={() => undefined} onReact={() => undefined} readOnly />);
}

describe("reactions on a message bubble", () => {
  it("shows the same emoji from two people once, with a 2 and their names", () => {
    renderBubble([reaction("a", "👍", "Ana"), reaction("b", "👍", "Cliente")]);
    const chips = screen.getAllByTestId("reaction-chip");
    expect(chips).toHaveLength(1);
    expect(chips[0]).toHaveTextContent("👍2");
    expect(chips[0]).toHaveAttribute("title", "Ana, Cliente");
  });

  it("shows one emoji alone without a number", () => {
    renderBubble([reaction("a", "❤️", "Cliente")]);
    const chips = screen.getAllByTestId("reaction-chip");
    expect(chips).toHaveLength(1);
    expect(chips[0]).toHaveTextContent(/^❤️$/);
  });

  it("shows nothing when nobody reacted", () => {
    renderBubble([]);
    expect(screen.queryByTestId("reaction-chip")).not.toBeInTheDocument();
  });

  it("um clique nas reações lista quem reagiu e com qual emoji (grupos), sem botão de reagir", () => {
    render(
      <MessageBubble
        message={message([reaction("a", "👍", "Maria"), reaction("b", "😂", "+5565999990002"), reaction("c", "👍", "João")])}
        onReply={() => undefined}
      />
    );
    expect(screen.queryByRole("dialog", { name: "Reações" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Ver quem reagiu" }));
    const list = screen.getByRole("dialog", { name: "Reações" });
    expect(list).toHaveTextContent("3 reações");
    expect(list).toHaveTextContent("Maria👍");
    expect(list).toHaveTextContent("+5565999990002😂");
    expect(list).toHaveTextContent("João👍");
  });
});

describe("GIF recebido", () => {
  it("roda sozinho, em repetição e sem som, com a etiqueta GIF", () => {
    const gif = {
      ...message([]),
      type: "VIDEO" as const,
      body: null,
      attachments: [{ id: "a1", fileName: "arquivo.mp4", mimeType: "video/mp4", sizeBytes: 1000, url: "/api/messages/attachments/a1/download", kind: "VIDEO" as const, isGif: true }],
    };
    const { container } = render(<MessageBubble message={gif} onReply={() => undefined} readOnly />);
    const video = container.querySelector("video")!;
    expect(video).toHaveAttribute("autoplay");
    expect(video).toHaveAttribute("loop");
    expect(video.muted).toBe(true);
    expect(screen.getByText("GIF")).toBeInTheDocument();
  });
});
