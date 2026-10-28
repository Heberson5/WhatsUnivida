import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import clsx from "clsx";
import { Timer } from "lucide-react";
import { CHAT_AUTO_DELETE_PRESETS, chatDurationLabel, type ChatRoomDTO } from "@whatsatendende/types";
import { api, getApiErrorMessage } from "../../lib/api";
import { ChatDialog } from "./ChatDialogs";

const CUSTOM_UNITS = [
  { label: "segundos", seconds: 1 },
  { label: "minutos", seconds: 60 },
  { label: "horas", seconds: 3600 },
  { label: "dias", seconds: 86400 },
] as const;

/** Conversa individual › Mensagens autoexplosivas, like Telegram's: off, a preset, or a custom time. */
export function AutoDeleteDialog({ room, onClose }: { room: ChatRoomDTO; onClose: () => void }) {
  const queryClient = useQueryClient();
  const current = room.autoDeleteSeconds;
  const isPreset = current === null || (CHAT_AUTO_DELETE_PRESETS as readonly number[]).includes(current);
  const [choice, setChoice] = useState<number | null | "custom">(isPreset ? current : "custom");
  const initialUnit = current && !isPreset ? ([...CUSTOM_UNITS].reverse().find((u) => current % u.seconds === 0) ?? CUSTOM_UNITS[0]) : CUSTOM_UNITS[2];
  const [amount, setAmount] = useState(current && !isPreset ? current / initialUnit.seconds : 2);
  const [unit, setUnit] = useState<number>(initialUnit.seconds);

  const mutation = useMutation({
    mutationFn: (seconds: number | null) => api.put(`/internal-chat/rooms/${room.id}/auto-delete`, { seconds }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["internal-chat"] });
      onClose();
    },
    onError: (err) => toast.error(getApiErrorMessage(err)),
  });

  const seconds = choice === "custom" ? Math.round(amount * unit) : choice;
  const valid = seconds === null || (seconds >= 1 && seconds <= 30 * 86400);

  return (
    <ChatDialog title="Mensagens autoexplosivas" icon={<Timer className="h-4 w-4 text-warning" />} onClose={onClose}>
      <div className="space-y-3">
        <p className="text-muted">As mensagens novas desta conversa somem para vocês dois depois do tempo escolhido, contado a partir de quando a outra pessoa lê.</p>
        <div className="grid gap-1">
          {[null, ...CHAT_AUTO_DELETE_PRESETS].map((s) => (
            <Option key={String(s)} selected={choice === s} onClick={() => setChoice(s)}>
              {s === null ? "Desativado" : chatDurationLabel(s)}
            </Option>
          ))}
          <Option selected={choice === "custom"} onClick={() => setChoice("custom")}>
            Personalizado
            {choice === "custom" && (
              <span className="ml-auto flex items-center gap-1.5" onClick={(e) => e.stopPropagation()}>
                <input
                  type="number"
                  min={1}
                  value={amount}
                  onChange={(e) => setAmount(Number(e.target.value))}
                  className="focus-ring w-16 rounded-lg border border-border bg-surface px-2 py-1 text-sm"
                  aria-label="Tempo"
                />
                <select value={unit} onChange={(e) => setUnit(Number(e.target.value))} className="focus-ring rounded-lg border border-border bg-surface px-2 py-1 text-sm" aria-label="Unidade">
                  {CUSTOM_UNITS.map((u) => (
                    <option key={u.seconds} value={u.seconds}>
                      {u.label}
                    </option>
                  ))}
                </select>
              </span>
            )}
          </Option>
        </div>
        {!valid && <p className="text-xs text-danger">Escolha entre 1 segundo e 30 dias.</p>}
        <p className="text-xs text-muted">Qualquer um dos dois pode mudar, e a mudança aparece na conversa.</p>
        <div className="flex justify-end gap-2">
          <button onClick={onClose} className="focus-ring rounded-card border border-border px-3 py-1.5 text-sm font-semibold hover:bg-surface-alt">
            Cancelar
          </button>
          <button onClick={() => mutation.mutate(seconds)} disabled={!valid || mutation.isPending} className="focus-ring rounded-card bg-primary px-3 py-1.5 text-sm font-semibold text-primary-fg disabled:opacity-50">
            Salvar
          </button>
        </div>
      </div>
    </ChatDialog>
  );
}

function Option({ selected, onClick, children }: { selected: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button type="button" onClick={onClick} className={clsx("flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-sm", selected ? "bg-primary/10 font-bold" : "hover:bg-surface-alt")}>
      <span className={clsx("h-4 w-4 shrink-0 rounded-full border-2", selected ? "border-primary bg-[radial-gradient(var(--color-primary)_45%,transparent_50%)]" : "border-muted")} />
      {children}
    </button>
  );
}
