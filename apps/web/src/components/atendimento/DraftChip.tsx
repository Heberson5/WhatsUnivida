import { MapPin, Mic, Paperclip, PencilLine } from "lucide-react";
import { useAuthStore } from "../../store/auth-store";
import { draftKey, useDraftStore } from "../../store/draft-store";
import { mediaDraftKind, useMediaDraftStore } from "../../store/media-draft-store";

const MEDIA_LABEL = {
  audio: { icon: Mic, text: "Áudio em rascunho" },
  files: { icon: Paperclip, text: "Anexo em rascunho" },
  location: { icon: MapPin, text: "Localização em rascunho" },
} as const;

/**
 * "Rascunho" on a conversation's (or group's) card: something was left unsent in it — text, a paused voice recording,
 * files or a location waiting in the preview. A recording or attachment says so, since that's what's easy to forget.
 */
export function DraftChip({ draftOwner }: { draftOwner: string }) {
  const userId = useAuthStore((s) => s.user?.id);
  const key = userId ? draftKey(userId, draftOwner) : null;
  const hasText = useDraftStore((s) => Boolean(key && s.drafts[key]?.trim()));
  const media = useMediaDraftStore((s) => mediaDraftKind(key ? s.drafts[key] : undefined));
  if (!hasText && !media) return null;
  const { icon: Icon, text } = media ? MEDIA_LABEL[media] : { icon: PencilLine, text: "Rascunho" };
  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-surface-alt px-2 py-0.5 text-[10.5px] font-semibold text-muted">
      <Icon className="h-3 w-3" /> {text}
    </span>
  );
}
