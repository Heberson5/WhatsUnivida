import { useEffect, useRef, useState } from "react";
import { Download, Minus, Plus, X } from "lucide-react";

export interface LightboxMedia {
  url: string;
  kind: "IMAGE" | "VIDEO";
  fileName: string;
}

/** Full-screen image/video viewer with zoom + pan for images, opened from a message bubble's attachment — mirrors WhatsApp Web's media viewer. */
export function MediaLightbox({ media, onClose }: { media: LightboxMedia; onClose: () => void }) {
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const dragRef = useRef<{ startX: number; startY: number; panX: number; panY: number } | null>(null);

  useEffect(() => {
    function handleKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
      if (e.key === "+" || e.key === "=") setZoom((z) => Math.min(z + 0.25, 4));
      if (e.key === "-") setZoom((z) => Math.max(z - 0.25, 1));
    }
    document.addEventListener("keydown", handleKey);
    return () => document.removeEventListener("keydown", handleKey);
  }, [onClose]);

  function handleWheel(e: React.WheelEvent) {
    if (media.kind !== "IMAGE") return;
    e.preventDefault();
    setZoom((z) => Math.min(Math.max(z - e.deltaY * 0.001, 1), 4));
  }

  function handleMouseDown(e: React.MouseEvent) {
    if (zoom <= 1) return;
    dragRef.current = { startX: e.clientX, startY: e.clientY, panX: pan.x, panY: pan.y };
  }
  function handleMouseMove(e: React.MouseEvent) {
    if (!dragRef.current) return;
    const dx = e.clientX - dragRef.current.startX;
    const dy = e.clientY - dragRef.current.startY;
    setPan({ x: dragRef.current.panX + dx, y: dragRef.current.panY + dy });
  }
  function stopDrag() {
    dragRef.current = null;
  }

  function resetZoom() {
    setZoom(1);
    setPan({ x: 0, y: 0 });
  }

  return (
    <div className="fixed inset-0 z-[60] flex flex-col bg-black/90" onClick={onClose}>
      <div className="flex items-center justify-between px-4 py-3 text-white" onClick={(e) => e.stopPropagation()}>
        <p className="truncate text-sm">{media.fileName}</p>
        <div className="flex items-center gap-2">
          {media.kind === "IMAGE" && (
            <>
              <button onClick={() => setZoom((z) => Math.max(z - 0.25, 1))} className="focus-ring rounded-full p-2 hover:bg-white/10" aria-label="Diminuir zoom">
                <Minus className="h-4 w-4" />
              </button>
              <span className="w-12 text-center text-xs">{Math.round(zoom * 100)}%</span>
              <button onClick={() => setZoom((z) => Math.min(z + 0.25, 4))} className="focus-ring rounded-full p-2 hover:bg-white/10" aria-label="Aumentar zoom">
                <Plus className="h-4 w-4" />
              </button>
            </>
          )}
          <a href={media.url} download={media.fileName} className="focus-ring rounded-full p-2 hover:bg-white/10" aria-label="Baixar" onClick={(e) => e.stopPropagation()}>
            <Download className="h-4 w-4" />
          </a>
          <button onClick={onClose} className="focus-ring rounded-full p-2 hover:bg-white/10" aria-label="Fechar">
            <X className="h-4 w-4" />
          </button>
        </div>
      </div>

      <div
        className="flex flex-1 items-center justify-center overflow-hidden"
        onClick={(e) => e.stopPropagation()}
        onWheel={handleWheel}
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={stopDrag}
        onMouseLeave={stopDrag}
      >
        {media.kind === "IMAGE" ? (
          <img
            src={media.url}
            alt={media.fileName}
            onDoubleClick={() => (zoom > 1 ? resetZoom() : setZoom(2))}
            style={{ transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`, cursor: zoom > 1 ? "grab" : "zoom-in" }}
            className="max-h-[85vh] max-w-[90vw] select-none object-contain transition-transform duration-100"
            draggable={false}
          />
        ) : (
          <video src={media.url} controls autoPlay className="max-h-[85vh] max-w-[90vw]" />
        )}
      </div>
    </div>
  );
}
