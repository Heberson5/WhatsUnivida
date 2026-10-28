import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { FileText, Info, Paperclip, Trash2 } from "lucide-react";
import { REPLY_MEDIA_CAPTION_MAX, replyMediaKind, type ReplyMediaDTO, type ReplyMediaLimitsDTO } from "@whatsatendende/types";
import { toast } from "sonner";
import { api, getApiErrorMessage } from "../../lib/api";

/** What the form does with the attachment on save — the row is saved first, then the file goes up (or is removed). */
export type ReplyMediaChange = { kind: "keep" } | { kind: "set"; file: File } | { kind: "remove" };

/** Whether the reply will have an attachment once saved — then its text is the caption, up to REPLY_MEDIA_CAPTION_MAX. */
export function hasReplyMedia(current: ReplyMediaDTO | null | undefined, change: ReplyMediaChange): boolean {
  return change.kind === "set" || (change.kind === "keep" && Boolean(current));
}

export function captionTooLong(text: string, current: ReplyMediaDTO | null | undefined, change: ReplyMediaChange): boolean {
  return hasReplyMedia(current, change) && text.length > REPLY_MEDIA_CAPTION_MAX;
}

/** Uploads or removes the attachment of a saved row — `basePath` is "/quick-replies" or "/closing-messages". */
export async function saveReplyMedia(basePath: string, id: string, change: ReplyMediaChange): Promise<void> {
  if (change.kind === "set") {
    const form = new FormData();
    form.append("file", change.file);
    await api.post(`${basePath}/${id}/media`, form);
  } else if (change.kind === "remove") {
    await api.delete(`${basePath}/${id}/media`);
  }
}

/**
 * Same, after the row itself was saved: a refused file (too big, wrong type) is reported without failing the save —
 * the form closes on the saved row instead of offering to create it a second time.
 */
export async function saveReplyMediaOrWarn(basePath: string, id: string, change: ReplyMediaChange): Promise<void> {
  try {
    await saveReplyMedia(basePath, id, change);
  } catch (err) {
    toast.error(`O texto foi salvo, mas o anexo não: ${getApiErrorMessage(err)}`);
  }
}

export function useReplyMediaLimits() {
  return useQuery({
    queryKey: ["reply-media-limits"],
    queryFn: async () => (await api.get<ReplyMediaLimitsDTO>("/quick-replies/media-limits")).data,
    staleTime: Infinity,
  });
}

function formatMb(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024)).toLocaleString("pt-BR")} KB`;
  return `${(bytes / (1024 * 1024)).toLocaleString("pt-BR", { maximumFractionDigits: 1 })} MB`;
}

/** The limit for this file, or a reason it can't be attached at all. */
export function checkReplyMediaFile(file: File, limits: ReplyMediaLimitsDTO): string | null {
  const kind = replyMediaKind(file.type);
  if (!kind) return "Escolha uma imagem (JPG, PNG ou WEBP), um vídeo (MP4) ou um PDF.";
  const limitMb = kind === "IMAGE" ? limits.imageMb : kind === "VIDEO" ? limits.videoMb : limits.documentMb;
  if (file.size > limitMb * 1024 * 1024) {
    const what = kind === "IMAGE" ? "imagem" : kind === "VIDEO" ? "vídeo" : "PDF";
    return `Este arquivo tem ${formatMb(file.size)}. Pelo sistema, o WhatsApp aceita ${what} de até ${limitMb} MB. Reduza o arquivo antes de incluir — o sistema não comprime, para não perder qualidade.`;
  }
  return null;
}

/**
 * The optional image, video or PDF of a quick reply or closing message. The limits are shown before choosing
 * (the file goes out exactly as it is, never compressed); only who may attach media changes it — everyone else
 * just sees what is attached.
 */
export function ReplyMediaField({
  current,
  previewPath,
  canEdit,
  change,
  onChange,
}: {
  current: ReplyMediaDTO | null | undefined;
  /** Where the saved attachment is downloaded from, e.g. "/quick-replies/<id>/media" — null for a row not saved yet. */
  previewPath: string | null;
  canEdit: boolean;
  change: ReplyMediaChange;
  onChange: (change: ReplyMediaChange) => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [error, setError] = useState<string | null>(null);
  const { data: limits } = useReplyMediaLimits();

  const showingSaved = change.kind === "keep" && current && previewPath;
  const savedPreview = useQuery({
    queryKey: ["reply-media-preview", previewPath, current?.fileName, current?.sizeBytes],
    queryFn: async () => URL.createObjectURL((await api.get<Blob>(previewPath!, { responseType: "blob" })).data),
    enabled: Boolean(showingSaved && current && current.kind !== "DOCUMENT"),
    staleTime: Infinity,
  });

  const localUrl = useMemo(() => (change.kind === "set" ? URL.createObjectURL(change.file) : null), [change]);
  useEffect(() => () => void (localUrl && URL.revokeObjectURL(localUrl)), [localUrl]);

  const shown: { fileName: string; sizeBytes: number; kind: ReplyMediaDTO["kind"]; url: string | null } | null =
    change.kind === "set"
      ? { fileName: change.file.name, sizeBytes: change.file.size, kind: replyMediaKind(change.file.type) ?? "DOCUMENT", url: localUrl }
      : showingSaved
        ? { fileName: current.fileName, sizeBytes: current.sizeBytes, kind: current.kind, url: savedPreview.data ?? null }
        : null;

  if (!canEdit && !shown) return null;

  function pick(file: File | undefined) {
    if (!file || !limits) return;
    const problem = checkReplyMediaFile(file, limits);
    setError(problem);
    if (!problem) onChange({ kind: "set", file });
  }

  return (
    <div className="block">
      <span className="mb-1 block text-sm font-medium">Anexo (opcional)</span>

      {canEdit && (
        <div className="mb-2 flex gap-2 rounded-card border border-border bg-surface-alt px-3 py-2 text-xs text-muted" role="note">
          <Info className="mt-0.5 h-3.5 w-3.5 shrink-0 text-primary" />
          <div>
            <p>Uma imagem, um vídeo ou um PDF. O texto acima vai junto, como legenda (até {REPLY_MEDIA_CAPTION_MAX.toLocaleString("pt-BR")} caracteres).</p>
            <p className="mt-1">
              Limites do WhatsApp para envio pelo sistema: <strong>imagem</strong> JPG, PNG ou WEBP até {limits?.imageMb ?? 5} MB · <strong>vídeo</strong> MP4 até{" "}
              {limits?.videoMb ?? 16} MB · <strong>PDF</strong> até {limits?.documentMb ?? 25} MB. O arquivo é enviado como está, sem compressão, para manter a
              qualidade — por isso arquivos maiores não são aceitos.
            </p>
          </div>
        </div>
      )}

      {shown ? (
        <div className="flex items-center gap-3 rounded-card border border-border p-2">
          <div className="flex h-16 w-16 shrink-0 items-center justify-center overflow-hidden rounded-card bg-surface-alt">
            {shown.kind === "IMAGE" && shown.url ? (
              <img src={shown.url} alt="" className="h-full w-full object-cover" />
            ) : shown.kind === "VIDEO" && shown.url ? (
              <video src={shown.url} className="h-full w-full object-cover" muted />
            ) : (
              <FileText className="h-6 w-6 text-muted" />
            )}
          </div>
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-medium" title={shown.fileName}>
              {shown.fileName}
            </p>
            <p className="text-xs text-muted">
              {shown.kind === "IMAGE" ? "Imagem" : shown.kind === "VIDEO" ? "Vídeo" : "PDF"} · {formatMb(shown.sizeBytes)}
            </p>
          </div>
          {canEdit && (
            <div className="flex shrink-0 gap-1">
              <button type="button" onClick={() => inputRef.current?.click()} className="focus-ring rounded-card border border-border px-2 py-1 text-xs hover:bg-surface-alt">
                Trocar
              </button>
              <button
                type="button"
                onClick={() => {
                  setError(null);
                  onChange(current ? { kind: "remove" } : { kind: "keep" });
                }}
                className="focus-ring rounded-card p-1.5 text-muted hover:bg-danger-soft hover:text-danger"
                aria-label="Remover anexo"
                title="Remover anexo"
              >
                <Trash2 className="h-4 w-4" />
              </button>
            </div>
          )}
        </div>
      ) : (
        <button
          type="button"
          onClick={() => inputRef.current?.click()}
          disabled={!limits}
          className="focus-ring flex w-full items-center justify-center gap-2 rounded-card border border-dashed border-border py-2.5 text-sm text-muted hover:border-primary/50 hover:text-[var(--color-text)] disabled:opacity-60"
        >
          <Paperclip className="h-4 w-4" /> Incluir imagem, vídeo ou PDF
        </button>
      )}

      {!canEdit && shown && <p className="mt-1 text-xs text-muted">Só o Administrador e o Gestor podem incluir, trocar ou remover o anexo.</p>}
      {error && <p className="mt-1 rounded-card bg-danger-soft px-3 py-2 text-xs text-danger">{error}</p>}

      <input
        ref={inputRef}
        type="file"
        accept="image/jpeg,image/png,image/webp,video/mp4,application/pdf"
        className="hidden"
        data-testid="reply-media-input"
        onChange={(e) => {
          pick(e.target.files?.[0]);
          e.target.value = "";
        }}
      />
    </div>
  );
}
