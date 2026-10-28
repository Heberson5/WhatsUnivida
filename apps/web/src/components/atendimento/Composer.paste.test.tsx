import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { Composer } from "./Composer";

vi.mock("../../lib/api", () => ({ api: { get: vi.fn() } }));

// jsdom has no object URLs (the file preview uses them).
URL.createObjectURL = vi.fn(() => "blob:preview");
URL.revokeObjectURL = vi.fn();

function renderComposer() {
  const onSendFile = vi.fn().mockResolvedValue(undefined);
  render(
    <Composer
      onSendText={vi.fn().mockResolvedValue(undefined)}
      onSendFile={onSendFile}
      onSendAudio={vi.fn()}
      onSendLocation={vi.fn()}
      replyTo={null}
      onCancelReply={() => undefined}
    />
  );
  return { onSendFile, field: screen.getByPlaceholderText("Digite uma mensagem") };
}

/** What Ctrl+V hands the page: the files of the clipboard, and its text (if any). */
function paste(target: HTMLElement, files: File[], text = "") {
  const clipboardData = { files, getData: (type: string) => (type === "text/plain" ? text : "") };
  return fireEvent.paste(target, { clipboardData });
}

const png = (name = "image.png") => new File(["png"], name, { type: "image/png" });

describe("Composer: colar imagem com Ctrl+V, como no WhatsApp Web", () => {
  it("um print colado vira anexo, com nome próprio, e o texto digitado vira a legenda", async () => {
    const { field, onSendFile } = renderComposer();
    fireEvent.change(field, { target: { value: "Segue o boleto atualizado" } });
    paste(field, [png()]);

    expect(await screen.findByText(/^imagem-colada-\d{14}\.png$/)).toBeInTheDocument();
    expect(screen.getByDisplayValue("Segue o boleto atualizado")).toBeInTheDocument(); // the caption

    fireEvent.click(screen.getByRole("button", { name: /Enviar/i }));
    await waitFor(() => expect(onSendFile).toHaveBeenCalledTimes(1));
    expect(onSendFile.mock.calls[0][1]).toBe("Segue o boleto atualizado");
  });

  it("vários arquivos copiados no Explorador entram todos, com os nomes deles", async () => {
    const { field } = renderComposer();
    paste(field, [new File(["%PDF"], "contrato.pdf", { type: "application/pdf" }), png("foto.png")]);
    expect(await screen.findAllByText("contrato.pdf")).not.toHaveLength(0);
    // Two staged: each gets its own caption.
    expect(screen.getByPlaceholderText(/Adicionar legenda a este anexo/)).toBeInTheDocument();
  });

  it("colar com a prévia aberta acrescenta a imagem — também pelo campo da legenda", async () => {
    const { field } = renderComposer();
    paste(field, [png("primeira.png")]);
    const caption = await screen.findByPlaceholderText(/Adicionar legenda/);
    paste(caption, [png("segunda.png")]);
    expect(await screen.findAllByText("segunda.png")).not.toHaveLength(0);
    expect(screen.getByPlaceholderText(/Adicionar legenda a este anexo/)).toBeInTheDocument(); // two now
  });

  it("texto colado continua texto — e cópia do Word/Excel (texto com imagem junto) também", () => {
    const { field } = renderComposer();
    const plain = paste(field, [], "Olá");
    expect(plain).toBe(true); // not intercepted: the browser pastes the text
    const office = paste(field, [png()], "Total\t189,90");
    expect(office).toBe(true);
    expect(screen.queryByText(/imagem-colada-/)).not.toBeInTheDocument();
  });
});
