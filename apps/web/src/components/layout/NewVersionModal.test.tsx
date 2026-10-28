import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";
import { NewVersionModal, SNOOZE_MS } from "./NewVersionModal";
import { useComposerActivityStore } from "../../store/composer-activity-store";

function deployed(id: string | null) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => (id ? { ok: true, json: async () => ({ id }) } : { ok: false, json: async () => ({}) }))
  );
}

async function renderModal() {
  render(<NewVersionModal />);
  await act(async () => {
    await Promise.resolve();
  });
}

describe("Nova versão do sistema", () => {
  beforeEach(() => {
    vi.stubGlobal("__BUILD_ID__", "build-antigo");
    useComposerActivityStore.setState({ busy: {} });
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("não avisa nada quando a versão publicada é a mesma desta página", async () => {
    deployed("build-antigo");
    await renderModal();
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    expect(screen.queryByText(/Nova versão do sistema disponível/)).not.toBeInTheDocument();
  });

  it("não avisa quando não consegue ler a versão publicada", async () => {
    deployed(null);
    await renderModal();
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
  });

  it("versão nova publicada: abre o aviso com o alerta de falha e o atalho de ajuda", async () => {
    deployed("build-novo");
    await renderModal();
    expect(screen.getByRole("alertdialog", { name: "Nova versão do sistema disponível" })).toBeInTheDocument();
    expect(screen.getByText("Se não atualizar, pode ocorrer alguma falha inesperada.")).toBeInTheDocument();
    expect(screen.getByText(/Ctrl\+Shift\+R/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Atualizar agora" })).toBeInTheDocument();
  });

  it("com mensagem ou áudio sem enviar, só mostra a faixa; o aviso abre depois de enviar", async () => {
    deployed("build-novo");
    useComposerActivityStore.getState().setBusy("composer-1", true);
    await renderModal();
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("Se não atualizar, pode ocorrer alguma falha inesperada.");

    act(() => useComposerActivityStore.getState().setBusy("composer-1", false));
    expect(screen.getByRole("alertdialog")).toBeInTheDocument();
  });

  it("Lembrar em 10 minutos esconde o aviso, deixa a faixa e volta depois do tempo", async () => {
    deployed("build-novo");
    await renderModal();
    vi.useFakeTimers();
    fireEvent.click(screen.getByRole("button", { name: "Lembrar em 10 minutos" }));
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    expect(screen.getByRole("status")).toBeInTheDocument();

    act(() => {
      vi.advanceTimersByTime(SNOOZE_MS + 1000);
    });
    expect(screen.getByRole("alertdialog")).toBeInTheDocument();
  });
});
