import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { Composer } from "./Composer";
import { api } from "../../lib/api";

vi.mock("../../lib/api", () => ({ api: { get: vi.fn() } }));

// jsdom has no object URLs (the file preview uses them).
URL.createObjectURL = vi.fn(() => "blob:preview");
URL.revokeObjectURL = vi.fn();

function renderComposer() {
  const onSendFile = vi.fn().mockResolvedValue(undefined);
  const onSendText = vi.fn().mockResolvedValue(undefined);
  render(
    <Composer
      onSendText={onSendText}
      onSendFile={onSendFile}
      onSendAudio={vi.fn()}
      onSendLocation={vi.fn()}
      replyTo={null}
      onCancelReply={() => undefined}
      quickReplies={[
        { id: "qr-texto", name: "Boas-vindas", shortcut: "oi", text: "Olá! Como posso ajudar?" },
        {
          id: "qr-catalogo",
          name: "Catálogo",
          shortcut: "catalogo",
          text: "Segue o nosso catálogo.",
          media: { fileName: "catalogo.pdf", mimeType: "application/pdf", sizeBytes: 1024, kind: "DOCUMENT" },
        },
      ]}
    />
  );
  return { onSendFile, onSendText };
}

const field = () => screen.getByPlaceholderText(/Digite uma mensagem/i);

describe("Composer: resposta rápida com anexo", () => {
  it("só texto: preenche o campo para revisar, sem enviar", async () => {
    const { onSendText } = renderComposer();
    fireEvent.change(field(), { target: { value: "/oi" } });
    fireEvent.click(await screen.findByText("Boas-vindas"));
    expect(field()).toHaveValue("Olá! Como posso ajudar?");
    expect(onSendText).not.toHaveBeenCalled();
  });

  it("com anexo: prepara o arquivo com o texto como legenda; só sai quando o atendente envia", async () => {
    vi.mocked(api.get).mockResolvedValue({ data: new Blob(["%PDF"], { type: "application/pdf" }) } as never);
    const { onSendFile } = renderComposer();
    fireEvent.change(field(), { target: { value: "/cat" } });
    fireEvent.click(await screen.findByText("Catálogo"));

    await waitFor(() => expect(api.get).toHaveBeenCalledWith("/quick-replies/qr-catalogo/media", { responseType: "blob" }));
    expect(await screen.findByDisplayValue("Segue o nosso catálogo.")).toBeInTheDocument();
    expect(onSendFile).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: /Enviar/i }));
    await waitFor(() => expect(onSendFile).toHaveBeenCalledTimes(1));
    const [file, caption] = onSendFile.mock.calls[0];
    expect((file as File).name).toBe("catalogo.pdf");
    expect(caption).toBe("Segue o nosso catálogo.");
  });
});
