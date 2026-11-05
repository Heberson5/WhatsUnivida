import { describe, it, expect, vi } from "vitest";
import { render, fireEvent } from "@testing-library/react";
import { useEscapeKey } from "./useEscapeKey";

function Layer({ onEscape, enabled = true, children }: { onEscape: () => void; enabled?: boolean; children?: React.ReactNode }) {
  useEscapeKey(onEscape, enabled);
  return <div>{children}</div>;
}

describe("useEscapeKey", () => {
  it("Esc fecha só a janela aberta por último", () => {
    const form = vi.fn();
    const confirm = vi.fn();
    // The form is open; then a confirmation opens on top of it.
    const { rerender } = render(<Layer onEscape={form} />);
    rerender(
      <Layer onEscape={form}>
        <Layer onEscape={confirm} />
      </Layer>
    );
    fireEvent.keyDown(window, { key: "Escape" });
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(form).not.toHaveBeenCalled();

    // The confirmation closed: the next Esc goes to the form underneath.
    rerender(<Layer onEscape={form} />);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(form).toHaveBeenCalledTimes(1);
  });

  it("uma janela fechada (enabled=false) não pega o Esc", () => {
    const below = vi.fn();
    const hidden = vi.fn();
    render(
      <Layer onEscape={below}>
        <Layer onEscape={hidden} enabled={false} />
      </Layer>
    );
    fireEvent.keyDown(window, { key: "Escape" });
    expect(hidden).not.toHaveBeenCalled();
    expect(below).toHaveBeenCalledTimes(1);
  });

  it("um Esc já tratado dentro da janela (ex.: fechar um menu de menção) não fecha a janela", () => {
    const close = vi.fn();
    render(
      <Layer onEscape={close}>
        <input aria-label="campo" onKeyDown={(e) => e.key === "Escape" && e.preventDefault()} />
      </Layer>
    );
    const input = document.querySelector("input")!;
    fireEvent.keyDown(input, { key: "Escape" });
    expect(close).not.toHaveBeenCalled();
  });
});
