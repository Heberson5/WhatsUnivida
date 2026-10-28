import type PptxGenJS from "pptxgenjs";
import type { ExportBranding } from "../hooks/useExportBranding";
import type { PresentationInput } from "./dashboardPresentation";

async function toDataUri(url: string): Promise<string | null> {
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    const blob = await res.blob();
    return await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onloadend = () => resolve(reader.result as string);
      reader.onerror = reject;
      reader.readAsDataURL(blob);
    });
  } catch {
    // A missing/unreachable logo shouldn't block the whole export — the
    // cover slide just renders without it.
    return null;
  }
}

function loadImageSize(dataUri: string): Promise<{ width: number; height: number } | null> {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve({ width: img.naturalWidth, height: img.naturalHeight });
    img.onerror = () => resolve(null);
    img.src = dataUri;
  });
}

async function loadLogo(url: string | null | undefined): Promise<PresentationInput["logo"]> {
  if (!url) return null;
  const data = await toDataUri(url);
  const size = data ? await loadImageSize(data) : null;
  // The builder fits the logo in its boxes keeping this aspect ratio — never pptxgenjs's
  // `sizing: "contain"`, which Google Slides draws stretched. See PROMPT: "a logo está desconfigurada".
  return data && size ? { data, ...size } : null;
}

/**
 * Downloads the Dashboard as a PowerPoint presentation for the board (see dashboardPresentation.ts
 * for the slides). Logo, company name and color come from Configurações › Exportações. pptxgenjs, the
 * slide builder and the icon drawing are loaded on demand, so viewing the Dashboard doesn't pay for them.
 */
export async function exportDashboardPptx(
  input: Omit<PresentationInput, "companyName" | "primaryColor" | "logo" | "icons" | "now"> & { branding: ExportBranding | null }
): Promise<void> {
  const { branding, ...rest } = input;
  const [{ default: PptxGen }, { buildDashboardPresentation }, { renderPresentationIcons }, logo] = await Promise.all([
    import("pptxgenjs"),
    import("./dashboardPresentation"),
    import("./presentationIcons"),
    loadLogo(branding?.logoUrl),
  ]);
  const now = new Date();
  const pptx = buildDashboardPresentation(PptxGen as typeof PptxGenJS, {
    ...rest,
    companyName: branding?.companyName ?? "WhatsAtendende",
    primaryColor: branding?.primaryColor ?? "#0097B4",
    logo,
    icons: await renderPresentationIcons(),
    now,
  });
  await pptx.writeFile({ fileName: `apresentacao-atendimento-${rest.period.period}-${now.toISOString().slice(0, 10)}.pptx` });
}
