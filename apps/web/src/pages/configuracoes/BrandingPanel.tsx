import { useEffect, useRef, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { PERMISSION } from "@whatsatendende/types";
import { useAuthStore } from "../../store/auth-store";
import { api, getApiErrorMessage } from "../../lib/api";
import { useBranding } from "../../hooks/useBranding";
import { UnsavedChangesBar } from "../../components/common/UnsavedChangesBar";

// Curated primary/secondary combinations — see PROMPT: "Nas configurações
// precisa ter paletas de cores para alterar quando o administrador desejar."
// Primaries stay dark/saturated enough for white button text
// (--color-primary-fg); secondaries stay light/pastel enough for the fixed
// dark --color-secondary-fg used on badges/pills throughout the app.
const COLOR_PALETTES: { name: string; primary: string; secondary: string }[] = [
  { name: "Teal & Amarelo", primary: "#0097B4", secondary: "#FFE450" },
  { name: "Roxo & Lilás", primary: "#6D28D9", secondary: "#E9D5FF" },
  { name: "Laranja & Pêssego", primary: "#EA580C", secondary: "#FED7AA" },
  { name: "Verde & Menta", primary: "#059669", secondary: "#A7F3D0" },
  { name: "Azul & Céu", primary: "#2563EB", secondary: "#BFDBFE" },
  { name: "Rosa & Rosa claro", primary: "#DB2777", secondary: "#FBCFE8" },
  { name: "Grafite & Cinza", primary: "#1E293B", secondary: "#E2E8F0" },
];

export function BrandingPanel() {
  const { data: branding } = useBranding();
  const queryClient = useQueryClient();
  const canEditar = useAuthStore((s) => s.permissions?.[PERMISSION.CONFIGURACOES_IDENTIDADE_EDITAR]);
  const [companyName, setCompanyName] = useState(branding?.companyName ?? "");
  const [primaryColor, setPrimaryColor] = useState(branding?.primaryColor ?? "#0097B4");
  const [secondaryColor, setSecondaryColor] = useState(branding?.secondaryColor ?? "#FFE450");
  // Off by default — the read-receipt tick already follows secondaryColor
  // automatically (see styles/index.css's --color-read-receipt fallback);
  // this only lets an admin override it when the secondary color is too
  // pastel/light to read clearly against a given primary.
  const [customReadReceipt, setCustomReadReceipt] = useState(Boolean(branding?.readReceiptColor));
  const [readReceiptColor, setReadReceiptColor] = useState(branding?.readReceiptColor ?? branding?.secondaryColor ?? "#FFE450");
  const logoInputRef = useRef<HTMLInputElement>(null);
  const faviconInputRef = useRef<HTMLInputElement>(null);

  const saveMutation = useMutation({
    mutationFn: (colors?: { primaryColor: string; secondaryColor: string }) =>
      api.patch("/settings/branding", {
        companyName,
        primaryColor: colors?.primaryColor ?? primaryColor,
        secondaryColor: colors?.secondaryColor ?? secondaryColor,
        readReceiptColor: customReadReceipt ? readReceiptColor : null,
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["branding"] });
      toast.success("Identidade visual atualizada.");
    },
    onError: (err) => toast.error(getApiErrorMessage(err)),
  });

  const dirty =
    Boolean(branding) &&
    (companyName !== (branding?.companyName ?? "") ||
      primaryColor.toLowerCase() !== (branding?.primaryColor ?? "").toLowerCase() ||
      secondaryColor.toLowerCase() !== (branding?.secondaryColor ?? "").toLowerCase() ||
      (customReadReceipt ? readReceiptColor.toLowerCase() : null) !== (branding?.readReceiptColor?.toLowerCase() ?? null));

  function discardChanges() {
    setCompanyName(branding?.companyName ?? "");
    setPrimaryColor(branding?.primaryColor ?? "#0097B4");
    setSecondaryColor(branding?.secondaryColor ?? "#FFE450");
    setCustomReadReceipt(Boolean(branding?.readReceiptColor));
    setReadReceiptColor(branding?.readReceiptColor ?? branding?.secondaryColor ?? "#FFE450");
  }

  // The form used to start empty when branding hadn't loaded yet at mount
  // (blank "Nome da empresa") — load it, and reload after every save.
  useEffect(() => {
    if (branding) discardChanges();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [branding]);

  function applyPalette(palette: { primary: string; secondary: string }) {
    setPrimaryColor(palette.primary);
    setSecondaryColor(palette.secondary);
    saveMutation.mutate({ primaryColor: palette.primary, secondaryColor: palette.secondary });
  }

  const logoMutation = useMutation({
    mutationFn: async (file: File) => {
      const form = new FormData();
      form.append("file", file);
      return api.post("/settings/branding/logo", form, { headers: { "Content-Type": "multipart/form-data" } });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["branding"] });
      toast.success("Logo atualizada.");
    },
  });

  const faviconMutation = useMutation({
    mutationFn: async (file: File) => {
      const form = new FormData();
      form.append("file", file);
      return api.post("/settings/branding/favicon", form, { headers: { "Content-Type": "multipart/form-data" } });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["branding"] });
      toast.success("Favicon atualizado.");
    },
  });

  return (
    <div className="shadow-soft max-w-xl rounded-card border border-border bg-surface p-6">
      <h2 className="mb-6 text-base font-semibold">Identidade visual</h2>

      <fieldset disabled={!canEditar} className="m-0 min-w-0 space-y-6 border-0 p-0">
      <div className="flex items-center gap-6">
        <div>
          <p className="mb-2 text-sm font-medium">Logo</p>
          {branding?.logoUrl && <img src={branding.logoUrl} alt="Logo atual" className="mb-2 h-14 w-14 rounded object-contain" />}
          <input ref={logoInputRef} type="file" accept="image/*" hidden onChange={(e) => e.target.files?.[0] && logoMutation.mutate(e.target.files[0])} />
          <button onClick={() => logoInputRef.current?.click()} className="focus-ring rounded-card border border-border px-3 py-1.5 text-xs font-medium hover:bg-surface-alt">
            Enviar logo
          </button>
        </div>
        <div>
          <p className="mb-2 text-sm font-medium">Favicon</p>
          {branding?.faviconUrl && <img src={branding.faviconUrl} alt="Favicon atual" className="mb-2 h-8 w-8 object-contain" />}
          <input ref={faviconInputRef} type="file" accept="image/*" hidden onChange={(e) => e.target.files?.[0] && faviconMutation.mutate(e.target.files[0])} />
          <button onClick={() => faviconInputRef.current?.click()} className="focus-ring rounded-card border border-border px-3 py-1.5 text-xs font-medium hover:bg-surface-alt">
            Enviar favicon
          </button>
        </div>
      </div>

      <label className="block">
        <span className="mb-1 block text-sm font-medium">Nome da empresa</span>
        <input value={companyName} onChange={(e) => setCompanyName(e.target.value)} className="focus-ring w-full rounded-card border border-border bg-transparent px-3 py-2 text-sm" />
      </label>

      <div>
        <p className="mb-2 text-sm font-medium">Paletas de cores</p>
        <div className="flex flex-wrap gap-2">
          {COLOR_PALETTES.map((palette) => {
            const active = primaryColor.toLowerCase() === palette.primary.toLowerCase() && secondaryColor.toLowerCase() === palette.secondary.toLowerCase();
            return (
              <button
                key={palette.name}
                onClick={() => applyPalette(palette)}
                title={palette.name}
                className={`focus-ring flex items-center gap-2 rounded-card border px-2.5 py-1.5 text-xs font-medium hover:bg-surface-alt ${active ? "border-primary" : "border-border"}`}
              >
                <span className="flex h-5 w-5 overflow-hidden rounded-full border border-border/50">
                  <span className="h-full w-1/2" style={{ backgroundColor: palette.primary }} />
                  <span className="h-full w-1/2" style={{ backgroundColor: palette.secondary }} />
                </span>
                {palette.name}
              </button>
            );
          })}
        </div>
      </div>

      <div className="flex flex-col gap-4 sm:flex-row">
        <label className="min-w-0 flex-1">
          <span className="mb-1 block text-sm font-medium">Cor principal</span>
          <div className="flex items-center gap-2">
            <input type="color" value={primaryColor} onChange={(e) => setPrimaryColor(e.target.value)} className="h-9 w-9 shrink-0 rounded border border-border" />
            <input value={primaryColor} onChange={(e) => setPrimaryColor(e.target.value)} className="focus-ring min-w-0 flex-1 rounded-card border border-border bg-transparent px-3 py-2 text-sm" />
          </div>
        </label>
        <label className="min-w-0 flex-1">
          <span className="mb-1 block text-sm font-medium">Cor secundária</span>
          <div className="flex items-center gap-2">
            <input type="color" value={secondaryColor} onChange={(e) => setSecondaryColor(e.target.value)} className="h-9 w-9 shrink-0 rounded border border-border" />
            <input value={secondaryColor} onChange={(e) => setSecondaryColor(e.target.value)} className="focus-ring min-w-0 flex-1 rounded-card border border-border bg-transparent px-3 py-2 text-sm" />
          </div>
        </label>
      </div>

      <div>
        <label className="flex items-center gap-2 text-sm font-medium">
          <input
            type="checkbox"
            checked={customReadReceipt}
            onChange={(e) => setCustomReadReceipt(e.target.checked)}
            className="focus-ring h-4 w-4 rounded border-border"
          />
          Personalizar cor do traço de mensagem lida
        </label>
        <p className="mb-2 mt-1 text-xs text-muted">Por padrão, o traço duplo de "lida" usa a cor secundária. Ative para escolher outra cor.</p>
        {customReadReceipt && (
          <div className="flex items-center gap-2">
            <input type="color" value={readReceiptColor} onChange={(e) => setReadReceiptColor(e.target.value)} className="h-9 w-9 shrink-0 rounded border border-border" />
            <input value={readReceiptColor} onChange={(e) => setReadReceiptColor(e.target.value)} className="focus-ring min-w-0 flex-1 rounded-card border border-border bg-transparent px-3 py-2 text-sm" />
          </div>
        )}
      </div>

      <button
        onClick={() => saveMutation.mutate(undefined)}
        disabled={saveMutation.isPending}
        className="focus-ring rounded-card bg-primary px-4 py-2 text-sm font-semibold text-primary-fg disabled:opacity-60"
      >
        Salvar identidade visual
      </button>
      </fieldset>
      {canEditar && (
        <UnsavedChangesBar dirty={dirty} saving={saveMutation.isPending} onSave={() => saveMutation.mutate(undefined)} onDiscard={discardChanges} />
      )}
    </div>
  );
}
