import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import type { UserDTO } from "@whatsatendende/types";
import { api, getApiErrorMessage } from "../lib/api";
import { useAuthStore } from "../store/auth-store";

/** Pause/resume the signed-in agent — shared by the Topbar button and the Ctrl+K palette. */
export function usePauseActions(onDone?: () => void) {
  const updateOwnPauseState = useAuthStore((s) => s.updateOwnPauseState);
  const queryClient = useQueryClient();

  const pause = useMutation({
    mutationFn: (pauseReasonId: string) => api.post<UserDTO>("/profile/pause", { pauseReasonId }),
    onSuccess: (res) => {
      updateOwnPauseState(res.data.pauseReasonId, res.data.pauseReasonName);
      queryClient.invalidateQueries({ queryKey: ["users"] });
      onDone?.();
    },
    onError: (err) => toast.error(getApiErrorMessage(err)),
  });

  const resume = useMutation({
    mutationFn: () => api.post<UserDTO>("/profile/resume"),
    onSuccess: (res) => {
      updateOwnPauseState(res.data.pauseReasonId, res.data.pauseReasonName);
      queryClient.invalidateQueries({ queryKey: ["users"] });
      onDone?.();
    },
    onError: (err) => toast.error(getApiErrorMessage(err)),
  });

  return { pause, resume };
}
