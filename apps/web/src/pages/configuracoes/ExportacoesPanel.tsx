import { useRef, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Presentation, FileSpreadsheet } from "lucide-react";
import { PERMISSION } from "@whatsatendende/types";
import { useAuthStore } from "../../store/auth-store";
import { api, getApiErrorMessage } from "../../lib/api";
import { useExportBranding } from "../../hooks/useExportBranding";
import { darken, lighten } from "../../lib/chart-theme";
import { UnsavedChangesBar } from "../../components/common/UnsavedChangesBar";

const SAMPLE_ROWS = [
  ["26/09 09:14", "Maria Cliente", "Ana", "Encerrada"],
  ["26/09 10:02", "João Cliente", "Carlos", "Em atendimento"],
];

/**
 * Own logo/nome/cor for the PowerPoint cover and PDF/Excel reports, with a
 * live preview — deliberately independent from Identidade visual (that one
 * drives the in-app theme; this one only drives exported files). See
 * PROMPT: "Na guia Exportações, eu quero poder editar, trocando logo, cor
 * etc. Não é para ter vínculo com a Identidade Visual."
 */
export function ExportacoesPanel() {
  const { data: exportBranding } = useExportBranding();
  const queryClient = useQueryClient();
  const canEditar = useAuthStore((s) => s.permissions?.[PERMISSION.CONFIGURACOES_IDENTIDADE_EDITAR]);
  const [companyName, setCompanyName] = useState(exportBranding?.companyName ?? "");
  const [primaryColor, setPrimaryColor] = useState(exportBranding?.primaryColor ?? "#0097B4");
  const logoInputRef = useRef<HTMLInputElement>(null);
  const initialized = useRef(false);

  if (exportBranding && !initialized.current) {
    initialized.current = true;
    setCompanyName(exportBranding.companyName);
    setPrimaryColor(exportBranding.primaryColor);
  }

  // The presentation cover's own shades (see palette() in lib/dashboardPresentation.ts).
  const coverDark = darken(primaryColor, 0.66);
  const coverMid = lighten(primaryColor, 0.45);
  const logoUrl = exportBranding?.logoUrl ?? null;

  const saveMutation = useMutation({
    mutationFn: () => api.patch("/settings/export-branding", { companyName, primaryColor }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["export-branding"] });
      toast.success("Identidade de exportação atualizada.");
    },
    onError: (err) => toast.error(getApiErrorMessage(err)),
  });

  const logoMutation = useMutation({
    mutationFn: async (file: File) => {
      const form = new FormData();
      form.append("file", file);
      return api.post("/settings/export-branding/logo", form, { headers: { "Content-Type": "multipart/form-data" } });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["export-branding"] });
      toast.success("Logo de exportação atualizada.");
    },
    onError: (err) => toast.error(getApiErrorMessage(err)),
  });

  return (
    <div className="max-w-4xl space-y-6">
      <div className="shadow-soft rounded-card border border-border bg-surface p-5">
        <h2 className="mb-1 text-base font-semibold">Identidade de exportação</h2>
        <p className="mb-4 text-xs text-muted">
          Logo, nome e cor usados apenas no PowerPoint e nos relatórios exportados — independente da Identidade visual do aplicativo.
        </p>

        <fieldset disabled={!canEditar} className="contents">
        <div className="flex flex-wrap items-end gap-6">
          <div>
            <p className="mb-2 text-sm font-medium">Logo</p>
            {logoUrl && <img src={logoUrl} alt="Logo atual" className="mb-2 h-14 max-w-[10rem] object-contain" />}
            <input
              ref={logoInputRef}
              type="file"
              accept="image/png,image/jpeg,image/webp"
              hidden
              onChange={(e) => e.target.files?.[0] && logoMutation.mutate(e.target.files[0])}
            />
            <button
              onClick={() => logoInputRef.current?.click()}
              className="focus-ring rounded-card border border-border px-3 py-1.5 text-xs font-medium hover:bg-surface-alt"
            >
              Enviar logo
            </button>
          </div>

          <label className="min-w-[14rem] flex-1">
            <span className="mb-1 block text-sm font-medium">Nome da empresa</span>
            <input
              value={companyName}
              onChange={(e) => setCompanyName(e.target.value)}
              className="focus-ring w-full rounded-card border border-border bg-transparent px-3 py-2 text-sm"
            />
          </label>

          <label>
            <span className="mb-1 block text-sm font-medium">Cor principal</span>
            <div className="flex items-center gap-2">
              <input type="color" value={primaryColor} onChange={(e) => setPrimaryColor(e.target.value)} className="h-9 w-9 shrink-0 rounded border border-border" />
              <input
                value={primaryColor}
                onChange={(e) => setPrimaryColor(e.target.value)}
                className="focus-ring w-28 rounded-card border border-border bg-transparent px-3 py-2 text-sm"
              />
            </div>
          </label>

          <button
            onClick={() => saveMutation.mutate()}
            disabled={saveMutation.isPending}
            className="focus-ring rounded-card bg-primary px-4 py-2 text-sm font-semibold text-primary-fg disabled:opacity-60"
          >
            {saveMutation.isPending ? "Salvando..." : "Salvar"}
          </button>
        </div>
        </fieldset>
      </div>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        {/* ---- Apresentação (PowerPoint) ---- */}
        <div className="shadow-soft rounded-card border border-border bg-surface p-5">
          <div className="mb-1 flex items-center gap-2">
            <Presentation className="h-4.5 w-4.5 text-primary" />
            <h2 className="text-base font-semibold">Apresentação (PowerPoint)</h2>
          </div>
          <p className="mb-4 text-xs text-muted">Capa da apresentação gerada no Dashboard, em "Apresentação (PPT)".</p>

          {/* The cover built in lib/dashboardPresentation.ts, in miniature: the color's dark shade, translucent circles, the logo on a white badge. */}
          <div className="relative aspect-video w-full overflow-hidden rounded-lg border border-border shadow-inner" style={{ backgroundColor: coverDark }}>
            <div className="absolute aspect-square rounded-full" style={{ left: "62%", top: "-21%", width: "49.5%", backgroundColor: primaryColor, opacity: 0.28 }} />
            <div className="absolute aspect-square rounded-full" style={{ left: "78%", top: "52%", width: "31.5%", backgroundColor: primaryColor, opacity: 0.16 }} />
            <div className="absolute aspect-square rounded-full border-2" style={{ left: "69%", top: "60%", width: "8.25%", borderColor: coverMid }} />
            <div className="absolute left-[4.5%] top-[11%] w-[68%]">
              {logoUrl ? (
                <div className="mb-4 inline-flex rounded bg-white px-2 py-1">
                  <img src={logoUrl} alt="" className="h-5 max-w-[7rem] object-contain" />
                </div>
              ) : (
                <p className="mb-4 truncate text-xs font-bold text-white">{companyName || "WhatsAtendende"}</p>
              )}
              <p className="text-[7px] font-bold uppercase tracking-[0.25em]" style={{ color: coverMid }}>
                Relatório de atendimento
              </p>
              <p className="mt-1 text-lg font-bold leading-tight text-white">Desempenho do atendimento</p>
              <p className="mt-1 text-[10px]" style={{ color: lighten(primaryColor, 0.8) }}>
                Este mês · setembro de 2026, até 26/09
              </p>
              <p className="text-[8px]" style={{ color: lighten(primaryColor, 0.6) }}>
                Todas as conexões · todos os atendentes
              </p>
            </div>
            <p className="absolute bottom-[6%] left-[4.5%] truncate text-[7px]" style={{ color: lighten(primaryColor, 0.5) }}>
              {companyName || "WhatsAtendende"} · gerado em 26/09/2026, 10:00
            </p>
          </div>
        </div>

        {/* ---- Relatórios (PDF / Excel) ---- */}
        <div className="shadow-soft rounded-card border border-border bg-surface p-5">
          <div className="mb-1 flex items-center gap-2">
            <FileSpreadsheet className="h-4.5 w-4.5 text-primary" />
            <h2 className="text-base font-semibold">Relatórios (PDF / Excel)</h2>
          </div>
          <p className="mb-4 text-xs text-muted">Cabeçalho e cores usados em Relatórios ao exportar em PDF ou Excel.</p>

          <div className="aspect-video w-full overflow-hidden rounded-lg border border-border bg-white p-3 shadow-inner">
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0">
                <p className="truncate text-sm font-bold text-slate-800">Relatório de Atendimentos</p>
                <p className="truncate text-[10px] text-slate-500">Gerado em 26/09/2026, 10:00 · {companyName || "WhatsAtendende"}</p>
              </div>
              {logoUrl && <img src={logoUrl} alt="" className="h-6 max-w-[35%] shrink-0 object-contain" />}
            </div>
            <div className="mt-3 overflow-hidden rounded">
              <div className="grid grid-cols-4 text-[10px] font-semibold text-white" style={{ backgroundColor: primaryColor }}>
                {["Data", "Cliente", "Atendente", "Status"].map((h) => (
                  <div key={h} className="truncate px-2 py-1">
                    {h}
                  </div>
                ))}
              </div>
              {SAMPLE_ROWS.map((cells, i) => (
                <div key={i} className={`grid grid-cols-4 text-[10px] text-slate-600 ${i % 2 === 1 ? "bg-slate-50" : "bg-white"}`}>
                  {cells.map((c, j) => (
                    <div key={j} className="truncate px-2 py-1">
                      {c}
                    </div>
                  ))}
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
      {canEditar && exportBranding && (
        <UnsavedChangesBar
          dirty={companyName !== exportBranding.companyName || primaryColor !== exportBranding.primaryColor}
          saving={saveMutation.isPending}
          onSave={() => saveMutation.mutate()}
          onDiscard={() => {
            setCompanyName(exportBranding.companyName);
            setPrimaryColor(exportBranding.primaryColor);
          }}
        />
      )}
    </div>
  );
}
