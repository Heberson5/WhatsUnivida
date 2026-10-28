import type { MessageTemplateButton, MessageTemplateDTO } from "@whatsatendende/types";

interface MessageTemplateRow {
  id: string;
  name: string;
  category: string;
  language: string;
  headerType: string;
  headerText: string | null;
  headerSampleFileName: string | null;
  headerSampleStorageKey: string | null;
  bodyText: string;
  footerText: string | null;
  buttons: unknown;
  whatsappConnectionId: string;
  whatsappConnection: { name: string };
  status: string;
  rejectionReason: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export function toMessageTemplateDTO(row: MessageTemplateRow): MessageTemplateDTO {
  return {
    id: row.id,
    name: row.name,
    category: row.category as MessageTemplateDTO["category"],
    language: row.language,
    headerType: row.headerType as MessageTemplateDTO["headerType"],
    headerText: row.headerText,
    headerSampleFileName: row.headerSampleFileName,
    headerSampleUrl: row.headerSampleStorageKey ? `/uploads/message-templates/${row.headerSampleStorageKey}` : null,
    bodyText: row.bodyText,
    footerText: row.footerText,
    buttons: (row.buttons as MessageTemplateButton[] | null) ?? [],
    whatsappConnectionId: row.whatsappConnectionId,
    whatsappConnectionName: row.whatsappConnection.name,
    status: row.status as MessageTemplateDTO["status"],
    rejectionReason: row.rejectionReason,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}
