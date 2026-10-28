import type { QuickReplyDTO } from "@whatsatendende/types";
import { toConnectionScopeDTO } from "../../lib/connection-scope";
import { toReplyMediaDTO, type ReplyMediaColumns } from "../../lib/reply-media";

interface QuickReplyRow extends ReplyMediaColumns {
  id: string;
  name: string;
  shortcut: string;
  text: string;
  allConnections: boolean;
  connections: { id: string; name: string }[];
  createdAt: Date;
  updatedAt: Date;
}

export function toQuickReplyDTO(row: QuickReplyRow): QuickReplyDTO {
  return {
    id: row.id,
    name: row.name,
    shortcut: row.shortcut,
    text: row.text,
    media: toReplyMediaDTO(row),
    connectionScope: toConnectionScopeDTO(row),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}
