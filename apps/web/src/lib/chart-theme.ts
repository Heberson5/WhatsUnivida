/**
 * Shared palette + gradient/shadow helpers for the Dashboard's "3D" chart
 * cards — see PROMPT: "quero gráficos neste estilo, mais apresentável com
 * estilo de 3d e profundidade". Derives every series color from the app's
 * own branding (primary/secondary), not a hardcoded set, so a custom
 * company palette (Configurações > Identidade visual) carries through.
 */

function hexToRgb(hex: string): [number, number, number] {
  const clean = hex.replace("#", "");
  const full = clean.length === 3 ? clean.split("").map((c) => c + c).join("") : clean;
  const num = parseInt(full, 16);
  return [(num >> 16) & 255, (num >> 8) & 255, num & 255];
}

function rgbToHex([r, g, b]: [number, number, number]): string {
  return "#" + [r, g, b].map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, "0")).join("");
}

/** Mixes a color toward white (amount 0-1) — used for the lighter gradient stop / glossy highlight. */
export function lighten(hex: string, amount: number): string {
  const [r, g, b] = hexToRgb(hex);
  return rgbToHex([r + (255 - r) * amount, g + (255 - g) * amount, b + (255 - b) * amount]);
}

/** Mixes a color toward black (amount 0-1) — used for the darker gradient stop / shadowed edge. */
export function darken(hex: string, amount: number): string {
  const [r, g, b] = hexToRgb(hex);
  return rgbToHex([r * (1 - amount), g * (1 - amount), b * (1 - amount)]);
}

/** A neutral slate used as the third/overflow series color when a chart needs more colors than the brand provides. */
export const NEUTRAL_SERIES_COLOR = "#64748B";

export function seriesPalette(primaryColor: string, secondaryColor: string): string[] {
  return [primaryColor, secondaryColor, NEUTRAL_SERIES_COLOR, lighten(primaryColor, 0.35), darken(secondaryColor, 0.25)];
}

/** Deterministic id (no special chars) so the same color always resolves to the same <defs> gradient/filter, even across multiple chart cards on one page. */
export function gradientId(prefix: string, color: string): string {
  return `${prefix}-${color.replace("#", "")}`;
}

/** Soft elevation shared by every chart card — the "profundidade" the flat cards were missing. */
export const CHART_CARD_SHADOW = "shadow-[0_1px_2px_rgba(0,0,0,0.06),0_12px_28px_-8px_rgba(0,0,0,0.18)]";

/** CSS filter applied to the whole plotted area so bars/slices/lines look like they're floating above the card, matching the reference screenshot. */
export const CHART_DEPTH_FILTER = "drop-shadow(0 10px 14px rgba(0,0,0,0.16))";
