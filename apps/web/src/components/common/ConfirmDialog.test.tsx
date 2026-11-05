import { describe, it, expect } from "vitest";
import { act, render, screen, fireEvent } from "@testing-library/react";
import { ConfirmHost, confirmAction } from "./ConfirmDialog";

describe("Confirmação do sistema (no lugar da caixa do navegador)", () => {
  it("diz o que acontece, nomeia a ação e confirma com o botão vermelho", async () => {
    render(<ConfirmHost />);
    let answer: Promise<boolean>;
    act(() => {
      answer = confirmAction({ title: "Excluir layout?", message: "O layout Itaú é apagado.", confirmLabel: "Excluir layout" });
    });
    expect(screen.getByRole("alertdialog", { name: "Excluir layout?" })).toBeInTheDocument();
    expect(screen.getByText("O layout Itaú é apagado.")).toBeInTheDocument();
    // Focus starts on Cancelar, so a reflex Enter never deletes anything.
    expect(screen.getByRole("button", { name: "Cancelar" })).toHaveFocus();
    fireEvent.click(screen.getByRole("button", { name: "Excluir layout" }));
    await expect(answer!).resolves.toBe(true);
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
  });

  it("Esc cancela", async () => {
    render(<ConfirmHost />);
    let answer: Promise<boolean>;
    act(() => {
      answer = confirmAction({ title: "Excluir?", confirmLabel: "Excluir" });
    });
    fireEvent.keyDown(window, { key: "Escape" });
    await expect(answer!).resolves.toBe(false);
  });
});
