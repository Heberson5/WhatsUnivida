import { useQuery } from "@tanstack/react-query";
import { Clock } from "lucide-react";
import type { WorkScheduleOptionDTO } from "@whatsatendende/types";
import { api } from "../../lib/api";

/** One Horário de expediente (Respostas) per connection — "Sem horário" means the connection attends 24 hours. */
export function WorkScheduleSelect({
  value,
  onChange,
  disabled,
  label,
}: {
  value: string | null;
  onChange: (workScheduleId: string | null) => void;
  disabled?: boolean;
  label: string;
}) {
  const { data: options } = useQuery({
    queryKey: ["work-schedule-options"],
    queryFn: async () => (await api.get<WorkScheduleOptionDTO[]>("/work-schedules/options")).data,
  });

  return (
    <label className="block text-xs">
      <span className="mb-1 flex items-center gap-1.5 font-medium">
        <Clock className="h-3.5 w-3.5 shrink-0 text-muted" /> Horário de expediente
      </span>
      <select
        value={value ?? ""}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value || null)}
        aria-label={label}
        className="focus-ring w-full rounded-card border border-border bg-transparent px-2 py-1.5 text-xs disabled:opacity-60"
      >
        <option value="">Sem horário (24 horas)</option>
        {options?.map((o) => (
          <option key={o.id} value={o.id}>
            {o.name}
          </option>
        ))}
      </select>
    </label>
  );
}
