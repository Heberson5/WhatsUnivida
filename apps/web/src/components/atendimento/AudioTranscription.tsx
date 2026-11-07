import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { Loader2, Type } from "lucide-react";
import type { AiAssistantFeaturesDTO, MessageDTO } from "@whatsatendende/types";
import { api, getApiErrorMessage } from "../../lib/api";

/**
 * Under a customer's audio: the transcription (made by the Assistente Virtual while it attended, or by someone of the
 * team), or — when Configurações › Assistente Virtual allows it for the team — the "Transcrever" button.
 */
export function AudioTranscription({ message }: { message: MessageDTO }) {
  const [text, setText] = useState<string | null>(message.transcription ?? null);
  const shown = message.transcription ?? text;
  const { data: features } = useQuery({
    queryKey: ["ai-features"],
    queryFn: async () => (await api.get<AiAssistantFeaturesDTO>("/ai-features")).data,
    staleTime: 5 * 60_000,
    enabled: !shown && message.direction === "INBOUND",
  });
  const transcribe = useMutation({
    mutationFn: async () => (await api.post<{ transcription: string }>(`/conversations/${message.conversationId}/messages/${message.id}/transcribe`, undefined, { timeout: 300_000 })).data,
    onSuccess: (data) => setText(data.transcription),
    onError: (err) => toast.error(getApiErrorMessage(err, "Não foi possível transcrever o áudio")),
  });

  if (shown) {
    return (
      <p className="mt-1 whitespace-pre-wrap break-words rounded border border-black/10 bg-black/5 px-2 py-1 text-xs italic" data-testid="audio-transcription">
        <span className="not-italic font-semibold">Transcrição: </span>
        {shown}
      </p>
    );
  }
  if (message.direction !== "INBOUND" || !features?.agentTranscription) return null;
  return (
    <button
      type="button"
      onClick={() => transcribe.mutate()}
      disabled={transcribe.isPending}
      className="focus-ring mt-1 inline-flex items-center gap-1 rounded border border-black/10 bg-black/5 px-2 py-0.5 text-xs font-medium hover:bg-black/10 disabled:opacity-70"
    >
      {transcribe.isPending ? <Loader2 className="h-3 w-3 animate-spin" /> : <Type className="h-3 w-3" />}
      {transcribe.isPending ? "Transcrevendo… (pode levar até 1 minuto)" : "Transcrever"}
    </button>
  );
}
