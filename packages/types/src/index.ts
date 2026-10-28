// Shared types/DTOs used by both apps/api and apps/web.
// Keep this package framework-agnostic (no Express/React/Prisma imports).

export const ROLE = {
  ADMIN: "ADMIN",
  MANAGER: "MANAGER",
  AGENT: "AGENT",
} as const;
export type Role = (typeof ROLE)[keyof typeof ROLE];

export const USER_STATUS = {
  ACTIVE: "ACTIVE",
  INACTIVE: "INACTIVE",
} as const;
export type UserStatus = (typeof USER_STATUS)[keyof typeof USER_STATUS];

export const AGENT_PRESENCE = {
  ONLINE: "ONLINE",
  AWAY: "AWAY",
  OFFLINE: "OFFLINE",
} as const;
export type AgentPresence = (typeof AGENT_PRESENCE)[keyof typeof AGENT_PRESENCE];

// Conversation state machine — see docs/business-rules.md for transitions.
export const CONVERSATION_STATUS = {
  NEW: "NEW",
  WAITING: "WAITING",
  IN_PROGRESS: "IN_PROGRESS",
  TRANSFERRED: "TRANSFERRED",
  CLOSED: "CLOSED",
  ABANDONED: "ABANDONED",
  // A still-unassigned conversation was read directly on the linked phone —
  // it leaves the queue without being attributed to any agent.
  HANDLED_EXTERNALLY: "HANDLED_EXTERNALLY",
} as const;
export type ConversationStatus = (typeof CONVERSATION_STATUS)[keyof typeof CONVERSATION_STATUS];

export const MESSAGE_DIRECTION = {
  INBOUND: "INBOUND",
  OUTBOUND: "OUTBOUND",
} as const;
export type MessageDirection = (typeof MESSAGE_DIRECTION)[keyof typeof MESSAGE_DIRECTION];

export const MESSAGE_TYPE = {
  TEXT: "TEXT",
  IMAGE: "IMAGE",
  VIDEO: "VIDEO",
  AUDIO: "AUDIO",
  DOCUMENT: "DOCUMENT",
  LOCATION: "LOCATION",
  CONTACT: "CONTACT",
  POLL: "POLL",
  EVENT: "EVENT",
  SYSTEM: "SYSTEM",
} as const;
export type MessageType = (typeof MESSAGE_TYPE)[keyof typeof MESSAGE_TYPE];

export const MESSAGE_STATUS = {
  PENDING: "PENDING",
  SENT: "SENT",
  DELIVERED: "DELIVERED",
  READ: "READ",
  FAILED: "FAILED",
} as const;
export type MessageStatus = (typeof MESSAGE_STATUS)[keyof typeof MESSAGE_STATUS];

export const WHATSAPP_CONNECTION_STATUS = {
  DISCONNECTED: "DISCONNECTED",
  CONNECTING: "CONNECTING",
  QR_PENDING: "QR_PENDING",
  CODE_PENDING: "CODE_PENDING",
  CONNECTED: "CONNECTED",
} as const;
export type WhatsAppConnectionStatus =
  (typeof WHATSAPP_CONNECTION_STATUS)[keyof typeof WHATSAPP_CONNECTION_STATUS];

export interface UserDTO {
  id: string;
  fullName: string;
  displayName: string;
  email: string;
  role: Role;
  status: UserStatus;
  presence: AgentPresence;
  photoUrl: string | null;
  whatsappConnectionId: string | null;
  whatsappConnectionName: string | null;
  // Live state of whatsappConnectionId's connection — null when the user
  // has no fixed connection (only ever set for AGENT). Powers the "your
  // connection is disconnected" banner in Atendimento.
  whatsappConnectionStatus: WhatsAppConnectionStatus | null;
  createdAt: string;
  lastAccessAt: string | null;
  // Where this user works — drives which STATE/MUNICIPAL holidays block
  // their access automatically. Both null = only NATIONAL holidays (if
  // any) can ever apply to this user.
  workState: string | null;
  workCity: string | null;
  // Per-weekday allowed access window — a day absent/undefined here means
  // unrestricted (24h) for that weekday. null as a whole = every day
  // unrestricted (the common case: no access-hours restriction at all).
  accessSchedule: AccessSchedule | null;
}

// HH:mm, 24h, e.g. "08:00" / "18:30".
export interface AccessScheduleWindow {
  start: string;
  end: string;
}

export const WEEKDAY_KEYS = ["MON", "TUE", "WED", "THU", "FRI", "SAT", "SUN"] as const;
export type WeekdayKey = (typeof WEEKDAY_KEYS)[number];

export type AccessSchedule = Partial<Record<WeekdayKey, AccessScheduleWindow>>;

export const HOLIDAY_SCOPE = {
  NATIONAL: "NATIONAL",
  STATE: "STATE",
  MUNICIPAL: "MUNICIPAL",
} as const;
export type HolidayScope = (typeof HOLIDAY_SCOPE)[keyof typeof HOLIDAY_SCOPE];

export const HOLIDAY_SOURCE = {
  MANUAL: "MANUAL",
  AUTO: "AUTO",
} as const;
export type HolidaySource = (typeof HOLIDAY_SOURCE)[keyof typeof HOLIDAY_SOURCE];

export interface HolidayDTO {
  id: string;
  date: string; // YYYY-MM-DD
  name: string;
  scope: HolidayScope;
  state: string | null;
  city: string | null;
  source: HolidaySource;
  year: number;
}

export interface QuickReplyDTO {
  id: string;
  name: string;
  /** Without the leading "/" — see the QuickReply Prisma model comment. */
  shortcut: string;
  text: string;
  whatsappConnectionId: string;
  whatsappConnectionName: string;
  createdAt: string;
  updatedAt: string;
}

export interface WhatsAppConnectionSummaryDTO {
  id: string;
  name: string;
  color: string;
  state: WhatsAppConnectionStatus;
  qrCodeDataUrl: string | null;
  pairingCode: string | null;
  connectedNumber: string | null;
  lastConnectedAt: string | null;
  agentCount: number;
  // Who created this connection — a MANAGER always has full access (view/
  // edit/receive) to a connection they created themselves, without needing
  // an explicit grant. Null for a connection created before this field
  // existed, or created directly by an ADMIN acting alone.
  createdByUserId: string | null;
  createdByUserName: string | null;
}

/**
 * One MANAGER's access grant to a connection they did NOT create — set by
 * an ADMIN in Usuários. Two independent flags, matching PROMPT: "designar
 * qual conexão os gestores poderão ver/editar e também poderão receber
 * novas conversas de quais conexões" — a manager can be granted either,
 * both, or neither on any given connection (view/edit access to the
 * connection's own settings vs. eligibility to receive/accept its queue).
 * A connection the manager created themselves needs no row here at all —
 * see WhatsAppConnectionSummaryDTO.createdByUserId.
 */
export interface ManagerConnectionAccessDTO {
  whatsappConnectionId: string;
  whatsappConnectionName: string;
  whatsappConnectionColor: string;
  // true when this manager created the connection themselves — canManage
  // and canReceiveConversations are then always true and not editable
  // (implicit full access, no grant row backing it).
  owned: boolean;
  canManage: boolean;
  canReceiveConversations: boolean;
}

/** A contact saved on the connection's linked phone — used by "start a new conversation". */
export interface WhatsAppDeviceContactDTO {
  phone: string;
  name: string | null;
  photoUrl: string | null;
}

export interface ContactDTO {
  id: string;
  phone: string;
  name: string | null;
  photoUrl: string | null;
  firstConversationAt: string;
  lastInteractionAt: string;
}

export interface ConversationListItemDTO {
  id: string;
  contact: ContactDTO;
  status: ConversationStatus;
  assignedAgentId: string | null;
  assignedAgentName: string | null;
  whatsappConnectionId: string;
  whatsappConnectionName: string;
  whatsappConnectionColor: string;
  // Live status of the owning connection — DISCONNECTED (or anything short
  // of CONNECTED) blocks accepting/sending on this conversation and drives
  // the disconnected-connection banner in the queue card and chat panel.
  whatsappConnectionStatus: WhatsAppConnectionStatus;
  enteredQueueAt: string;
  acceptedAt: string | null;
  lastMessageAt: string;
  lastMessagePreview: string | null; // omitted entirely by API while WAITING
  unreadCount: number;
  isNew: boolean;
  pendingTransferDeadline: string | null;
  transfer: {
    fromAgentName: string;
    toAgentName: string;
    at: string;
    note: string | null;
  } | null;
}

export interface MessageDTO {
  id: string;
  conversationId: string;
  direction: MessageDirection;
  type: MessageType;
  status: MessageStatus;
  body: string | null;
  senderAgentDisplayName: string | null;
  createdAt: string;
  deliveredAt: string | null;
  readAt: string | null;
  replyToMessageId: string | null;
  /** Set when this message replies to a WhatsApp Status/Story rather than to another message in the conversation — the story itself is never fetched/stored, only the small preview WhatsApp embeds directly in the reply. Deliberately carries no id/link to navigate to: there is nothing to navigate to. */
  replyToStory: { text: string | null; thumbnailUrl: string | null } | null;
  /** Link-preview card (WhatsApp Web parity) for a TEXT message whose body contains a URL. */
  linkPreview: { title: string; description: string | null; url: string; thumbnailUrl: string | null } | null;
  attachments: MessageAttachmentDTO[];
  reactions: MessageReactionDTO[];
}

export interface MessageAttachmentDTO {
  id: string;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  url: string;
  kind: MessageType;
  latitude?: number;
  longitude?: number;
  vcard?: string;
  /** POLL only — the poll's question. */
  pollQuestion?: string;
  /** POLL only — the poll's option labels (read-only: votes are end-to-end encrypted and not decoded here). */
  pollOptions?: string[];
  /** EVENT only. */
  eventName?: string;
  eventDescription?: string;
  eventStartAt?: string;
  eventJoinLink?: string;
}

export interface MessageReactionDTO {
  id: string;
  emoji: string;
  userId: string;
  userDisplayName: string;
}

export interface PaginatedResult<T> {
  items: T[];
  nextCursor: string | null;
  total?: number;
}

export interface AuditLogDTO {
  id: string;
  userDisplayName: string; // "Sistema" for actions with no acting user (e.g. an automatic transfer revert)
  action: string;
  entity: string;
  entityId: string | null;
  ipAddress: string | null;
  metadata: unknown;
  createdAt: string;
}

export interface DashboardFilter {
  period: "today" | "yesterday" | "last7days" | "month" | "lastMonth" | "custom";
  from?: string;
  to?: string;
  agentId?: string | "all";
}

export interface ApiErrorBody {
  error: string;
  message: string;
  details?: unknown;
}

/** GET/PATCH /settings/maintenance — GET is public (the login screen needs it before authenticating). */
export interface MaintenanceSettingsDTO {
  enabled: boolean;
  message: string | null;
}

// ---------------------------------------------------------------------------
// Granular per-role permissions (Configurações > Permissões).
//
// ADMIN is intentionally absent from PERMISSION_DEFINITIONS' editableRoles/
// defaultAllowed: it always has every permission, hardcoded on the backend,
// never stored or toggleable — otherwise an admin could accidentally lock
// themselves (and everyone else) out of the permissions screen itself with
// no way back in. AGENT/MANAGER defaults below reproduce exactly the
// hardcoded role checks this feature replaces, so turning it on changes
// nothing until an admin actually edits a toggle.
// ---------------------------------------------------------------------------

export const PERMISSION = {
  ATENDIMENTO_ACESSAR: "atendimento.acessar",
  ATENDIMENTO_TRANSFERIR: "atendimento.transferir",
  ATENDIMENTO_ENCERRAR: "atendimento.encerrar",
  GESTAO_ACESSAR: "gestao.acessar",
  DASHBOARD_ACESSAR: "dashboard.acessar",
  RELATORIOS_ACESSAR: "relatorios.acessar",
  USUARIOS_GERENCIAR: "usuarios.gerenciar",
  CONFIGURACOES_GERENCIAR: "configuracoes.gerenciar",
  AUDITORIA_ACESSAR: "auditoria.acessar",
  RESPOSTAS_RAPIDAS_GERENCIAR: "respostas_rapidas.gerenciar",
} as const;
export type Permission = (typeof PERMISSION)[keyof typeof PERMISSION];

export interface PermissionDefinition {
  key: Permission;
  group: string;
  label: string;
  description: string;
  editableRoles: Role[];
  defaultAllowed: Partial<Record<Role, boolean>>;
}

export const PERMISSION_DEFINITIONS: PermissionDefinition[] = [
  {
    key: PERMISSION.ATENDIMENTO_ACESSAR,
    group: "Atendimento",
    label: "Acessar Atendimento",
    description: "Ver a fila, aceitar conversas e enviar mensagens, arquivos e localização.",
    editableRoles: ["AGENT", "MANAGER"],
    defaultAllowed: { AGENT: true, MANAGER: true },
  },
  {
    key: PERMISSION.ATENDIMENTO_TRANSFERIR,
    group: "Atendimento",
    label: "Transferir conversas",
    description: "Transferir uma conversa em atendimento para outro atendente.",
    editableRoles: ["AGENT", "MANAGER"],
    defaultAllowed: { AGENT: true, MANAGER: true },
  },
  {
    key: PERMISSION.ATENDIMENTO_ENCERRAR,
    group: "Atendimento",
    label: "Encerrar conversas",
    description: "Encerrar uma conversa em atendimento.",
    editableRoles: ["AGENT", "MANAGER"],
    defaultAllowed: { AGENT: true, MANAGER: true },
  },
  {
    key: PERMISSION.GESTAO_ACESSAR,
    group: "Gestão",
    label: "Acessar Gestão",
    description: "Visualizar, em modo leitura, as conversas de todos os atendentes.",
    editableRoles: ["AGENT", "MANAGER"],
    defaultAllowed: { AGENT: false, MANAGER: true },
  },
  {
    key: PERMISSION.DASHBOARD_ACESSAR,
    group: "Dashboard",
    label: "Acessar Dashboard",
    description: "Visualizar indicadores e gráficos de desempenho.",
    editableRoles: ["AGENT", "MANAGER"],
    defaultAllowed: { AGENT: false, MANAGER: true },
  },
  {
    key: PERMISSION.RELATORIOS_ACESSAR,
    group: "Relatórios",
    label: "Acessar Relatórios",
    description: "Visualizar e exportar relatórios (CSV, PDF, Excel).",
    editableRoles: ["AGENT", "MANAGER"],
    defaultAllowed: { AGENT: false, MANAGER: true },
  },
  {
    key: PERMISSION.USUARIOS_GERENCIAR,
    group: "Usuários",
    label: "Gerenciar usuários",
    description: "Criar, editar, desativar e redefinir senha de usuários.",
    editableRoles: ["AGENT", "MANAGER"],
    defaultAllowed: { AGENT: false, MANAGER: false },
  },
  {
    key: PERMISSION.CONFIGURACOES_GERENCIAR,
    group: "Configurações",
    label: "Gerenciar configurações",
    description: "Gerenciar conexões de WhatsApp, identidade visual e e-mail/SMTP.",
    editableRoles: ["AGENT", "MANAGER"],
    defaultAllowed: { AGENT: false, MANAGER: false },
  },
  {
    key: PERMISSION.AUDITORIA_ACESSAR,
    group: "Auditoria",
    label: "Acessar log de auditoria",
    description: "Visualizar o histórico de ações realizadas no sistema.",
    editableRoles: ["AGENT", "MANAGER"],
    defaultAllowed: { AGENT: false, MANAGER: false },
  },
  {
    key: PERMISSION.RESPOSTAS_RAPIDAS_GERENCIAR,
    group: "Respostas Rápidas",
    label: "Gerenciar respostas rápidas",
    description: "Cadastrar, editar e excluir as respostas rápidas acionadas no atendimento digitando \"/\".",
    editableRoles: ["AGENT", "MANAGER"],
    defaultAllowed: { AGENT: false, MANAGER: true },
  },
];

export type PermissionMap = Record<Permission, boolean>;
