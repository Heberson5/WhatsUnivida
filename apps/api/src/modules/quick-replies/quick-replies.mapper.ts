import type { QuickReplyDTO } from "@whatsunivida/types";

interface QuickReplyRow {
  id: string;
  name: string;
  shortcut: string;
  text: string;
  whatsappConnectionId: string;
  whatsappConnection: { id: string; name: string };
  createdAt: Date;
  updatedAt: Date;
}

export function toQuickReplyDTO(row: QuickReplyRow): QuickReplyDTO {
  return {
    id: row.id,
    name: row.name,
    shortcut: row.shortcut,
    text: row.text,
    whatsappConnectionId: row.whatsappConnectionId,
    whatsappConnectionName: row.whatsappConnection.name,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}
