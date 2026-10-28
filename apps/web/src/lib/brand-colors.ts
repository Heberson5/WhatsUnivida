// The last colors this device saw, so the app (and the desktop app's title
// bar) opens already in the company's colors instead of flashing the
// default blue until GET /settings/branding answers.
const STORAGE_KEY = "wa-brand-colors";

/** Paints the brand colors on the page and on the browser/installed-app title bar (meta theme-color). */
export function applyBrandColors(primaryColor: string, secondaryColor: string) {
  document.documentElement.style.setProperty("--color-primary", primaryColor);
  document.documentElement.style.setProperty("--color-secondary", secondaryColor);
  document.querySelector<HTMLMetaElement>('meta[name="theme-color"]')?.setAttribute("content", primaryColor);
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ primaryColor, secondaryColor }));
  } catch {
    // Storage blocked — the colors still apply for this session.
  }
}

export function applySavedBrandColors() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "null") as { primaryColor: string; secondaryColor: string } | null;
    if (saved) applyBrandColors(saved.primaryColor, saved.secondaryColor);
  } catch {
    // Nothing saved yet (or unreadable) — the defaults in index.html/index.css stand until branding loads.
  }
}
