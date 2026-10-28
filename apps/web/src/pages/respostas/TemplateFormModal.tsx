import { useRef, useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Megaphone, Settings2, ShieldCheck, Trash2, X } from "lucide-react";
import { toast } from "sonner";
import type { MessageTemplateButton, MessageTemplateCategory, MessageTemplateHeaderType } from "@whatsatendende/types";
import { api, getApiErrorMessage } from "../../lib/api";
import { renderWhatsAppFormatting } from "../../lib/whatsappFormatting";

interface OfficialConnectionOption {
  id: string;
  name: string;
  connectionMode: "QRCODE" | "OFFICIAL_API";
}

const CATEGORY_OPTIONS: { value: MessageTemplateCategory; label: string; description: string; icon: typeof Megaphone }[] = [
  { value: "MARKETING", label: "Marketing", description: "Promoções, novidades e ofertas.", icon: Megaphone },
  { value: "UTILITY", label: "Utilidade", description: "Atualização de pedido, cobrança, suporte.", icon: Settings2 },
  { value: "AUTHENTICATION", label: "Autenticação", description: "Código de verificação (OTP).", icon: ShieldCheck },
];

const HEADER_OPTIONS: { value: MessageTemplateHeaderType; label: string }[] = [
  { value: "NONE", label: "Nenhum" },
  { value: "TEXT", label: "Texto" },
  { value: "IMAGE", label: "Imagem" },
  { value: "VIDEO", label: "Vídeo" },
  { value: "DOCUMENT", label: "Documento" },
];

// Mesmos limites reais da Meta aplicados no backend (message-templates.routes.ts) — exibidos aqui só como orientação.
const HEADER_SAMPLE_HINT: Record<string, string> = {
  IMAGE: "JPG ou PNG, até 5MB",
  VIDEO: "MP4, até 16MB",
  DOCUMENT: "PDF, até 100MB",
};
const HEADER_SAMPLE_ACCEPT: Record<string, string> = {
  IMAGE: "image/jpeg,image/png",
  VIDEO: "video/mp4",
  DOCUMENT: "application/pdf",
};

const VARIABLE_TAGS = ["{{1}}", "{{2}}", "{{3}}"];

// Campo de idioma oculto do cadastro — ver PROMPT: "nao quero que tenha o
// campo de idioma, isso tem que estar oculto, cadastrado como padrão para
// todas as templates". Único idioma usado neste projeto.
const DEFAULT_LANGUAGE = "pt_BR";

type ButtonDraft = MessageTemplateButton;

export function TemplateFormModal({ onClose }: { onClose: () => void }) {
  const queryClient = useQueryClient();

  const { data: connections } = useQuery({
    queryKey: ["whatsapp-connections"],
    queryFn: async () => (await api.get<OfficialConnectionOption[]>("/whatsapp/connections")).data,
  });
  const officialConnections = connections?.filter((c) => c.connectionMode === "OFFICIAL_API") ?? [];

  const [name, setName] = useState("");
  const [category, setCategory] = useState<MessageTemplateCategory>("MARKETING");
  const [whatsappConnectionId, setWhatsappConnectionId] = useState("");
  const [headerType, setHeaderType] = useState<MessageTemplateHeaderType>("NONE");
  const [headerText, setHeaderText] = useState("");
  const [headerSample, setHeaderSample] = useState<File | null>(null);
  const [bodyText, setBodyText] = useState("");
  const [footerText, setFooterText] = useState("");
  const [buttons, setButtons] = useState<ButtonDraft[]>([]);
  const [error, setError] = useState<string | null>(null);
  const bodyRef = useRef<HTMLTextAreaElement | null>(null);

  function insertVariable(tag: string) {
    const el = bodyRef.current;
    if (!el) {
      setBodyText((t) => t + tag);
      return;
    }
    const start = el.selectionStart ?? bodyText.length;
    const end = el.selectionEnd ?? bodyText.length;
    const next = bodyText.slice(0, start) + tag + bodyText.slice(end);
    setBodyText(next);
    requestAnimationFrame(() => {
      el.focus();
      el.setSelectionRange(start + tag.length, start + tag.length);
    });
  }

  function addButton() {
    if (buttons.length >= 3) return;
    setButtons((b) => [...b, { type: "QUICK_REPLY", text: "" }]);
  }

  function removeButton(index: number) {
    setButtons((b) => b.filter((_, i) => i !== index));
  }

  function updateButton(index: number, next: ButtonDraft) {
    setButtons((b) => b.map((btn, i) => (i === index ? next : btn)));
  }

  const createMutation = useMutation({
    mutationFn: async () => {
      const form = new FormData();
      form.append("name", name.trim());
      form.append("category", category);
      form.append("language", DEFAULT_LANGUAGE);
      form.append("headerType", headerType);
      if (headerType === "TEXT" && headerText.trim()) form.append("headerText", headerText.trim());
      form.append("bodyText", bodyText.trim());
      if (footerText.trim()) form.append("footerText", footerText.trim());
      if (buttons.length > 0) form.append("buttons", JSON.stringify(buttons));
      form.append("whatsappConnectionId", whatsappConnectionId);
      if (headerSample) form.append("headerSample", headerSample);
      return api.post("/message-templates", form, { headers: { "Content-Type": "multipart/form-data" } });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["message-templates"] });
      toast.success("Template enviado para aprovação da Meta.");
      onClose();
    },
    onError: (err) => setError(getApiErrorMessage(err)),
  });

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    if ((headerType === "IMAGE" || headerType === "VIDEO" || headerType === "DOCUMENT") && !headerSample) {
      setError("Envie o arquivo de amostra para este tipo de cabeçalho.");
      return;
    }
    createMutation.mutate();
  }

  const previewHeader = headerType === "TEXT" && headerText ? `*${headerText}*\n\n` : "";
  const previewFooter = footerText ? `\n\n${footerText}` : "";
  const previewText = `${previewHeader}${bodyText || "..."}${previewFooter}`;

  return (
    <div className="drawer-backdrop">
      <form onSubmit={handleSubmit} className="drawer-panel max-w-lg overflow-y-auto p-5">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-base font-semibold">Novo template</h2>
          <button type="button" onClick={onClose} className="focus-ring rounded-full p-1 text-muted hover:bg-surface-alt" aria-label="Fechar">
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="flex-1 space-y-4 overflow-y-auto">
          <Field label="Conexão WhatsApp Oficial">
            <select
              required
              value={whatsappConnectionId}
              onChange={(e) => setWhatsappConnectionId(e.target.value)}
              className="focus-ring w-full rounded-card border border-border bg-transparent px-3 py-2 text-sm"
            >
              <option value="" disabled>
                Selecione...
              </option>
              {officialConnections.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
            {officialConnections.length === 0 && (
              <p className="mt-1 text-xs text-amber-600">Cadastre uma conexão WhatsApp Oficial em Conexões antes de criar um template.</p>
            )}
          </Field>

          <div>
            <span className="mb-1.5 block text-sm font-medium">Categoria</span>
            <div className="grid grid-cols-3 gap-2">
              {CATEGORY_OPTIONS.map((opt) => (
                <button
                  key={opt.value}
                  type="button"
                  onClick={() => setCategory(opt.value)}
                  className={`focus-ring flex flex-col items-center gap-1 rounded-card border px-2 py-2.5 text-center ${
                    category === opt.value ? "border-primary bg-primary/10" : "border-border hover:bg-surface-alt"
                  }`}
                >
                  <opt.icon className="h-4 w-4" />
                  <span className="text-xs font-semibold">{opt.label}</span>
                  <span className="text-[10px] leading-tight text-muted">{opt.description}</span>
                </button>
              ))}
            </div>
          </div>

          <Field label="Nome (identificador)">
            <input
              required
              value={name}
              onChange={(e) => setName(e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, "_"))}
              placeholder="ex: boas_vindas_promocao"
              className="focus-ring w-full rounded-card border border-border bg-transparent px-3 py-2 font-mono text-sm"
            />
          </Field>

          <div>
            <span className="mb-1.5 block text-sm font-medium">Cabeçalho</span>
            <div className="mb-2 flex flex-wrap gap-1.5">
              {HEADER_OPTIONS.map((opt) => (
                <button
                  key={opt.value}
                  type="button"
                  onClick={() => {
                    setHeaderType(opt.value);
                    setHeaderSample(null);
                  }}
                  className={`focus-ring rounded-full px-3 py-1 text-xs font-medium ${
                    headerType === opt.value ? "bg-primary text-primary-fg" : "bg-secondary/30 text-text hover:bg-secondary/50"
                  }`}
                >
                  {opt.label}
                </button>
              ))}
            </div>
            {headerType === "TEXT" && (
              <input
                value={headerText}
                onChange={(e) => setHeaderText(e.target.value)}
                maxLength={60}
                placeholder="Texto curto do cabeçalho"
                className="focus-ring w-full rounded-card border border-border bg-transparent px-3 py-2 text-sm"
              />
            )}
            {(headerType === "IMAGE" || headerType === "VIDEO" || headerType === "DOCUMENT") && (
              <div>
                <input
                  required
                  type="file"
                  accept={HEADER_SAMPLE_ACCEPT[headerType]}
                  onChange={(e) => setHeaderSample(e.target.files?.[0] ?? null)}
                  className="focus-ring w-full rounded-card border border-border bg-transparent px-3 py-1.5 text-sm"
                />
                <p className="mt-1 text-xs text-muted">Arquivo de amostra exigido pela Meta para aprovação — {HEADER_SAMPLE_HINT[headerType]}.</p>
              </div>
            )}
          </div>

          <div>
            <div className="mb-1 flex items-center justify-between">
              <span className="text-sm font-medium">Corpo da mensagem</span>
              <div className="flex gap-1">
                {VARIABLE_TAGS.map((tag) => (
                  <button
                    key={tag}
                    type="button"
                    onClick={() => insertVariable(tag)}
                    title={`Inserir variável ${tag}`}
                    className="focus-ring rounded-full bg-secondary/30 px-2 py-0.5 text-[11px] font-medium text-text hover:bg-secondary/50"
                  >
                    {tag}
                  </button>
                ))}
              </div>
            </div>
            <textarea
              ref={bodyRef}
              required
              rows={4}
              maxLength={1024}
              value={bodyText}
              onChange={(e) => setBodyText(e.target.value)}
              placeholder="Olá {{1}}, sua encomenda já está a caminho!"
              className="focus-ring w-full resize-none rounded-card border border-border bg-transparent px-3 py-2 text-sm"
            />
            <p className="mt-1 text-xs text-muted">Use *asterisco* pra negrito. As variáveis {"{{1}}"}, {"{{2}}"}... são substituídas ao enviar.</p>
          </div>

          <Field label="Rodapé (opcional)">
            <input
              value={footerText}
              onChange={(e) => setFooterText(e.target.value)}
              maxLength={60}
              placeholder="Ex: Esta é uma mensagem automática"
              className="focus-ring w-full rounded-card border border-border bg-transparent px-3 py-2 text-sm"
            />
          </Field>

          <div>
            <div className="mb-1.5 flex items-center justify-between">
              <span className="text-sm font-medium">Botões (opcional)</span>
              {buttons.length < 3 && (
                <button type="button" onClick={addButton} className="focus-ring text-xs font-medium text-primary hover:underline">
                  + Adicionar botão
                </button>
              )}
            </div>
            <div className="space-y-2">
              {buttons.map((btn, i) => (
                <div key={i} className="flex items-center gap-1.5 rounded-card border border-border p-2">
                  <select
                    value={btn.type}
                    onChange={(e) => {
                      const type = e.target.value as ButtonDraft["type"];
                      if (type === "QUICK_REPLY") updateButton(i, { type, text: btn.text });
                      else if (type === "URL") updateButton(i, { type, text: btn.text, url: "" });
                      else updateButton(i, { type, text: btn.text, phoneNumber: "" });
                    }}
                    className="focus-ring rounded-card border border-border bg-transparent px-1.5 py-1 text-xs"
                  >
                    <option value="QUICK_REPLY">Resposta rápida</option>
                    <option value="URL">Link</option>
                    <option value="PHONE_NUMBER">Telefone</option>
                  </select>
                  <input
                    required
                    value={btn.text}
                    onChange={(e) => updateButton(i, { ...btn, text: e.target.value })}
                    maxLength={25}
                    placeholder="Texto do botão"
                    className="focus-ring min-w-0 flex-1 rounded-card border border-border bg-transparent px-2 py-1 text-xs"
                  />
                  {btn.type === "URL" && (
                    <input
                      required
                      value={btn.url}
                      onChange={(e) => updateButton(i, { ...btn, url: e.target.value })}
                      placeholder="https://..."
                      className="focus-ring min-w-0 flex-1 rounded-card border border-border bg-transparent px-2 py-1 text-xs"
                    />
                  )}
                  {btn.type === "PHONE_NUMBER" && (
                    <input
                      required
                      value={btn.phoneNumber}
                      onChange={(e) => updateButton(i, { ...btn, phoneNumber: e.target.value })}
                      placeholder="+55..."
                      className="focus-ring min-w-0 flex-1 rounded-card border border-border bg-transparent px-2 py-1 text-xs"
                    />
                  )}
                  <button type="button" onClick={() => removeButton(i)} className="focus-ring shrink-0 rounded-card p-1 text-muted hover:bg-danger-soft hover:text-danger">
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </div>
              ))}
            </div>
          </div>

          <div>
            <p className="mb-1 text-xs font-medium text-muted">Prévia de como o cliente vai receber:</p>
            <div className="max-w-sm whitespace-pre-wrap break-words rounded-card bg-primary px-3 py-2 text-sm text-primary-fg shadow-soft">
              {renderWhatsAppFormatting(previewText)}
            </div>
            {buttons.length > 0 && (
              <div className="mt-1.5 flex max-w-sm flex-col gap-1">
                {buttons.map((btn, i) => (
                  <div key={i} className="rounded-card border border-border bg-surface px-3 py-1.5 text-center text-sm text-primary">
                    {btn.text || "Botão"}
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

        {error && <p className="mt-3 rounded-card bg-danger-soft px-3 py-2 text-sm text-danger">{error}</p>}

        <div className="mt-5 flex gap-2">
          <button type="button" onClick={onClose} className="focus-ring flex-1 rounded-card border border-border py-2 text-sm">
            Cancelar
          </button>
          <button
            type="submit"
            disabled={createMutation.isPending || officialConnections.length === 0}
            className="focus-ring flex-1 rounded-card bg-primary py-2 text-sm font-semibold text-primary-fg disabled:opacity-60"
          >
            {createMutation.isPending ? "Enviando..." : "Enviar para aprovação"}
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
