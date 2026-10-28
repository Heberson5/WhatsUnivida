import { renderWhatsAppFormatting } from "../../lib/whatsappFormatting";

/**
 * Shows exactly what the customer's WhatsApp will render — the sender's
 * name (bold) + a blank line + the message body — same as this app builds
 * for every real send (see withSenderPrefix in whatsapp.service.ts), so an
 * admin editing a template never has to ask "como vai ficar" again. Reuses
 * renderWhatsAppFormatting (MessageBubble's own bold/italic/link parser) so
 * *asterisco* in the template really shows bold here, exactly as WhatsApp
 * itself would render it.
 */
export function AutoMessagePreview({ senderName, text }: { senderName: string | null; text: string }) {
  const fullText = senderName === null ? text : `*${senderName}:*\n\n${text}`;
  return (
    <div>
      <p className="mb-1 text-xs font-medium text-muted">Prévia de como o cliente vai receber:</p>
      <div className="max-w-sm whitespace-pre-wrap break-words rounded-card bg-primary px-3 py-2 text-sm text-primary-fg shadow-soft">
        {renderWhatsAppFormatting(fullText)}
      </div>
    </div>
  );
}

/** "Mostrar o nome do atendente no topo" — on by default; off sends the text alone. */
export function SenderNameToggle({ checked, onChange, note }: { checked: boolean; onChange: (checked: boolean) => void; note?: string }) {
  return (
    <label className="flex items-center justify-between gap-3 rounded-card border border-border px-3 py-2">
      <span>
        <span className="block text-sm font-medium">Mostrar o nome do atendente no topo</span>
        <span className="block text-xs text-muted">Desmarcado, o cliente recebe só o texto, sem o nome em negrito.</span>
        {note && <span className="block text-xs text-muted">{note}</span>}
      </span>
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} className="h-4 w-4 shrink-0 accent-primary" />
    </label>
  );
}
