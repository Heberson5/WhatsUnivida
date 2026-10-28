import { useState, type KeyboardEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";

const WIDTH_KEY = "client-panel-width";
const MIN_WIDTH = 280;
const MAX_WIDTH = 560;
const DEFAULT_WIDTH = 280;
// What the conversation list and the chat need beside the panel: it never grows into them.
const ROOM_FOR_LIST_AND_CHAT = 700;
const KEYBOARD_STEP = 16;

function clampWidth(width: number) {
  const max = Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, window.innerWidth - ROOM_FOR_LIST_AND_CHAT));
  return Math.round(Math.min(max, Math.max(MIN_WIDTH, width)));
}

function readWidth() {
  try {
    const stored = Number(localStorage.getItem(WIDTH_KEY));
    if (stored) return stored;
  } catch {
    // storage blocked: the default width
  }
  return DEFAULT_WIDTH;
}

function saveWidth(width: number) {
  try {
    localStorage.setItem(WIDTH_KEY, String(width));
  } catch {
    // storage blocked: the width lasts until the page reloads
  }
}

/**
 * The client (or group) panel beside the chat, with its left edge dragged to make it wider or narrower — remembered
 * on this computer; a double click goes back to the default. `resizable` is off while the panel is collapsed.
 */
export function ResizableSidePanel({ resizable, children }: { resizable: boolean; children: ReactNode }) {
  const [width, setWidth] = useState(readWidth);
  const shown = clampWidth(width);

  function startDrag(event: ReactPointerEvent<HTMLDivElement>) {
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = shown;
    let latest = startWidth;
    const move = (e: PointerEvent) => {
      latest = clampWidth(startWidth + startX - e.clientX);
      setWidth(latest);
    };
    const stop = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", stop);
      document.body.classList.remove("cursor-col-resize", "select-none");
      saveWidth(latest);
    };
    document.body.classList.add("cursor-col-resize", "select-none");
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", stop);
  }

  function setAndSave(next: number) {
    const clamped = clampWidth(next);
    setWidth(clamped);
    saveWidth(clamped);
  }

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === "ArrowLeft") setAndSave(shown + KEYBOARD_STEP);
    if (event.key === "ArrowRight") setAndSave(shown - KEYBOARD_STEP);
  }

  if (!resizable) return <div className="hidden h-full min-w-0 overflow-hidden md:block">{children}</div>;
  return (
    <div className="relative hidden h-full min-w-0 overflow-hidden md:block" style={{ width: shown }}>
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label="Ajustar a largura do painel"
        aria-valuenow={shown}
        aria-valuemin={MIN_WIDTH}
        aria-valuemax={MAX_WIDTH}
        tabIndex={0}
        onPointerDown={startDrag}
        onDoubleClick={() => setAndSave(DEFAULT_WIDTH)}
        onKeyDown={onKeyDown}
        title="Arraste para alargar ou estreitar · dois cliques voltam ao tamanho padrão"
        className="absolute inset-y-0 left-0 z-10 w-1.5 cursor-col-resize transition-colors hover:bg-primary/40 focus-visible:bg-primary/40 focus-visible:outline-none"
      />
      {children}
    </div>
  );
}
