import { toast } from "sonner";
import { AlarmClock } from "lucide-react";
import type { ConversationReminderDTO } from "@whatsatendende/types";
import { api, getApiErrorMessage } from "../../lib/api";

const SNOOZE_MINUTES = 15;

/** "Lembrar de retornar" went off: stays on screen until answered — open the conversation (done) or push it 15 minutes. */
export function showReminderToast(reminder: ConversationReminderDTO & { contactName: string }, openConversation: (conversationId: string) => void) {
  toast.custom(
    (id) => (
      <div role="alert" className="w-[22rem] max-w-[calc(100vw-2rem)] rounded-card border border-warning/40 bg-surface p-3.5 shadow-elevated">
        <div className="flex items-start gap-2.5">
          <span className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-warning-soft text-warning">
            <AlarmClock className="h-4 w-4" />
          </span>
          <div className="min-w-0">
            <p className="text-sm font-semibold">Hora de retornar para {reminder.contactName}</p>
            {reminder.note && <p className="mt-0.5 break-words text-xs text-muted">{reminder.note}</p>}
          </div>
        </div>
        <div className="mt-3 flex justify-end gap-2">
          <button
            onClick={() => {
              toast.dismiss(id);
              api
                .post(`/agent-tools/reminders/${reminder.id}/snooze`, { minutes: SNOOZE_MINUTES })
                .then(() => toast.success(`Lembrete adiado em ${SNOOZE_MINUTES} minutos.`))
                .catch((err) => toast.error(getApiErrorMessage(err)));
            }}
            className="focus-ring rounded-lg border border-border px-3 py-1.5 text-xs font-medium hover:bg-surface-alt"
          >
            Adiar {SNOOZE_MINUTES} min
          </button>
          <button
            onClick={() => {
              toast.dismiss(id);
              openConversation(reminder.conversationId);
              api.delete(`/agent-tools/reminders/${reminder.id}`).catch(() => undefined);
            }}
            className="focus-ring rounded-lg bg-primary px-3 py-1.5 text-xs font-semibold text-primary-fg"
          >
            Abrir conversa
          </button>
        </div>
      </div>
    ),
    { id: `wa-reminder-${reminder.id}`, duration: Infinity }
  );
}
