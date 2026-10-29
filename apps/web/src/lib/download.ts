import { api } from "./api";

/** Saves a Blob the browser already holds under `fileName` (the PowerPoint preview, a receipt in Excel/PDF). */
export function saveBlob(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/** The file name the server put in Content-Disposition, or `fallback`. */
function fileNameOf(header: string | undefined, fallback: string): string {
  const match = header ? /filename="?([^";]+)"?/i.exec(header) : null;
  return match?.[1] ?? fallback;
}

/** Downloads an authenticated GET (or POST, with `body`) response as a file. */
export async function downloadFile(url: string, fallbackName: string, body?: unknown): Promise<void> {
  const res = body === undefined ? await api.get<Blob>(url, { responseType: "blob" }) : await api.post<Blob>(url, body, { responseType: "blob" });
  saveBlob(res.data, fileNameOf(res.headers["content-disposition"] as string | undefined, fallbackName));
}
