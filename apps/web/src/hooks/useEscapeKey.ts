import { useEffect, useRef } from "react";

/**
 * Calls `onEscape` when Esc is pressed while `enabled` — the one way every window/drawer in the system closes from the
 * keyboard. Only the window opened LAST handles a given Esc (a confirmation on top of a form closes alone, not both),
 * and an Esc already handled by something inside it (a menu or picker calling preventDefault) is left alone.
 */
const stack: symbol[] = [];

export function useEscapeKey(onEscape: () => void, enabled = true) {
  const handler = useRef(onEscape);
  handler.current = onEscape;

  useEffect(() => {
    if (!enabled) return;
    const id = Symbol("escape-layer");
    stack.push(id);
    function onKey(e: KeyboardEvent) {
      if (e.key !== "Escape" || e.defaultPrevented || stack[stack.length - 1] !== id) return;
      e.preventDefault();
      handler.current();
    }
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      const at = stack.indexOf(id);
      if (at !== -1) stack.splice(at, 1);
    };
  }, [enabled]);
}
