import { useEffect, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { toast } from "sonner";
import { AlertTriangle, Copy, FileText, QrCode, X } from "lucide-react";
import type { BoletoPreviewDTO } from "@whatsatendende/types";
import { api, getApiErrorMessage } from "../../lib/api";

/** Preview of the boletos (linha digitável of each) with the editable message; sending needs any overdue one confirmed. */
export function BoletoSendModal({ conversationId, parcelIds, onClose, onSent }: { conversationId: string; parcelIds: string[]; onClose: () => void; onSent: () => void }) {
  const [preview, setPreview] = useState<BoletoPreviewDTO | null>(null);
  const [message, setMessage] = useState("");
  const [confirmOverdue, setConfirmOverdue] = useState(false);
  // One boleto: its linha goes by default. Several in the same PDF: only if the attendant ticks it.
  const [sendLinhas, setSendLinhas] = useState(false);
  // Same for the PIX copia e cola — only offered when at least one of the boletos has PIX.
  const [sendPix, setSendPix] = useState(false);

  const previewMutation = useMutation({
    mutationFn: async () => (await api.post<BoletoPreviewDTO>(`/messages/conversations/${conversationId}/boletos/preview`, { parcelIds })).data,
    onSuccess: (data) => {
      setPreview(data);
      setMessage(data.message);
      setSendLinhas(data.items.length === 1);
      setSendPix(data.items.length === 1 && Boolean(data.items[0].pix));
    },
    onError: (err) => {
      toast.error(getApiErrorMessage(err));
      onClose();
    },
  });
  const sendMutation = useMutation({
    mutationFn: () => api.post(`/messages/conversations/${conversationId}/boletos/send`, { parcelIds, message, confirmOverdue, sendLinhas, sendPix }),
    onSuccess: () => {
      toast.success(parcelIds.length === 1 ? "Boleto enviado." : `${parcelIds.length} boletos enviados.`);
      onSent();
    },
    onError: (err) => toast.error(getApiErrorMessage(err)),
  });

  useEffect(() => {
    previewMutation.mutate();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const needsConfirm = Boolean(preview?.warnings.length);
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-4">
      <div className="flex max-h-[90vh] w-full max-w-lg flex-col rounded-card border border-border bg-surface shadow-elevated">
        <div className="flex items-center justify-between border-b border-border px-5 py-3">
          <h2 className="text-base font-semibold">Enviar boleto</h2>
          <button onClick={onClose} className="focus-ring rounded-full p-1 text-muted hover:bg-surface-alt" aria-label="Fechar">
            <X className="h-5 w-5" />
          </button>
        </div>
        <div className="flex-1 space-y-3 overflow-y-auto px-5 py-4 text-sm">
          {!preview && <p className="text-muted">Gerando os boletos...</p>}
          {preview?.items.map((item) => (
            <div key={item.parcelId} className="rounded-card border border-border p-3">
              <p className="flex items-center gap-1.5 font-medium">
                <FileText className="h-4 w-4 text-muted" /> Contrato {item.contract} · vencimento {item.due} · {item.value}
              </p>
              <p className="mt-1.5 flex items-center gap-1 break-all font-mono text-xs">
                {item.linha}
                <button
                  type="button"
                  onClick={() => navigator.clipboard.writeText(item.linha).then(() => toast.success("Linha copiada."))}
                  className="focus-ring shrink-0 rounded p-0.5 text-muted hover:text-[var(--color-text)]"
                  aria-label="Copiar linha digitável"
                >
                  <Copy className="h-3 w-3" />
                </button>
              </p>
              {item.pix && (
                <p className="mt-1.5 flex items-center gap-1 text-xs">
                  <QrCode className="h-3.5 w-3.5 shrink-0 text-muted" />
                  <span className="font-medium">Pague via PIX</span>
                  <span className="min-w-0 truncate font-mono text-muted" title={item.pix}>
                    {item.pix}
                  </span>
                  <button
                    type="button"
                    onClick={() => navigator.clipboard.writeText(item.pix!).then(() => toast.success("PIX copia e cola copiado."))}
                    className="focus-ring shrink-0 rounded p-0.5 text-muted hover:text-[var(--color-text)]"
                    aria-label="Copiar PIX copia e cola"
                  >
                    <Copy className="h-3 w-3" />
                  </button>
                </p>
              )}
            </div>
          ))}
          {preview && preview.warnings.length > 0 && (
            <div className="space-y-1 rounded-card border border-warning bg-warning-soft p-3 text-xs">
              {preview.warnings.map((w) => (
                <p key={w} className="flex items-start gap-1.5 font-medium">
                  <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-warning" /> {w}
                </p>
              ))}
              <label className="mt-1 flex items-center gap-2">
                <input type="checkbox" checked={confirmOverdue} onChange={(e) => setConfirmOverdue(e.target.checked)} className="h-4 w-4 accent-[var(--color-primary)]" />
                Entendi, enviar mesmo assim (o vencimento não muda)
              </label>
            </div>
          )}
          {preview && (
            <label className="block">
              <span className="mb-1 block font-medium">Mensagem</span>
              <textarea value={message} onChange={(e) => setMessage(e.target.value)} rows={4} className="focus-ring w-full rounded-card border border-border bg-transparent px-3 py-2 text-sm" />
              <span className="mt-1 block text-xs text-muted">
                Vai como comentário do PDF{preview.items.length > 1 ? `, que leva os ${preview.items.length} boletos (até 3 por página)` : ""}.
              </span>
            </label>
          )}
          {preview && (
            <label className="flex items-start gap-2">
              <input type="checkbox" checked={sendLinhas} onChange={(e) => setSendLinhas(e.target.checked)} className="mt-0.5 h-4 w-4 accent-[var(--color-primary)]" />
              <span>
                {preview.items.length > 1 ? "Enviar também a linha digitável de cada boleto, cada uma numa mensagem" : "Enviar também a linha digitável numa mensagem"}
                <span className="block text-xs text-muted">Só os números, prontos para colar no aplicativo do banco. O cliente não vê o nome do atendente nela.</span>
              </span>
            </label>
          )}
          {preview?.items.some((item) => item.pix) && (
            <label className="flex items-start gap-2">
              <input type="checkbox" checked={sendPix} onChange={(e) => setSendPix(e.target.checked)} className="mt-0.5 h-4 w-4 accent-[var(--color-primary)]" />
              <span>
                {preview.items.length > 1 ? "Enviar também o PIX copia e cola de cada boleto com PIX, cada um numa mensagem" : "Enviar também o PIX copia e cola numa mensagem"}
                <span className="block text-xs text-muted">O código para colar em “PIX copia e cola” no aplicativo do banco. O QR Code já vai impresso no boleto.</span>
              </span>
            </label>
          )}
        </div>
        <div className="flex justify-end gap-2 border-t border-border px-5 py-3">
          <button onClick={onClose} className="focus-ring rounded-card px-3 py-2 text-sm hover:bg-surface-alt">
            Cancelar
          </button>
          <button
            onClick={() => sendMutation.mutate()}
            disabled={!preview || sendMutation.isPending || (needsConfirm && !confirmOverdue)}
            className="focus-ring rounded-card bg-primary px-4 py-2 text-sm font-semibold text-primary-fg disabled:opacity-60"
          >
            {sendMutation.isPending ? "Enviando..." : "Enviar"}
          </button>
        </div>
      </div>
    </div>
  );
}
