import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { api } from "../../lib/api";
import { Composer } from "./Composer";

vi.mock("../../lib/api", () => ({ api: { get: vi.fn(), post: vi.fn() } }));

const TEXT = "vc viu amanha";
const ISSUES = [
  { offset: 0, length: 2, message: "Informal", replacement: "você" },
  { offset: 7, length: 6, message: "Ortografia", replacement: "amanhã" },
];

function renderComposer(checkWriting = true) {
  const onSendText = vi.fn().mockResolvedValue(undefined);
  render(
    <Composer
      conversationId="c1"
      checkWriting={checkWriting}
      onSendText={onSendText}
      onSendFile={vi.fn()}
      onSendAudio={vi.fn()}
      onSendLocation={vi.fn()}
      replyTo={null}
      onCancelReply={() => undefined}
    />
  );
  const field = screen.getByPlaceholderText("Digite uma mensagem") as HTMLTextAreaElement;
  fireEvent.change(field, { target: { value: TEXT } });
  return { onSendText, field };
}

const send = (field: HTMLElement) => fireEvent.keyDown(field, { key: "Enter" });

describe("Composer: alerta do corretor ao enviar para o cliente", () => {
  beforeEach(() => {
    vi.mocked(api.post).mockReset();
    localStorage.clear();
  });

  it("com erro, nada é enviado até clicar em Enviar mesmo assim", async () => {
    vi.mocked(api.post).mockResolvedValue({ data: ISSUES });
    const { field, onSendText } = renderComposer();
    send(field);
    expect(await screen.findByRole("alertdialog")).toBeInTheDocument();
    expect(onSendText).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Enviar mesmo assim" }));
    await waitFor(() => expect(onSendText).toHaveBeenCalledTimes(1));
    expect(onSendText.mock.calls[0][0]).toBe(TEXT);
    expect(api.post).toHaveBeenCalledTimes(1);
  });

  it("Aplicar corrige no texto; corrigido tudo, volta para a caixa e o envio verifica de novo", async () => {
    vi.mocked(api.post).mockResolvedValueOnce({ data: ISSUES }).mockResolvedValue({ data: [] });
    const { field, onSendText } = renderComposer();
    send(field);
    await screen.findByRole("alertdialog");
    fireEvent.click(screen.getAllByRole("button", { name: "Aplicar" })[0]);
    expect(field.value).toBe("você viu amanha");
    fireEvent.click(screen.getByRole("button", { name: "Aplicar" }));
    expect(field.value).toBe("você viu amanhã");
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    expect(onSendText).not.toHaveBeenCalled();

    send(field);
    await waitFor(() => expect(onSendText).toHaveBeenCalledTimes(1));
    expect(onSendText.mock.calls[0][0]).toBe("você viu amanhã");
  });

  it("Voltar e corrigir mantém o texto e não envia", async () => {
    vi.mocked(api.post).mockResolvedValue({ data: ISSUES });
    const { field, onSendText } = renderComposer();
    send(field);
    await screen.findByRole("alertdialog");
    fireEvent.click(screen.getByRole("button", { name: "Voltar e corrigir" }));
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    expect(field.value).toBe(TEXT);
    expect(onSendText).not.toHaveBeenCalled();
  });

  it("corretor fora do ar ou lento: envia sem alerta", async () => {
    vi.mocked(api.post).mockRejectedValue(new Error("timeout"));
    const { field, onSendText } = renderComposer();
    send(field);
    await waitFor(() => expect(onSendText).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
  });

  it("fora da conversa com cliente (grupos), não verifica", async () => {
    const { field, onSendText } = renderComposer(false);
    send(field);
    await waitFor(() => expect(onSendText).toHaveBeenCalledTimes(1));
    expect(api.post).not.toHaveBeenCalled();
  });
});
