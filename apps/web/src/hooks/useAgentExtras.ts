import { useQuery } from "@tanstack/react-query";
import type { AgentExtrasDTO, MyDayDTO } from "@whatsatendende/types";
import { api } from "../lib/api";

/** This person's pinned conversations, "lembrar de retornar" and scheduled messages — refreshed by the socket's "agent:extras". */
export function useAgentExtras() {
  return useQuery({
    queryKey: ["agent-extras"],
    queryFn: async () => (await api.get<AgentExtrasDTO>("/agent-tools/extras")).data,
    staleTime: 60_000,
  });
}

/** "Meu dia": closed today, average first response, this month's NPS and the daily goal. */
export function useMyDay() {
  return useQuery({
    queryKey: ["my-day"],
    queryFn: async () => (await api.get<MyDayDTO>("/agent-tools/my-day", { params: { tzOffsetMinutes: new Date().getTimezoneOffset() } })).data,
    refetchInterval: 60_000,
  });
}
