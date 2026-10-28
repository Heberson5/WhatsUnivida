import type { AutoMessageTemplate } from "@prisma/client";
import type { AutoMessageTemplateDTO } from "@whatsatendende/types";
import { toConnectionScopeDTO } from "../../lib/connection-scope";

export function toAutoMessageTemplateDTO(
  row: AutoMessageTemplate & { connections: { id: string; name: string }[]; users: { id: string; displayName: string }[] }
): AutoMessageTemplateDTO {
  return {
    id: row.id,
    trigger: row.trigger,
    name: row.name,
    text: row.text,
    active: row.active,
    showSenderName: row.showSenderName,
    connectionScope: toConnectionScopeDTO(row),
    userScope: { allUsers: row.allUsers, users: row.allUsers ? [] : row.users },
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}
