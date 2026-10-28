import { useEffect, useState, type KeyboardEvent, type MouseEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";
import { formatPhone } from "../../lib/format-phone";

/**
 * A customer's profile photo that opens big on click, like WhatsApp Web — without a download button, right-click
 * menu ("Salvar/Copiar imagem"), dragging or selecting. Wraps the avatar the screen already draws; with no photo
 * it is just the avatar (initials don't open).
 */
export function ContactPhoto({ photoUrl, name, phone, children }: { photoUrl: string | null | undefined; name: string; phone?: string | null; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  if (!photoUrl) return <>{children}</>;

  function show(e: MouseEvent | KeyboardEvent) {
    // The avatar often sits inside a clickable card/row — opening the photo must not also open the conversation.
    e.stopPropagation();
    e.preventDefault();
    setOpen(true);
  }

  return (
    <>
      <span
        role="button"
        tabIndex={0}
        onClick={show}
        onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && show(e)}
        className="focus-ring inline-flex shrink-0 cursor-zoom-in rounded-full"
        aria-label={`Ver a foto de ${name}`}
        title="Ver foto"
      >
        {children}
      </span>
      {open && <PhotoViewer photoUrl={photoUrl} name={name} subtitle={phone ? formatPhone(phone) : null} onClose={() => setOpen(false)} />}
    </>
  );
}

function PhotoViewer({ photoUrl, name, subtitle, onClose }: { photoUrl: string; name: string; subtitle?: string | null; onClose: () => void }) {
  useEffect(() => {
    function onKey(e: globalThis.KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      aria-label={`Foto de ${name}`}
      className="fixed inset-0 z-[100] flex select-none flex-col bg-black/90 text-white"
      onClick={(e) => {
        e.stopPropagation();
        onClose();
      }}
      onContextMenu={(e) => e.preventDefault()}
      onDragStart={(e) => e.preventDefault()}
      onCopy={(e) => e.preventDefault()}
    >
      <div className="flex items-center justify-between gap-3 px-4 py-3 sm:px-6">
        <div className="min-w-0">
          <p className="truncate text-[15px] font-semibold">{name}</p>
          {subtitle && <p className="truncate text-xs text-white/70">{subtitle}</p>}
        </div>
        <button type="button" onClick={onClose} className="focus-ring shrink-0 rounded-full bg-white/10 p-2 hover:bg-white/20" aria-label="Fechar">
          <X className="h-5 w-5" />
        </button>
      </div>
      <div className="flex min-h-0 flex-1 items-center justify-center p-4 pb-10">
        <img
          src={photoUrl}
          alt={`Foto de ${name}`}
          draggable={false}
          onClick={(e) => e.stopPropagation()}
          className="max-h-full max-w-full rounded object-contain shadow-2xl"
        />
      </div>
    </div>,
    document.body
  );
}
