import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import { toast } from "sonner";

const FLASH_MS = 1800;

/**
 * Jumps to a message of a conversation — what clicking a reply's quote does.
 * Elements inside `containerRef` mark themselves with `data-message-id`. The
 * target is centered and briefly highlighted (flashedId).
 */
export function useJumpToMessage(containerRef: RefObject<HTMLElement>) {
  const [flashedId, setFlashedId] = useState<string | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout>>();

  useEffect(() => () => clearTimeout(timerRef.current), []);

  const jumpToMessage = useCallback(
    (messageId: string) => {
      const target = containerRef.current?.querySelector<HTMLElement>(`[data-message-id="${messageId}"]`);
      if (!target) {
        toast.info("A mensagem original ainda não foi carregada ou foi removida.");
        return;
      }
      target.scrollIntoView({ behavior: "smooth", block: "center" });
      setFlashedId(messageId);
      clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => setFlashedId(null), FLASH_MS);
    },
    [containerRef]
  );

  return { jumpToMessage, flashedId };
}
