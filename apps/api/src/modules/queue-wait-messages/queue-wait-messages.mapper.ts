import type { QueueWaitMessageDTO } from "@whatsatendende/types";
import { toConnectionScopeDTO } from "../../lib/connection-scope";
import { toReplyMediaDTO, type ReplyMediaColumns } from "../../lib/reply-media";

interface QueueWaitMessageRow extends ReplyMediaColumns {
  id: string;
  position: number;
  delayMinutes: number;
  text: string;
  active: boolean;
  allConnections: boolean;
  connections: { id: string; name: string }[];
  createdAt: Date;
  updatedAt: Date;
}

export function toQueueWaitMessageDTO(row: QueueWaitMessageRow): QueueWaitMessageDTO {
  return {
    id: row.id,
    position: row.position,
    delayMinutes: row.delayMinutes,
    text: row.text,
    media: toReplyMediaDTO(row),
    active: row.active,
    connectionScope: toConnectionScopeDTO(row),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}
