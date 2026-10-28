import type { ClosingMessageDTO } from "@whatsatendende/types";
import { toConnectionScopeDTO } from "../../lib/connection-scope";
import { toReplyMediaDTO, type ReplyMediaColumns } from "../../lib/reply-media";

interface ClosingMessageRow extends ReplyMediaColumns {
  id: string;
  name: string;
  text: string;
  active: boolean;
  showSenderName: boolean;
  assignedUsers: { id: string; displayName: string }[];
  allConnections: boolean;
  connections: { id: string; name: string }[];
  createdAt: Date;
  updatedAt: Date;
}

export function toClosingMessageDTO(row: ClosingMessageRow): ClosingMessageDTO {
  return {
    id: row.id,
    name: row.name,
    text: row.text,
    media: toReplyMediaDTO(row),
    active: row.active,
    showSenderName: row.showSenderName,
    assignedUsers: row.assignedUsers,
    connectionScope: toConnectionScopeDTO(row),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}
