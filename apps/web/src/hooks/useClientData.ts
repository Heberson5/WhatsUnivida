import { useQuery } from "@tanstack/react-query";
import type { ClientDataDTO } from "@whatsatendende/types";
import { api } from "../lib/api";

export const clientDataKey = (conversationId: string) => ["client-data", conversationId];

/** Dados do cliente for a conversation — shared by the client panel and the suspension warning. */
export function useClientData(conversationId: string) {
  return useQuery({
    queryKey: clientDataKey(conversationId),
    queryFn: async () => (await api.get<ClientDataDTO>(`/conversations/${conversationId}/client-data`)).data,
    staleTime: 60_000,
  });
}
