import { useState, type FormEvent } from "react";
import { useQuery } from "@tanstack/react-query";
import { X } from "lucide-react";
import type { QuickReplyDTO } from "@whatsunivida/types";
import { api } from "../../lib/api";

export interface QuickReplyFormValues {
  name: string;
  shortcut: string;
  text: string;
  whatsappConnectionId: string;
}

interface ConnectionOption {
  id: string;
  name: string;
}

export function QuickReplyFormModal({
  quickReply,
  onClose,
  onSubmit,
}: {
  quickReply: QuickReplyDTO | null;
  onClose: () => void;
  onSubmit: (values: QuickReplyFormValues) => Promise<void>;
}) {
  const { data: connections } = useQuery({
    queryKey: ["whatsapp-connections"],
    queryFn: async () => (await api.get<ConnectionOption[]>("/whatsapp/connections")).data,
  });

  const [values, setValues] = useState<QuickReplyFormValues>({
    name: quickReply?.name ?? "",
    shortcut: quickReply?.shortcut ?? "",
    text: quickReply?.text ?? "",
    whatsappConnectionId: quickReply?.whatsappConnectionId ?? "",
  });
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    if (!values.whatsappConnectionId) {
      setError("Selecione a conexão de WhatsApp");
      return;
    }
    setLoading(true);
    try {
      await onSubmit(values);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Erro ao salvar resposta rápida");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-4">
      <form onSubmit={handleSubmit} className="w-full max-w-md rounded-card border border-border bg-surface p-5 shadow-elevated">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-base font-semibold">{quickReply ? "Editar resposta rápida" : "Nova resposta rápida"}</h2>
          <button type="button" onClick={onClose} className="focus-ring rounded-full p-1 text-muted hover:bg-surface-alt" aria-label="Fechar">
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="space-y-3">
          <Field label="Nome">
            <input
              required
              value={values.name}
              onChange={(e) => setValues((v) => ({ ...v, name: e.target.value }))}
              placeholder="Ex: Boas-vindas"
              className="focus-ring w-full rounded-card border border-border bg-transparent px-3 py-2 text-sm"
            />
          </Field>

          <Field label="Atalho">
            <div className="flex items-center">
              <span className="rounded-l-card border border-r-0 border-border bg-surface-alt px-3 py-2 text-sm text-muted">/</span>
              <input
                required
                value={values.shortcut.replace(/^\/+/, "")}
                onChange={(e) => setValues((v) => ({ ...v, shortcut: e.target.value.replace(/\s+/g, "") }))}
                placeholder="boasvindas"
                className="focus-ring w-full rounded-r-card border border-border bg-transparent px-3 py-2 text-sm"
              />
            </div>
            <p className="mt-1 text-xs text-muted">Digitado pelo atendente na conversa (ex: "/{values.shortcut.replace(/^\/+/, "") || "boasvindas"}") para inserir o texto abaixo.</p>
          </Field>

          <Field label="Conexão de WhatsApp">
            <select
              required
              value={values.whatsappConnectionId}
              onChange={(e) => setValues((v) => ({ ...v, whatsappConnectionId: e.target.value }))}
              className="focus-ring w-full rounded-card border border-border bg-transparent px-3 py-2 text-sm"
            >
              <option value="" disabled>
                Selecione...
              </option>
              {connections?.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
            <p className="mt-1 text-xs text-muted">Só aparecerá no "/" para atendentes desta conexão.</p>
            {connections?.length === 0 && (
              <p className="mt-1 text-xs text-muted">Nenhuma conexão cadastrada — crie uma em Configurações → WhatsApp primeiro.</p>
            )}
          </Field>

          <Field label="Texto">
            <textarea
              required
              rows={5}
              value={values.text}
              onChange={(e) => setValues((v) => ({ ...v, text: e.target.value }))}
              placeholder="Texto que será inserido no campo de mensagem..."
              className="focus-ring w-full resize-none rounded-card border border-border bg-transparent px-3 py-2 text-sm"
            />
          </Field>
        </div>

        {error && <p className="mt-3 rounded-card bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}

        <div className="mt-5 flex gap-2">
          <button type="button" onClick={onClose} className="focus-ring flex-1 rounded-card border border-border py-2 text-sm">
            Cancelar
          </button>
          <button type="submit" disabled={loading} className="focus-ring flex-1 rounded-card bg-primary py-2 text-sm font-semibold text-primary-fg disabled:opacity-60">
            {loading ? "Salvando..." : "Salvar"}
          </button>
        </div>
      </form>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 block text-sm font-medium">{label}</span>
      {children}
    </label>
  );
}
