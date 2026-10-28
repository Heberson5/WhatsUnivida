import { createPortal } from "react-dom";
import { MessageCircle } from "lucide-react";
import { PERMISSION } from "@whatsatendende/types";
import { useAuthStore } from "../../store/auth-store";
import { useInternalChatStore } from "../../store/internal-chat-store";
import { InternalChatDrawer, useChatRooms } from "./InternalChatDrawer";

/** The balloon next to the bell: unread count of the internal chat and the side panel. */
export function InternalChatButton() {
  const canUse = useAuthStore((s) => Boolean(s.permissions?.[PERMISSION.CHAT_INTERNO_USAR]));
  return canUse ? <InternalChatButtonInner /> : null;
}

function InternalChatButtonInner() {
  const { open, setOpen } = useInternalChatStore();
  const { data: rooms } = useChatRooms();
  const unread = (rooms ?? []).reduce((sum, r) => sum + r.unreadCount, 0);
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="focus-ring relative rounded-full p-2 text-muted hover:bg-surface-alt hover:text-[var(--color-text)]"
        aria-label="Chat interno"
        title="Chat interno"
      >
        <MessageCircle className="h-5 w-5" />
        {unread > 0 && (
          <span className="absolute -right-0.5 -top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-danger px-1 text-[10px] font-bold text-white">{unread > 99 ? "99+" : unread}</span>
        )}
      </button>
      {/* Portal: the topbar is its own stacking context, so the panel must live at the page root to sit above the chat. */}
      {open && createPortal(<InternalChatDrawer />, document.body)}
    </>
  );
}
