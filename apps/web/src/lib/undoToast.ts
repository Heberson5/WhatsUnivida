import type { QueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { CONVERSATION_UNDO_WINDOW_MS } from "@whatsatendende/types";
import { api, getApiErrorMessage } from "./api";

/** Success toast with "Desfazer" for closing / returning a conversation to the queue — the API accepts it for the same window. */
export function toastWithUndo(message: string, conversationId: string, queryClient: QueryClient) {
  toast.success(message, {
    duration: CONVERSATION_UNDO_WINDOW_MS,
    action: {
      label: "Desfazer",
      onClick: () => {
        api
          .post(`/conversations/${conversationId}/undo`)
          .then(() => {
            toast.success("Pronto, ação desfeita.");
            void queryClient.invalidateQueries();
          })
          .catch((err) => toast.error(getApiErrorMessage(err)));
      },
    },
  });
}
