import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import clsx from "clsx";
import { Copy, Plus, Trash2 } from "lucide-react";
import {
  BOLETO_BANK_CODES,
  BOLETO_BANKS,
  BOLETO_PAYMENT_PLACES,
  BOLETO_INSTRUCTION_TAGS,
  BOLETO_LAYOUT_MODELS,
  DEFAULT_BOLETO_LAYOUT_SETTINGS,
  PERMISSION,
  type BoletoInstructionDTO,
  type BoletoLayoutDTO,
  type BoletoLayoutInput,
  type BoletoLayoutModel,
  type BoletoLayoutSettings,
} from "@whatsatendende/types";
import { api, getApiErrorMessage } from "../../lib/api";
import { useAuthStore } from "../../store/auth-store";
import { TagButtons, insertTag } from "./TagButtons";

const PREVIEW_DEBOUNCE_MS = 600;
const inputClass = "focus-ring w-full rounded-card border border-border bg-transparent px-3 py-2 text-sm";
const DATE_OPTIONS = [
  { value: "PRINT", label: "Data da impressão" },
  { value: "BLANK", label: "Em branco" },
] as const;
const SHOW_OPTIONS: { key: keyof BoletoLayoutSettings; label: string }[] = [
  { key: "showLogo", label: "Logotipo do banco" },
  { key: "showPayerDocument", label: "CPF/CNPJ do sacado" },
  { key: "showPayerAddress", label: "Endereço do sacado" },
  { key: "showPayeeDocument", label: "CNPJ do cedente" },
  { key: "showGuarantor", label: "Sacador / Avalista" },
  { key: "highlight", label: "Destaque amarelo (vencimento e valor)" },
];

type Draft = BoletoLayoutInput & { id?: string };

const newDraft = (): Draft => ({ name: "", bankCode: "001", model: "CARNE", perPage: 3, settings: DEFAULT_BOLETO_LAYOUT_SETTINGS });
const toDraft = (layout: BoletoLayoutDTO): Draft => ({ id: layout.id, name: layout.name, bankCode: layout.bankCode, model: layout.model, perPage: layout.perPage, settings: layout.settings });
const toInput = ({ id: _id, ...input }: Draft): BoletoLayoutInput => ({ ...input, name: input.name.trim() });

/** The PDF of the layout being edited, with fictitious boletos — refreshed a moment after each change. */
function useLayoutPreview(input: BoletoLayoutInput | null) {
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const key = JSON.stringify(input);
  useEffect(() => {
    if (!input) return;
    let objectUrl: string | null = null;
    const timer = setTimeout(() => {
      api
        .post<Blob>("/boletos/layouts/preview", { ...input, name: input.name || "Prévia" }, { responseType: "blob" })
        .then((res) => {
          objectUrl = URL.createObjectURL(res.data);
          setUrl(objectUrl);
          setError(null);
        })
        .catch(() => setError("Não foi possível montar a prévia."));
    }, PREVIEW_DEBOUNCE_MS);
    return () => {
      clearTimeout(timer);
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return { url, error };
}

/** Dados › Layouts de boleto: how each bank's boleto PDF looks, grouped by bank, with a live preview. */
export function BoletoLayoutsPanel() {
  const queryClient = useQueryClient();
  const canEdit = useAuthStore((s) => Boolean(s.permissions?.[PERMISSION.FONTES_DADOS_EDITAR]));
  const { data: layouts } = useQuery({ queryKey: ["boleto-layouts"], queryFn: async () => (await api.get<BoletoLayoutDTO[]>("/boletos/layouts")).data });
  const { data: instructions } = useQuery({
    queryKey: ["boleto-instructions"],
    queryFn: async () => (await api.get<BoletoInstructionDTO[]>("/boletos/instructions")).data,
  });
  const [draft, setDraft] = useState<Draft | null>(null);
  const [instructionsEl, setInstructionsEl] = useState<HTMLTextAreaElement | null>(null);
  const [demonstrativeEl, setDemonstrativeEl] = useState<HTMLTextAreaElement | null>(null);
  const preview = useLayoutPreview(draft ? toInput(draft) : null);

  useEffect(() => {
    if (layouts && !draft && layouts[0]) setDraft(toDraft(layouts[0]));
  }, [layouts, draft]);

  const refresh = () => {
    queryClient.invalidateQueries({ queryKey: ["boleto-layouts"] });
    queryClient.invalidateQueries({ queryKey: ["boleto-instructions"] });
  };
  const saveMutation = useMutation({
    mutationFn: async (d: Draft) =>
      (d.id ? await api.put<BoletoLayoutDTO>(`/boletos/layouts/${d.id}`, toInput(d)) : await api.post<BoletoLayoutDTO>("/boletos/layouts", toInput(d))).data,
    onSuccess: (saved) => {
      refresh();
      setDraft(toDraft(saved));
      toast.success("Layout salvo.");
    },
    onError: (err) => toast.error(getApiErrorMessage(err)),
  });
  const deleteMutation = useMutation({
    mutationFn: (id: string) => api.delete(`/boletos/layouts/${id}`),
    onSuccess: () => {
      refresh();
      setDraft(null);
      toast.success("Layout excluído.");
    },
    onError: (err) => toast.error(getApiErrorMessage(err)),
  });

  const setSettings = (patch: Partial<BoletoLayoutSettings>) => draft && setDraft({ ...draft, settings: { ...draft.settings, ...patch } });
  const messageTags = instructions?.map((i) => `{mensagem:${i.name}}`) ?? [];
  const maxPerPage = draft ? BOLETO_LAYOUT_MODELS[draft.model].maxPerPage : 1;

  return (
    <div className="flex flex-col gap-4 xl:flex-row">
      <div className="shadow-soft shrink-0 space-y-2 rounded-card border border-border bg-surface p-3 xl:w-52">
        {canEdit && (
          <button onClick={() => setDraft(newDraft())} className="focus-ring inline-flex w-full items-center justify-center gap-1 rounded-card bg-primary px-3 py-2 text-sm font-semibold text-primary-fg">
            <Plus className="h-4 w-4" /> Novo layout
          </button>
        )}
        {BOLETO_BANK_CODES.map((code) => [code, BOLETO_BANKS[code]] as const).map(([code, bankName]) => (
          <div key={code}>
            <p className="px-1 pb-1 pt-2 text-[10.5px] font-semibold uppercase tracking-[0.06em] text-muted">
              {bankName} ({code})
            </p>
            {layouts
              ?.filter((l) => l.bankCode === code)
              .map((layout) => (
                <button
                  key={layout.id}
                  onClick={() => setDraft(toDraft(layout))}
                  className={clsx(
                    "focus-ring mb-1.5 block w-full rounded-card border px-3 py-2 text-left",
                    draft?.id === layout.id ? "border-primary bg-primary/10" : "border-border hover:bg-surface-alt"
                  )}
                >
                  <span className="block text-sm font-semibold">{layout.name}</span>
                  <span className="block text-xs text-muted">
                    {BOLETO_LAYOUT_MODELS[layout.model].label} · {layout.perPage} por página
                  </span>
                  {layout.usedBy.length > 0 && <span className="block text-xs text-success">Padrão em: {layout.usedBy.join(", ")}</span>}
                </button>
              ))}
          </div>
        ))}
      </div>

      {draft && (
        <div className="shadow-soft min-w-0 space-y-3 rounded-card border border-border bg-surface p-5 xl:w-[24rem] xl:shrink-0">
          <h2 className="text-base font-semibold">{draft.id ? draft.name || "Layout" : "Novo layout"}</h2>
          <fieldset disabled={!canEdit} className="space-y-3">
            <div className="grid gap-3 sm:grid-cols-2">
              <label className="block">
                <span className="mb-1 block text-sm font-medium">Nome</span>
                <input value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} maxLength={60} placeholder="Ex.: Boleto F" className={inputClass} />
              </label>
              <label className="block">
                <span className="mb-1 block text-sm font-medium">Banco</span>
                <select value={draft.bankCode} disabled={Boolean(draft.id)} onChange={(e) => {
                    // A new layout takes the payment place of its bank's manual, unless it was already changed.
                    const bankCode = e.target.value;
                    const keep = draft.settings.paymentPlace !== (BOLETO_PAYMENT_PLACES[draft.bankCode] ?? "");
                    setDraft({ ...draft, bankCode, settings: keep ? draft.settings : { ...draft.settings, paymentPlace: BOLETO_PAYMENT_PLACES[bankCode] ?? "" } });
                  }} className={inputClass}>
                  {BOLETO_BANK_CODES.map((code) => (
                    <option key={code} value={code}>
                      {BOLETO_BANKS[code]} ({code})
                    </option>
                  ))}
                </select>
              </label>
              <label className="block">
                <span className="mb-1 block text-sm font-medium">Modelo</span>
                <select
                  value={draft.model}
                  onChange={(e) => {
                    const model = e.target.value as BoletoLayoutModel;
                    setDraft({ ...draft, model, perPage: Math.min(draft.perPage, BOLETO_LAYOUT_MODELS[model].maxPerPage) });
                  }}
                  className={inputClass}
                >
                  {(Object.keys(BOLETO_LAYOUT_MODELS) as BoletoLayoutModel[]).map((model) => (
                    <option key={model} value={model}>
                      {BOLETO_LAYOUT_MODELS[model].label}
                    </option>
                  ))}
                </select>
              </label>
              <label className="block">
                <span className="mb-1 block text-sm font-medium">Boletos por página</span>
                <select value={draft.perPage} onChange={(e) => setDraft({ ...draft, perPage: Number(e.target.value) })} className={inputClass}>
                  {Array.from({ length: maxPerPage }, (_, i) => i + 1).map((n) => (
                    <option key={n} value={n}>
                      {n}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <label className="block">
              <span className="mb-1 block text-sm font-medium">Local de pagamento</span>
              <input value={draft.settings.paymentPlace} onChange={(e) => setSettings({ paymentPlace: e.target.value })} maxLength={200} className={inputClass} />
            </label>
            <div className="grid gap-3 sm:grid-cols-2">
              <label className="block">
                <span className="mb-1 block text-sm font-medium">Espécie Documento</span>
                <input value={draft.settings.documentKind} onChange={(e) => setSettings({ documentKind: e.target.value })} maxLength={10} className={inputClass} />
              </label>
              <label className="block">
                <span className="mb-1 block text-sm font-medium">Aceite</span>
                <input value={draft.settings.acceptance} onChange={(e) => setSettings({ acceptance: e.target.value })} maxLength={5} className={inputClass} />
              </label>
              <label className="block">
                <span className="mb-1 block text-sm font-medium">Data do Documento</span>
                <select value={draft.settings.documentDate} onChange={(e) => setSettings({ documentDate: e.target.value as "PRINT" | "BLANK" })} className={inputClass}>
                  {DATE_OPTIONS.map((o) => (
                    <option key={o.value} value={o.value}>
                      {o.label}
                    </option>
                  ))}
                </select>
              </label>
              <label className="block">
                <span className="mb-1 block text-sm font-medium">Data Process.</span>
                <select value={draft.settings.processDate} onChange={(e) => setSettings({ processDate: e.target.value as "PRINT" | "BLANK" })} className={inputClass}>
                  {DATE_OPTIONS.map((o) => (
                    <option key={o.value} value={o.value}>
                      {o.label}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <div>
              <p className="mb-1 text-sm font-medium">Mostrar no boleto</p>
              <div className="grid gap-1 sm:grid-cols-2">
                {SHOW_OPTIONS.map(({ key, label }) => (
                  <label key={key} className="flex items-center gap-2 text-sm">
                    <input type="checkbox" checked={Boolean(draft.settings[key])} onChange={(e) => setSettings({ [key]: e.target.checked })} className="h-4 w-4 accent-[var(--color-primary)]" />
                    {label}
                  </label>
                ))}
              </div>
            </div>
            <label className="block">
              <span className="mb-1 block text-sm font-medium">Quadro de instruções</span>
              <textarea
                ref={setInstructionsEl}
                rows={4}
                value={draft.settings.instructions}
                onChange={(e) => setSettings({ instructions: e.target.value })}
                placeholder="{mensagem:Instruções padrão}"
                className={clsx(inputClass, "font-mono text-xs")}
              />
              <span className="mt-1 block text-xs text-muted">Uma linha {"{mensagem:Nome}"} traz as linhas daquela mensagem (Dados › Mensagens do boleto). As outras linhas saem como escritas.</span>
            </label>
            {canEdit && (
              <TagButtons
                tags={[...messageTags, ...BOLETO_INSTRUCTION_TAGS]}
                onInsert={(tag) => insertTag(instructionsEl, draft.settings.instructions, tag, (instructions) => setSettings({ instructions }))}
              />
            )}
            {draft.model === "DEMONSTRATIVO" && (
              <>
                <label className="block">
                  <span className="mb-1 block text-sm font-medium">Demonstrativo (topo da página)</span>
                  <textarea
                    ref={setDemonstrativeEl}
                    rows={5}
                    value={draft.settings.demonstrative}
                    onChange={(e) => setSettings({ demonstrative: e.target.value })}
                    className={clsx(inputClass, "font-mono text-xs")}
                  />
                </label>
                {canEdit && (
                  <TagButtons
                    tags={[...messageTags, ...BOLETO_INSTRUCTION_TAGS]}
                    onInsert={(tag) => insertTag(demonstrativeEl, draft.settings.demonstrative, tag, (demonstrative) => setSettings({ demonstrative }))}
                  />
                )}
              </>
            )}
          </fieldset>
          {canEdit && (
            <div className="flex flex-wrap justify-between gap-2 pt-1">
              <div className="flex gap-2">
                {draft.id && (
                  <>
                    <button
                      type="button"
                      onClick={() => setDraft({ ...draft, id: undefined, name: `Cópia de ${draft.name}` })}
                      className="focus-ring inline-flex items-center gap-1 rounded-card border border-border px-3 py-2 text-sm hover:bg-surface-alt"
                    >
                      <Copy className="h-4 w-4" /> Duplicar
                    </button>
                    <button
                      type="button"
                      onClick={() => window.confirm(`Excluir o layout "${draft.name}"?`) && deleteMutation.mutate(draft.id!)}
                      className="focus-ring inline-flex items-center gap-1 rounded-card border border-border px-3 py-2 text-sm text-danger hover:bg-danger-soft"
                    >
                      <Trash2 className="h-4 w-4" /> Excluir
                    </button>
                  </>
                )}
              </div>
              <button
                type="button"
                onClick={() => saveMutation.mutate(draft)}
                disabled={saveMutation.isPending || !draft.name.trim()}
                className="focus-ring rounded-card bg-primary px-4 py-2 text-sm font-semibold text-primary-fg disabled:opacity-60"
              >
                Salvar layout
              </button>
            </div>
          )}
        </div>
      )}

      {draft && (
        <div className="shadow-soft flex min-h-[36rem] min-w-0 flex-1 flex-col rounded-card border border-border bg-surface p-3">
          <div className="mb-2 flex flex-wrap items-baseline justify-between gap-2">
            <h3 className="text-sm font-semibold">Prévia</h3>
            <span className="text-xs text-muted">
              Atualiza enquanto você edita · dados de exemplo
              {preview.url && (
                <>
                  {" · "}
                  <a href={preview.url} target="_blank" rel="noreferrer" className="text-primary hover:underline">
                    Abrir em tela cheia
                  </a>
                </>
              )}
            </span>
          </div>
          {preview.error && <p className="text-xs text-danger">{preview.error}</p>}
          {preview.url && <iframe title="Prévia do layout" src={`${preview.url}#toolbar=0&navpanes=0&view=FitH`} className="w-full flex-1 rounded border border-border bg-white" />}
        </div>
      )}
    </div>
  );
}
