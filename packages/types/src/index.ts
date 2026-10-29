// Shared types/DTOs used by both apps/api and apps/web.
// Keep this package framework-agnostic (no Express/React/Prisma imports).

export * from "./phone";
export * from "./column-views";
export * from "./contact-name";
import { firstNameWithTitle, normalizeContactName } from "./contact-name";

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
  // An active Fluxo is talking to the customer before any human — kept out
  // of the queue until the flow hands the conversation over.
  IN_FLOW: "IN_FLOW",
  NEW: "NEW",
  WAITING: "WAITING",
  IN_PROGRESS: "IN_PROGRESS",
  TRANSFERRED: "TRANSFERRED",
  CLOSED: "CLOSED",
  ABANDONED: "ABANDONED",
  // A still-unassigned conversation was read directly on the linked phone —
  // it leaves the queue without being attributed to any agent.
  HANDLED_EXTERNALLY: "HANDLED_EXTERNALLY",
  // A WhatsApp group — shown only in Atendimento's Grupos tab, never in the queue or in any metric.
  GROUP: "GROUP",
  // Left by the Fluxo in "Abandonados": the customer stopped answering its menus, or nobody chosen on the transfer step
  // was online. Still open — whoever is online among the flow's people accepts it, like the queue.
  FLOW_ABANDONED: "FLOW_ABANDONED",
} as const;
export type ConversationStatus = (typeof CONVERSATION_STATUS)[keyof typeof CONVERSATION_STATUS];

/** How long "Desfazer" stays available after closing or returning a conversation to the queue. */
export const CONVERSATION_UNDO_WINDOW_MS = 10_000;

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

// Which messaging channel a conversation/contact belongs to — see PROMPT:
// "prepare tudo para integrar com Instagram e Facebook".
export const CHANNEL = {
  WHATSAPP: "WHATSAPP",
  INSTAGRAM: "INSTAGRAM",
  MESSENGER: "MESSENGER",
} as const;
export type Channel = (typeof CHANNEL)[keyof typeof CHANNEL];

/** Who already uses an e-mail typed in the user form: the active user (blocks saving) and the inactive ones that had it. */
export interface UserEmailUseDTO {
  active: string | null;
  inactive: { name: string; deactivatedAt: string | null }[];
}

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
  /** When and by whom the user was last deactivated — null while active. */
  deactivatedAt: string | null;
  deactivatedByName: string | null;
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
  // Set together — both null unless presence is AWAY from a self-initiated
  // pause (see profile.service.ts's pauseOwnAttendance). Lets any screen
  // that shows "Ausente" show the reason instead.
  pauseReasonId: string | null;
  pauseReasonName: string | null;
  pausedAt: string | null;
  // Custom hour range (0-23) saved as this user's default for the Dashboard's
  // "Presença ao longo do dia" chart — both null means "show every hour".
  presenceChartStartHour: number | null;
  presenceChartEndHour: number | null;
  /** Same, for "Conversas que chegam ao longo do dia" (see ArrivalsByHourDTO). */
  arrivalsChartStartHour: number | null;
  arrivalsChartEndHour: number | null;
  // Newest Notas de versão release this user has already seen — null until
  // the first time they open the page or dismiss the "O que há de novo" popup.
  releaseNotesSeenVersion: string | null;
  /** Meu perfil › Sons: play a sound on a new message / a new conversation in the queue; volume 0-100. */
  soundNewMessage: boolean;
  soundNewQueue: boolean;
  soundVolume: number;
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
  /** "Repete todo ano": the same day and month every year (manual holidays only). Listed in every year. */
  recurringYearly: boolean;
}

export interface PauseReasonDTO {
  id: string;
  name: string;
  active: boolean;
}

// Dashboard's "Presença ao longo do dia" chart — one point per hour-of-day
// (0-23), each a count of distinct agent/day occurrences per status seen
// during that hour across the selected period. "counts" keys are "Online"
// plus every pause-reason name that occurred (or "Outros motivos" for an
// AWAY segment whose reason was later deactivated/removed); "series" lists
// those same keys in the order they should be stacked/legended.
export interface PresenceByHourPoint {
  hour: number;
  counts: Record<string, number>;
}

/**
 * Dashboard "Conversas que chegam ao longo do dia": for each hour of the day (0–23, the viewer's time), the new
 * conversations opened by the customer in the period — inside or outside their connection's Horário de expediente
 * (a connection without one counts everything as inside) — and how many attendants were online then, on average
 * over the period's days that reach that hour.
 */
export interface ArrivalsByHourDTO {
  hours: { hour: number; inside: number; outside: number; onlineAvg: number; days: number }[];
  /**
   * How the chart's conversations relate to Gestão's list for the same period: Gestão lists every conversation with
   * any movement in it (withActivity) = opened by the customer in the period (the chart) + started by the team in the
   * period + opened on earlier days.
   */
  summary?: { withActivity: number; openedByCustomer: number; startedByTeam: number; fromEarlierDays: number };
}

export interface PresenceByHourDTO {
  series: string[];
  hours: PresenceByHourPoint[];
}

/** The one image, video or PDF a quick reply or closing message can carry — its text goes along as the caption. */
export interface ReplyMediaDTO {
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  kind: "IMAGE" | "VIDEO" | "DOCUMENT";
}

/** Largest file accepted per kind, in MB — what WhatsApp takes from the system as is, never compressed. */
export interface ReplyMediaLimitsDTO {
  imageMb: number;
  videoMb: number;
  documentMb: number;
}

/** WhatsApp cuts a media caption around here — with an attachment, the reply's text is limited to it. */
export const REPLY_MEDIA_CAPTION_MAX = 1024;

const REPLY_MEDIA_KINDS: Record<string, ReplyMediaDTO["kind"]> = {
  "image/jpeg": "IMAGE",
  "image/png": "IMAGE",
  "image/webp": "IMAGE",
  "video/mp4": "VIDEO",
  "application/pdf": "DOCUMENT",
};

/** The kind of an attachment by its type, or null when it can't be one (only JPG, PNG, WEBP, MP4 and PDF). */
export function replyMediaKind(mimeType: string): ReplyMediaDTO["kind"] | null {
  return REPLY_MEDIA_KINDS[mimeType] ?? null;
}

export interface QuickReplyDTO {
  id: string;
  name: string;
  /** Without the leading "/" — see the QuickReply Prisma model comment. */
  shortcut: string;
  text: string;
  media: ReplyMediaDTO | null;
  /** Which WhatsApp connections a reply, automatic message or closing message applies to. */
  connectionScope: ConnectionScopeDTO;
  createdAt: string;
  updatedAt: string;
  /** In a conversation's picker only: the text with {{dados.coluna}} already filled for this client. */
  filledText?: string;
  /** In a conversation's picker only: uses {{dados.*}} but no data source is usable (managers still see it, agents don't). */
  dataUnavailable?: boolean;
}

/** "Todas as conexões" or an explicit list — shared by respostas rápidas, Transferência/Aceite and Encerramento. */
export interface ConnectionScopeDTO {
  allConnections: boolean;
  connections: { id: string; name: string }[];
}

/** Respostas › Espera na fila — sent `delayMinutes` after the previous one (the first: after entering the queue), only inside the Horário de expediente. */
export interface QueueWaitMessageDTO {
  id: string;
  /** 1, 2, 3… — the order they go out in. */
  position: number;
  delayMinutes: number;
  text: string;
  media: ReplyMediaDTO | null;
  active: boolean;
  connectionScope: ConnectionScopeDTO;
  createdAt: string;
  updatedAt: string;
}

export interface ClosingMessageDTO {
  id: string;
  name: string;
  text: string;
  media: ReplyMediaDTO | null;
  active: boolean;
  /** The "*Nome:*" of whoever closed on top of the text the customer gets. */
  showSenderName: boolean;
  /** Users who get this message auto-sent when they click Encerrar — a user appears in at most one ClosingMessage's list at a time. */
  assignedUsers: { id: string; displayName: string }[];
  connectionScope: ConnectionScopeDTO;
  createdAt: string;
  updatedAt: string;
}

export type MessageTemplateCategory = "MARKETING" | "UTILITY" | "AUTHENTICATION";
export type MessageTemplateHeaderType = "NONE" | "TEXT" | "IMAGE" | "VIDEO" | "DOCUMENT";
export type MessageTemplateStatus = "DRAFT" | "PENDING" | "APPROVED" | "REJECTED" | "PAUSED" | "DISABLED";
export type MessageTemplateButton =
  | { type: "QUICK_REPLY"; text: string }
  | { type: "URL"; text: string; url: string }
  | { type: "PHONE_NUMBER"; text: string; phoneNumber: string };

/** A WhatsApp message template submitted for Meta's approval — see PROMPT: "nova aba chamada Templates... nas categorias de Marketing, Utilidade e Autenticação". Only ever tied to an OFFICIAL_API connection. */
export interface MessageTemplateDTO {
  id: string;
  name: string;
  category: MessageTemplateCategory;
  language: string;
  headerType: MessageTemplateHeaderType;
  headerText: string | null;
  /** Non-null only when headerType is IMAGE/VIDEO/DOCUMENT and a sample was uploaded. */
  headerSampleFileName: string | null;
  headerSampleUrl: string | null;
  bodyText: string;
  footerText: string | null;
  buttons: MessageTemplateButton[];
  whatsappConnectionId: string;
  whatsappConnectionName: string;
  status: MessageTemplateStatus;
  rejectionReason: string | null;
  createdAt: string;
  updatedAt: string;
}

/** WhatsApp Oficial: whether a free-text reply still fits the 24h customer window, and the approved templates usable otherwise. */
export interface TemplateContextDTO {
  official: boolean;
  windowOpen: boolean;
  windowClosesAt: string | null;
  templates: MessageTemplateDTO[];
}

export type FlowNodeType = "START" | "TEXT_MESSAGE" | "MENU" | "TRANSFER_TO_AGENT" | "BUSINESS_HOURS" | "END";

/** Exits of a BUSINESS_HOURS node — used as its FlowEdgeDTO.sourceHandle values. */
export const FLOW_HOURS_OPEN = "open";
export const FLOW_HOURS_CLOSED = "closed";

/**
 * BUSINESS_HOURS config: the Horário de expediente picked in Respostas (none = always open). `days`/`start`/`end`/`tzOffsetMinutes`
 * (weekdays, 0 = domingo, the HH:mm window, and the editor's own UTC offset in minutes as Date.getTimezoneOffset reports it) only exist on
 * nodes saved before schedules did, and keep working until a schedule is picked.
 */
export interface FlowBusinessHoursData {
  workScheduleId?: string | null;
  days?: number[];
  start?: string;
  end?: string;
  tzOffsetMinutes?: number;
}

export const FLOW_MENU_DEFAULT_PROMPT = "Escolha uma opção respondendo com o número:";

/** Minutes without an answer to a menu before the customer goes to Abandonados — the default of the Início step. */
export const FLOW_ABANDON_AFTER_MINUTES_DEFAULT = 30;

/** The photo a message or menu step sends (stored with the uploads, like a quick reply's attachment). */
export interface FlowImage {
  storageKey: string;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
}

/** START config: the flow-wide settings. */
export interface FlowStartData {
  /** Outside the entry connection's Horário de expediente, the flow first tells the hours and asks whether to go on. */
  outOfHoursPrompt?: boolean;
  /** Minutes without an answer to a menu before going to Abandonados. */
  abandonAfterMinutes?: number;
}

/** Placeholders a flow's texts can carry — {{opcao}} is the option the customer picked last. */
export function renderFlowText(text: string, vars: { cliente: string; opcao?: string | null }): string {
  return text.replace(/\{\{\s*cliente\s*\}\}/gi, vars.cliente).replace(/\{\{\s*opcao\s*\}\}/gi, vars.opcao ?? "");
}

/** Exactly what the customer receives for a MENU node — shared by the engine and the editor's WhatsApp preview. */
export function renderFlowMenuText(data: { prompt?: string; options: FlowMenuOption[] }): string {
  const prompt = data.prompt?.trim() || FLOW_MENU_DEFAULT_PROMPT;
  return [prompt, ...data.options.map((o, i) => `${i + 1}. ${o.label}`)].join("\n");
}

/** One option of a MENU node — its `id` doubles as the FlowEdgeDTO.sourceHandle the chosen branch leaves from. */
export interface FlowMenuOption {
  id: string;
  label: string;
}

/**
 * The navigation options a menu adds after its own on the QR Code (all on unless switched off on the node):
 * "Voltar" to the menu before, "Menu inicial" to the flow's first menu (neither on the first menu itself) and
 * "Encerrar atendimento", which closes the conversation with no satisfaction survey.
 */
export interface FlowMenuNavigation {
  back?: boolean;
  home?: boolean;
  end?: boolean;
}

export const FLOW_MENU_NAV_OPTIONS = {
  back: { id: "__nav_back__", label: "Voltar" },
  home: { id: "__nav_home__", label: "Menu inicial" },
  end: { id: "__nav_end__", label: "Encerrar atendimento" },
} as const satisfies Record<keyof FlowMenuNavigation, FlowMenuOption>;

/** The navigation options a menu shows — `hasPrevious` is false on the first menu the customer sees. */
export function flowMenuNavOptions(navigation: FlowMenuNavigation | undefined, hasPrevious: boolean): FlowMenuOption[] {
  const on = (key: keyof FlowMenuNavigation) => navigation?.[key] !== false;
  return [
    ...(hasPrevious && on("back") ? [FLOW_MENU_NAV_OPTIONS.back] : []),
    ...(hasPrevious && on("home") ? [FLOW_MENU_NAV_OPTIONS.home] : []),
    ...(on("end") ? [FLOW_MENU_NAV_OPTIONS.end] : []),
  ];
}

/**
 * Node-type-specific config — which shape applies is driven by the node's
 * own `type`. assignedAgentIds on TRANSFER_TO_AGENT is empty by default
 * (any agent on the connection's queue); see PROMPT: "para quais
 * atendentes serão designados para ser configurado no nó".
 */
export type FlowNodeData = { name?: string } & (
  | { text?: string; image?: FlowImage | null } // TEXT_MESSAGE
  | { options: FlowMenuOption[]; prompt?: string; image?: FlowImage | null; navigation?: FlowMenuNavigation } // MENU — prompt defaults to FLOW_MENU_DEFAULT_PROMPT
  | FlowBusinessHoursData // BUSINESS_HOURS
  | { assignedAgentIds: string[]; mode?: "any" | "selected" } // TRANSFER_TO_AGENT — "selected": those people attend it, from any connection
  | FlowStartData // START
  | Record<string, never> // END — no config
);

/** The step's own name (shown on the drawing and in the notes), or null. */
export function flowNodeName(node: { data: unknown }): string | null {
  const name = (node.data as { name?: string } | null)?.name?.trim();
  return name || null;
}

export interface FlowNodeDTO {
  id: string;
  type: FlowNodeType;
  positionX: number;
  positionY: number;
  data: FlowNodeData;
}

export interface FlowEdgeDTO {
  id: string;
  sourceNodeId: string;
  targetNodeId: string;
  sourceHandle: string | null;
}

/** Fluxo — visual chatbot flow builder (menu "Fluxo"). See PROMPT: "um novo menu chamado Fluxo... função de ativar e desativar o fluxo". */
export interface FlowListItemDTO {
  id: string;
  name: string;
  description: string | null;
  active: boolean;
  connectionIds: string[];
  connectionNames: string[];
  nodeCount: number;
  /** Tiny layout of the graph for the list's thumbnail: node positions/types and edges as node-index pairs. */
  preview: { nodes: { x: number; y: number; type: FlowNodeType }[]; edges: [number, number][] };
  /** Problems that would block activation (see validateFlowGraph). */
  issues: FlowIssue[];
  createdByUserName: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface FlowIssue {
  /** The node the problem is on (null = the flow as a whole, e.g. no connection). */
  nodeId: string | null;
  message: string;
}

/**
 * What must hold before a flow can be switched on — shared by the API (which
 * refuses activation) and the editor (which marks the offending nodes).
 */
export function validateFlowGraph(input: { nodes: FlowNodeDTO[]; edges: Pick<FlowEdgeDTO, "sourceNodeId" | "sourceHandle">[]; connectionCount: number }): FlowIssue[] {
  const issues: FlowIssue[] = [];
  if (input.connectionCount === 0) issues.push({ nodeId: null, message: "Vincule pelo menos uma conexão" });
  const hasExit = (nodeId: string, handle: string | null) =>
    input.edges.some((e) => e.sourceNodeId === nodeId && (e.sourceHandle ?? null) === handle);
  for (const node of input.nodes) {
    if (node.type === "START" && !hasExit(node.id, null)) issues.push({ nodeId: node.id, message: "O Início não leva a nenhum passo" });
    if (node.type === "TEXT_MESSAGE") {
      const text = (node.data as { text?: string }).text?.trim();
      if (!text) issues.push({ nodeId: node.id, message: "Mensagem sem texto" });
      if (!hasExit(node.id, null)) issues.push({ nodeId: node.id, message: "Mensagem sem próximo passo" });
    }
    if (node.type === "MENU") {
      const options = (node.data as { options?: FlowMenuOption[] }).options ?? [];
      if (options.length === 0) issues.push({ nodeId: node.id, message: "Menu sem opções" });
      for (const option of options) {
        if (!option.label.trim()) issues.push({ nodeId: node.id, message: "Opção do menu sem nome" });
        else if (!hasExit(node.id, option.id)) issues.push({ nodeId: node.id, message: `Opção “${option.label}” sem destino` });
      }
    }
    if (node.type === "BUSINESS_HOURS") {
      const data = node.data as Partial<FlowBusinessHoursData>;
      // Only a node still on its own (pre-schedule) hours has anything to check; one with a schedule — or none — is valid.
      if (!data.workScheduleId && data.days) {
        if (!data.days.length) issues.push({ nodeId: node.id, message: "Horário sem dias da semana" });
        if (!data.start || !data.end || data.start >= data.end) issues.push({ nodeId: node.id, message: "Horário de início deve ser antes do fim" });
      }
      if (!hasExit(node.id, FLOW_HOURS_OPEN)) issues.push({ nodeId: node.id, message: "Horário sem destino para “Aberto”" });
      if (!hasExit(node.id, FLOW_HOURS_CLOSED)) issues.push({ nodeId: node.id, message: "Horário sem destino para “Fechado”" });
    }
    if (node.type === "TRANSFER_TO_AGENT") {
      const data = node.data as { assignedAgentIds?: string[]; mode?: "any" | "selected" };
      if (data.mode === "selected" && (data.assignedAgentIds ?? []).length === 0) {
        issues.push({ nodeId: node.id, message: "Nenhum atendente selecionado" });
      }
    }
  }
  return issues;
}

/** Full graph for the canvas — fetched once per flow when opening the editor. */
export interface FlowDetailDTO extends FlowListItemDTO {
  nodes: FlowNodeDTO[];
  edges: FlowEdgeDTO[];
}

/** A missed-you-live event surfaced in the Topbar bell — see NotificationBell. entityType/entityId (e.g. "Conversation"/id) drive where clicking it navigates. */
export interface NotificationDTO {
  id: string;
  type: string;
  title: string;
  body: string | null;
  entityType: string | null;
  entityId: string | null;
  readAt: string | null;
  createdAt: string;
}

export type AutoMessageTrigger = "TRANSFER" | "ACCEPT";

/**
 * One pesquisa de satisfação (NPS) of Respostas › Pesquisa. Several can exist — the ones that ship are templates,
 * all off — but only active ones are sent: per conversation, the one chosen for its connection, else one for all
 * connections (the most recently updated, if more than one applies).
 */
export interface SatisfactionSurveyDTO {
  id: string;
  name: string;
  active: boolean;
  connectionScope: ConnectionScopeDTO;
  /**
   * Sent after the conversation is closed (and the "Desfazer" window has passed);
   * the customer answers with a number from 0 to 10. Saving a different text
   * starts a new question — the previous one stays in the Dashboard history.
   */
  question: string;
  /** Sent after a valid score. */
  thanks: string;
  /** How long after sending a reply still counts as the answer. */
  answerWindowHours: number;
  /**
   * The agent's closing message waits for the score: it goes out 10 seconds after
   * the customer answers, or this many minutes after the question if they never
   * do. Never longer than the answer window.
   */
  closingWaitMinutes: number;
  createdAt: string;
  updatedAt: string;
}

/** NPS of one survey question: 9–10 promoters, 7–8 passives, 0–6 detractors. */
export interface SatisfactionQuestionSummaryDTO {
  /** null → surveys sent before the 0–10 scale existed (the old nota de 1 a 5). */
  questionId: string | null;
  question: string;
  /** The question currently set in Respostas › Pesquisa. */
  current: boolean;
  /** 10 for the NPS scale, 5 for those old surveys. */
  scaleMax: 5 | 10;
  sent: number;
  answered: number;
  /** null while nobody answered in the period. */
  average: number | null;
  /** Answers per score — index is the score (0 to 10). */
  distribution: number[];
  promoters: number;
  passives: number;
  detractors: number;
  /** NPS from 0 to 100 (see npsFromCounts). null without answers, and for the old 1–5 scale. */
  nps: number | null;
}

/** NPS buckets of a group of answers (0–10 scale): 9–10 promoters, 7–8 passives, 0–6 detractors. */
export interface SatisfactionScoreStatsDTO {
  sent: number;
  answered: number;
  /** Surveys whose time to answer ran out without a score (still-open ones are not counted). */
  unanswered: number;
  /** answered ÷ sent × 100, rounded; null when nothing was sent. */
  responseRate: number | null;
  /** Average score, one decimal; null without answers. */
  average: number | null;
  /** NPS from 0 to 100 (see npsFromCounts); null without answers. */
  nps: number | null;
  promoters: number;
  passives: number;
  detractors: number;
}

/**
 * NPS on the 0 to 100 scale the system shows everywhere: the share of promoters (9–10) minus the share of
 * detractors (0–6), taken from −100…+100 to 0…100 — 0 when every answer is a detractor, 50 when promoters
 * and detractors are even, 100 when every answer is a promoter. null without answers.
 */
export function npsFromCounts(promoters: number, detractors: number, answered: number): number | null {
  if (!answered) return null;
  return Math.round(50 + ((promoters - detractors) / answered) * 50);
}

/** The NPS zones on the 0–100 scale — the usual reading (excelência, qualidade, aperfeiçoamento, crítica). */
export const NPS_ZONES = [
  { min: 88, label: "Zona de excelência", tone: "success" },
  { min: 75, label: "Zona de qualidade", tone: "primary" },
  { min: 50, label: "Zona de aperfeiçoamento", tone: "warning" },
  { min: 0, label: "Zona crítica", tone: "danger" },
] as const;

export function npsZoneOf(nps: number): (typeof NPS_ZONES)[number] {
  return NPS_ZONES.find((z) => nps >= z.min) ?? NPS_ZONES[NPS_ZONES.length - 1];
}

/** Below this many answers, one score moves an NPS a lot — shown, but flagged "amostra pequena". */
export const NPS_SMALL_SAMPLE = 5;

/** Respostas › Pesquisa › Relatórios e apresentação: the NPS goal and how the presentation names customers. */
export interface SatisfactionSettingsDTO {
  /** NPS goal from 0 to 100 — a line on the charts and "acima/abaixo da meta"; null = no goal. */
  npsGoal: number | null;
  /** In the presentation (PPT): the customer's name and number, or only the initials. */
  presentationCustomer: "full" | "initials";
}

/** The same numbers for the period right before, with the same length — for "▲ 6 pontos". */
export interface SatisfactionPreviousDTO {
  from: string;
  to: string;
  nps: number | null;
  average: number | null;
  answered: number;
  responseRate: number | null;
}

/** Relatórios › Pesquisa de satisfação — only the 0–10 (NPS) surveys of the period. */
export interface SatisfactionReportDTO {
  totals: SatisfactionScoreStatsDTO & {
    /** Answers per score — index is the score (0 to 10). */
    distribution: number[];
    /** Sent and still waiting for the customer's score. */
    awaiting: number;
  };
  byAgent: (SatisfactionScoreStatsDTO & {
    agentId: string | null;
    agentName: string;
    lowest: number | null;
    highest: number | null;
    /** Their NPS in the period before (null when they had no answers then). */
    previousNps: number | null;
  })[];
  byConnection: (SatisfactionScoreStatsDTO & { connectionId: string; connectionName: string; connectionColor: string })[];
  /** Day by day (or week by week, for periods longer than a month), oldest first. */
  trend: { start: string; label: string; answered: number; average: number | null; nps: number | null }[];
  /** Every survey of the period, newest first (answered or not). */
  responses: SatisfactionResponseDTO[];
  /** The period right before, same length. */
  previous: SatisfactionPreviousDTO;
  /** The question being asked now (the one of a survey that is on), as the customer gets it — null when none is on. */
  currentQuestion: string | null;
  settings: SatisfactionSettingsDTO;
}

/**
 * Dashboard › Pesquisa de satisfação: the same numbers as Relatórios › Pesquisa de satisfação (both count every
 * 0–10 survey of the period). `byAgent` and `latest` (5 detractors, 5 passives, 5 promoters) come only for
 * Gestor and Administrador — they name customers.
 */
export interface SatisfactionOverviewDTO {
  totals: SatisfactionReportDTO["totals"];
  previous: SatisfactionPreviousDTO;
  currentQuestion: string | null;
  settings: SatisfactionSettingsDTO;
  byAgent: SatisfactionReportDTO["byAgent"] | null;
  latest: Record<SatisfactionCategory, SatisfactionResponseDTO[]> | null;
}

export type SatisfactionCategory = "promoter" | "passive" | "detractor";

export interface SatisfactionResponseDTO {
  surveyId: string;
  conversationId: string;
  sentAt: string;
  answeredAt: string | null;
  contactName: string | null;
  contactPhone: string | null;
  agentName: string | null;
  connectionName: string;
  surveyName: string | null;
  question: string | null;
  score: number | null;
  /** What the customer wrote (null on old surveys whose answer could not be found). */
  answerText: string | null;
  /** The score the current reading rules get from answerText, when it differs from score — a reading to review. */
  rereadScore: number | null;
  /** Set when a manager fixed the score: what had been read, and who fixed it. */
  correction: { originalScore: number | null; byName: string | null; at: string } | null;
  category: SatisfactionCategory | null;
  /** answered, awaiting (still inside the answer window) or expired (the customer never answered). */
  status: "answered" | "awaiting" | "expired";
}

export interface SatisfactionSummaryDTO {
  sent: number;
  answered: number;
  /** One entry per question that was sent in the period — the current one first, then older ones, newest first. */
  questions: SatisfactionQuestionSummaryDTO[];
}

/** Customer-facing notice auto-sent by the system (not an agent) on TRANSFER/ACCEPT — supports {{atendente}}/{{cliente}} tags. See Respostas > Transferência/Aceite. */
export interface AutoMessageTemplateDTO {
  id: string;
  trigger: AutoMessageTrigger;
  name: string;
  text: string;
  active: boolean;
  /** The "*Nome:*" of whoever triggered it on top of the text the customer gets. */
  showSenderName: boolean;
  connectionScope: ConnectionScopeDTO;
  /** Who it is sent for: everyone, or only when one of `users` takes the conversation (Respostas › Aceite › "Quem pode usar"). */
  userScope: UserScopeDTO;
  createdAt: string;
  updatedAt: string;
}

/** One open window of a weekday — `allDay` is "Atender 24h"; otherwise `start`/`end` are HH:mm with start before end. */
export type WorkScheduleWindowDTO = { allDay: true } | { allDay?: false; start: string; end: string };

/** A weekday missing from the map is closed. */
export type WorkScheduleDaysDTO = Partial<Record<WeekdayKey, WorkScheduleWindowDTO>>;

const WEEKDAY_SHORT_PT: Record<WeekdayKey, string> = { MON: "Seg", TUE: "Ter", WED: "Qua", THU: "Qui", FRI: "Sex", SAT: "Sáb", SUN: "Dom" };

/** The open hours as the customer reads them — consecutive days with the same hours together: "Seg a Sex, 07:00 às 18:00 · Sáb, 07:00 às 11:00". */
export function describeWorkScheduleDays(days: WorkScheduleDaysDTO): string {
  const windowText = (w: WorkScheduleWindowDTO) => (w.allDay ? "24 horas" : `${w.start} às ${w.end}`);
  const groups: { first: WeekdayKey; last: WeekdayKey; hours: string }[] = [];
  for (const day of WEEKDAY_KEYS) {
    const window = days[day];
    if (!window) continue;
    const hours = windowText(window);
    const previous = groups[groups.length - 1];
    if (previous && previous.hours === hours && WEEKDAY_KEYS.indexOf(previous.last) === WEEKDAY_KEYS.indexOf(day) - 1) previous.last = day;
    else groups.push({ first: day, last: day, hours });
  }
  return groups
    .map((g) => {
      const span = WEEKDAY_KEYS.indexOf(g.last) - WEEKDAY_KEYS.indexOf(g.first);
      const label = span === 0 ? WEEKDAY_SHORT_PT[g.first] : `${WEEKDAY_SHORT_PT[g.first]} ${span === 1 ? "e" : "a"} ${WEEKDAY_SHORT_PT[g.last]}`;
      return `${label}, ${g.hours}`;
    })
    .join(" · ");
}

/** A holiday that opens part of the day; every other holiday stays closed all day. */
export interface WorkSchedulePartialHolidayDTO {
  /** YYYY-MM-DD */
  date: string;
  start: string;
  end: string;
}

/** Respostas › Horário de expediente. `state` sets the time zone, `state` + `city` the holidays that apply. */
export interface WorkScheduleDTO {
  id: string;
  name: string;
  state: string;
  city: string;
  days: WorkScheduleDaysDTO;
  partialHolidays: WorkSchedulePartialHolidayDTO[];
  /** Sent once per conversation when the customer writes outside the hours; supports {{cliente}}. */
  closedMessage: string;
  /** The connections that follow this schedule. */
  connections: { id: string; name: string }[];
  createdAt: string;
  updatedAt: string;
}

/** Id + name, for the pickers in Conexões and in the Fluxo's hours node. */
export interface WorkScheduleOptionDTO {
  id: string;
  name: string;
}

/** A holiday that applies to a schedule's state/city — what "feriado parcial" is picked from. */
export interface WorkScheduleHolidayDTO {
  /** YYYY-MM-DD */
  date: string;
  name: string;
}

/** Minutes WEST of UTC (what Date.getTimezoneOffset reports) by state: the west of the country is UTC−4/−5, the rest Brasília time. Brazil has no daylight saving. */
export const BR_STATE_UTC_OFFSET_MINUTES: Record<string, number> = { AC: 300, AM: 240, MT: 240, MS: 240, RO: 240, RR: 240 };
export const BR_DEFAULT_UTC_OFFSET_MINUTES = 180;

export function stateUtcOffsetMinutes(state: string): number {
  return BR_STATE_UTC_OFFSET_MINUTES[state] ?? BR_DEFAULT_UTC_OFFSET_MINUTES;
}

/**
 * A connection's Horário de expediente as the screen needs it to count a wait only while open ("na fila há",
 * "sem resposta há"): the state (time zone), the week, the partial holidays and the holidays (closed days) around now.
 */
export interface BusinessClockDTO {
  state: string;
  days: WorkScheduleDaysDTO;
  partialHolidays: WorkSchedulePartialHolidayDTO[];
  /** YYYY-MM-DD days that are holidays for this connection's place (closed, unless in partialHolidays). */
  holidays: string[];
}

const BUSINESS_DAY_MS = 86_400_000;
const BUSINESS_WEEKDAYS: WeekdayKey[] = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"];
const businessMinutes = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));

/** Milliseconds between `start` and `end` (epoch ms) inside the open hours; no clock = 24 hours, the plain difference. */
export function businessMsBetween(clock: BusinessClockDTO | null | undefined, start: number, end: number): number {
  if (end <= start) return 0;
  if (!clock) return end - start;
  const offsetMs = stateUtcOffsetMinutes(clock.state) * 60_000;
  const holidays = new Set(clock.holidays);
  let dayStart = Math.floor((start - offsetMs) / BUSINESS_DAY_MS) * BUSINESS_DAY_MS + offsetMs;
  let total = 0;
  while (dayStart < end) {
    const local = new Date(dayStart - offsetMs);
    const dateKey = local.toISOString().slice(0, 10);
    let windows: [number, number][] = [];
    if (holidays.has(dateKey)) {
      const partial = clock.partialHolidays.find((h) => h.date === dateKey);
      if (partial) windows = [[businessMinutes(partial.start), businessMinutes(partial.end)]];
    } else {
      const w = clock.days[BUSINESS_WEEKDAYS[local.getUTCDay()]];
      if (w) windows = w.allDay ? [[0, 1440]] : [[businessMinutes(w.start), businessMinutes(w.end)]];
    }
    for (const [a, b] of windows) total += Math.max(0, Math.min(dayStart + b * 60_000, end) - Math.max(dayStart + a * 60_000, start));
    dayStart += BUSINESS_DAY_MS;
  }
  return total;
}

/** Whether the clock is open at `at` (epoch ms): the next minute counts. */
export function isBusinessOpenAt(clock: BusinessClockDTO | null | undefined, at: number): boolean {
  return businessMsBetween(clock, at, at + 60_000) > 0;
}

export interface UserScopeDTO {
  allUsers: boolean;
  /** Empty when allUsers. */
  users: { id: string; displayName: string }[];
}

export interface WhatsAppConnectionSummaryDTO {
  id: string;
  name: string;
  color: string;
  /** Respostas › Horário de expediente this connection follows; null = open 24 hours. */
  workScheduleId: string | null;
  state: WhatsAppConnectionStatus;
  qrCodeDataUrl: string | null;
  pairingCode: string | null;
  pairingCodeExpiresAt?: string | null;
  pairingPhoneNumber?: string | null;
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
  // null when WhatsApp hasn't revealed this contact's real phone number yet
  // (still only known by its opaque @lid privacy id) — see
  // conversations.mapper.ts. Never the meaningless @lid digits: those look
  // like a real number but aren't one an agent could recognize or call.
  phone: string | null;
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
  /** Gestão › Intervir: who took over replying, while they have it. The assigned agent then only follows and leaves notes. */
  intervention: { userId: string; name: string; startedAt: string } | null;
  // Which channel this conversation is on — drives which icon/label
  // ConversationCard shows. WhatsAppConnection*/below stays populated
  // (with the owning MetaConnection's data, not just WhatsApp's) for every
  // channel so existing consumers keep working unchanged; new code should
  // prefer `channel` to decide how to label/icon it.
  channel: Channel;
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
  // When the customer's oldest still-unanswered message arrived (null when
  // the last word was the agent's) — drives "sem resposta há X min".
  awaitingReplySince: string | null;
  /** Falta de retorno: the reminder already went out and the conversation closes by itself at this time ("⏳ encerra em N min"). */
  noReturnCloseAt: string | null;
  /** "Não encerrar automaticamente": the agent paused the automatic close until the customer answers. */
  noReturnHold: boolean;
  /** The connection's Horário de expediente: waits shown on screen count only while it is open. Null = 24 hours. */
  businessClock?: BusinessClockDTO | null;
  /** Automatic messages this customer does not get, because of a tag (Etiquetas › "Não enviar estas mensagens automáticas"). */
  autoMessageBlocks?: AutoMessageBlockDTO[];
  /** The contact's tags, shown on the card beside the number (up to 3, then "+N"). */
  tags?: CardTagDTO[];
  /** A scheduled message is still to go out: the "falta de retorno" close is paused, and the manual one blocked. */
  scheduledMessagePending?: boolean;
  /** People of the contact's contracts with a birthday today — the 🎂 on the card. */
  birthdaysToday?: BirthdayTodayDTO[];
  /** Started or answered on the linked phone — accepting it sends no "Aceite" message. */
  startedOnDevice: boolean;
  unreadCount: number;
  isNew: boolean;
  pendingTransferDeadline: string | null;
  transfer: {
    fromAgentName: string;
    toAgentName: string;
    at: string;
    note: string | null;
  } | null;
  /** Gestão search only: the latest message that contains the searched text. */
  searchMatch?: string | null;
}

/** Gestão › "Linhas por página". */
export const OVERSIGHT_PAGE_SIZES = [50, 100, 200, 300] as const;
export type OversightPageSize = (typeof OVERSIGHT_PAGE_SIZES)[number];

/** One page of Gestão's list: the total and each status' count cover the whole search, not only this page. */
export interface OversightPageDTO {
  items: ConversationListItemDTO[];
  total: number;
  page: number;
  pageSize: number;
  /** Every status in the search (period, attendant, connection, text) — what the status chips show. */
  statusCounts: Partial<Record<ConversationStatus, number>>;
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
  /** A copy sent with "Encaminhar" from another message. */
  forwarded: boolean;
  /** Set when this message replies to a WhatsApp Status/Story rather than to another message in the conversation — the story itself is never fetched/stored, only the small preview WhatsApp embeds directly in the reply. Deliberately carries no id/link to navigate to: there is nothing to navigate to. */
  replyToStory: { text: string | null; thumbnailUrl: string | null } | null;
  /** Link-preview card (WhatsApp Web parity) for a TEXT message whose body contains a URL. */
  linkPreview: { title: string; description: string | null; url: string; thumbnailUrl: string | null } | null;
  attachments: MessageAttachmentDTO[];
  reactions: MessageReactionDTO[];
  /** Group messages only (inbound): who in the group wrote it. `color` is fixed per person. */
  senderParticipant?: { name: string; phone: string | null; color: string } | null;
}

/** One person of the team who can see a WhatsApp group, and how far they have read it. */
export interface GroupReaderDTO {
  userId: string;
  name: string;
  photoUrl: string | null;
  /** Hasn't opened the group since they got access to it. */
  neverOpened: boolean;
  lastReadAt: string | null;
  unreadCount: number;
  isMe: boolean;
}

/** A WhatsApp group in Atendimento's Grupos tab. Unread counts are the logged-in person's own. */
export interface GroupListItemDTO {
  id: string;
  name: string;
  photoUrl: string | null;
  participantsCount: number | null;
  whatsappConnectionId: string;
  whatsappConnectionName: string;
  whatsappConnectionColor: string;
  whatsappConnectionStatus: WhatsAppConnectionStatus;
  lastMessageAt: string;
  lastMessagePreview: { senderName: string; text: string } | null;
  unreadCount: number;
  myLastReadAt: string | null;
  muted: boolean;
  readers: GroupReaderDTO[];
}

export interface GroupParticipantDTO {
  /** WhatsApp id — what an "@" mention points to. */
  jid: string;
  name: string;
  phone: string | null;
  isAdmin: boolean;
}

export interface GroupsSummaryDTO {
  /** How many groups have messages this person hasn't read. */
  groupsWithUnread: number;
  unreadMessages: number;
}

export interface MessageAttachmentDTO {
  id: string;
  /** VIDEO: a WhatsApp GIF — plays by itself, in a loop, muted. */
  isGif?: boolean;
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
  /** POLL only — the poll's option labels. */
  pollOptions?: string[];
  /** POLL only: several answers allowed (WhatsApp's "Selecionar uma ou mais opções"). */
  pollMultiple?: boolean;
  /** POLL only: the votes, as WhatsApp Web shows them — read-only here. */
  pollResults?: PollResultsDTO;
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
  /** An address inside the network (the server itself, a proxy) — it has no place on the map. */
  ipInternal: boolean;
  /** Approximate place of the IP (city, state, country), when known. */
  ipPlace: { label: string; latitude: number; longitude: number } | null;
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
  // WhatsApp groups (Atendimento's Grupos tab) — only on connections where an administrator turned groups on.
  ATENDIMENTO_GRUPOS_VISUALIZAR: "atendimento.grupos.visualizar",
  ATENDIMENTO_GRUPOS_RESPONDER: "atendimento.grupos.responder",
  GESTAO_ACESSAR: "gestao.acessar",
  // Layered ON TOP of GESTAO_ACESSAR (need both) — see that key's own doc
  // comment.
  GESTAO_GERENCIAR: "gestao.gerenciar",
  GESTAO_INTERVIR: "gestao.intervir",
  DASHBOARD_ACESSAR: "dashboard.acessar",
  RELATORIOS_ACESSAR: "relatorios.acessar",
  // Fix a satisfaction score the system read wrong from the customer's text.
  RELATORIOS_PESQUISA_CORRIGIR: "relatorios.pesquisa.corrigir",
  // Usuários — split from the old single USUARIOS_GERENCIAR into granular
  // visualizar/adicionar/editar/inativar. Hard delete (irreversible) stays
  // ADMIN-only via requireRole, same as before — never part of this matrix.
  // See PROMPT: "na me referi em apenas as pausas, mas sim tudo que é
  // evitável, cadastravel e visualizarem".
  USUARIOS_VISUALIZAR: "usuarios.visualizar",
  USUARIOS_ADICIONAR: "usuarios.adicionar",
  USUARIOS_EDITAR: "usuarios.editar",
  USUARIOS_INATIVAR: "usuarios.inativar",
  CONFIGURACOES_GERENCIAR: "configuracoes.gerenciar",
  // Each layered ON TOP of CONFIGURACOES_GERENCIAR (need both) — see that
  // key's own doc comment. Identidade visual/E-mail/Modelos de e-mail are
  // each a single record to edit (no list to add/remove from), so they only
  // split into visualizar/editar — unlike Feriados, which is a real list.
  CONFIGURACOES_IDENTIDADE_VISUALIZAR: "configuracoes.identidade.visualizar",
  CONFIGURACOES_IDENTIDADE_EDITAR: "configuracoes.identidade.editar",
  CONFIGURACOES_EMAIL_VISUALIZAR: "configuracoes.email.visualizar",
  CONFIGURACOES_EMAIL_EDITAR: "configuracoes.email.editar",
  CONFIGURACOES_EMAIL_MODELOS_VISUALIZAR: "configuracoes.email_modelos.visualizar",
  CONFIGURACOES_EMAIL_MODELOS_EDITAR: "configuracoes.email_modelos.editar",
  CONFIGURACOES_FERIADOS_VISUALIZAR: "configuracoes.feriados.visualizar",
  CONFIGURACOES_FERIADOS_ADICIONAR: "configuracoes.feriados.adicionar",
  CONFIGURACOES_FERIADOS_EDITAR: "configuracoes.feriados.editar",
  CONFIGURACOES_FERIADOS_EXCLUIR: "configuracoes.feriados.excluir",
  // Single record (the queue reminder's interval, see business settings),
  // so only visualizar/editar — same pattern as Identidade visual/E-mail.
  CONFIGURACOES_FILA_VISUALIZAR: "configuracoes.fila.visualizar",
  CONFIGURACOES_FILA_EDITAR: "configuracoes.fila.editar",
  // Single record (how a typed phone number is completed), so only
  // visualizar/editar — same pattern as Fila.
  CONFIGURACOES_TELEFONE_VISUALIZAR: "configuracoes.telefone.visualizar",
  CONFIGURACOES_TELEFONE_EDITAR: "configuracoes.telefone.editar",
  // Column views saved from the ⋮ menu of each table — list them, and edit
  // their columns/order and who can use them.
  CONFIGURACOES_VISOES_VISUALIZAR: "configuracoes.visoes.visualizar",
  CONFIGURACOES_VISOES_EDITAR: "configuracoes.visoes.editar",
  AUDITORIA_ACESSAR: "auditoria.acessar",
  FONTES_DADOS_VER: "fontes_dados.ver",
  FONTES_DADOS_ADICIONAR: "fontes_dados.adicionar",
  FONTES_DADOS_EDITAR: "fontes_dados.editar",
  FONTES_DADOS_EXCLUIR: "fontes_dados.excluir",
  CLIENTE_DADOS_SENSIVEIS_VER: "cliente.dados_sensiveis_ver",
  CHAT_INTERNO_USAR: "chat_interno.usar",
  CHAT_INTERNO_ACOMPANHAR: "chat_interno.acompanhar",
  CONTATOS_ACESSAR: "contatos.acessar",
  CONTATOS_EDITAR: "contatos.editar",
  CONTATOS_IMPORTAR_EXPORTAR: "contatos.importar_exportar",
  ETIQUETAS_VISUALIZAR: "etiquetas.visualizar",
  ETIQUETAS_ADICIONAR: "etiquetas.adicionar",
  ETIQUETAS_EDITAR: "etiquetas.editar",
  ETIQUETAS_EXCLUIR: "etiquetas.excluir",
  ETIQUETAS_BLOQUEIOS: "etiquetas.mensagens_bloqueadas",
  CONTATOS_OBSERVACAO_EDITAR: "contatos.observacao_editar",
  RESPOSTAS_RAPIDAS_GERENCIAR: "respostas_rapidas.gerenciar",
  // Each layered ON TOP of RESPOSTAS_RAPIDAS_GERENCIAR (need both) — see
  // that key's own doc comment. Respostas rápidas itself now also gets its
  // own granular set here (it used to rely on RESPOSTAS_RAPIDAS_GERENCIAR
  // alone for both the menu umbrella AND its own tab — those are now split
  // apart, same as every sibling tab below).
  RESPOSTAS_RAPIDAS_VISUALIZAR: "respostas_rapidas.visualizar",
  RESPOSTAS_RAPIDAS_ADICIONAR: "respostas_rapidas.adicionar",
  RESPOSTAS_RAPIDAS_EDITAR: "respostas_rapidas.editar",
  RESPOSTAS_RAPIDAS_EXCLUIR: "respostas_rapidas.excluir",
  RESPOSTAS_ENCERRAMENTO_VISUALIZAR: "respostas_encerramento.visualizar",
  RESPOSTAS_ENCERRAMENTO_ADICIONAR: "respostas_encerramento.adicionar",
  RESPOSTAS_ENCERRAMENTO_EDITAR: "respostas_encerramento.editar",
  RESPOSTAS_ENCERRAMENTO_EXCLUIR: "respostas_encerramento.excluir",
  // The image, video or PDF of a quick reply or closing message — Gestor and Administrador only (never offered to Atendente).
  RESPOSTAS_MIDIA_GERENCIAR: "respostas.midia",
  RESPOSTAS_TRANSFERENCIA_VISUALIZAR: "respostas_transferencia.visualizar",
  RESPOSTAS_TRANSFERENCIA_ADICIONAR: "respostas_transferencia.adicionar",
  RESPOSTAS_TRANSFERENCIA_EDITAR: "respostas_transferencia.editar",
  RESPOSTAS_TRANSFERENCIA_EXCLUIR: "respostas_transferencia.excluir",
  RESPOSTAS_ACEITE_VISUALIZAR: "respostas_aceite.visualizar",
  RESPOSTAS_ACEITE_ADICIONAR: "respostas_aceite.adicionar",
  RESPOSTAS_ACEITE_EDITAR: "respostas_aceite.editar",
  RESPOSTAS_ACEITE_EXCLUIR: "respostas_aceite.excluir",
  // Motivo de Pausa — unlike the other Respostas tabs above (one combined
  // "gerenciar" permission each, before this round of granularization), this
  // one shipped with visualizar/adicionar/editar/excluir broken out from the
  // start (Etapa 5). See PROMPT: "nas permissões precisa estar discriminado
  // sobre poder editar, excluir, visualizar e adicionar". VISUALIZAR is this
  // tab's own umbrella (same role RESPOSTAS_RAPIDAS_GERENCIAR plays for the
  // whole menu) — still layered on top of RESPOSTAS_RAPIDAS_GERENCIAR.
  RESPOSTAS_MOTIVO_PAUSA_VISUALIZAR: "respostas_motivo_pausa.visualizar",
  RESPOSTAS_MOTIVO_PAUSA_ADICIONAR: "respostas_motivo_pausa.adicionar",
  RESPOSTAS_MOTIVO_PAUSA_EDITAR: "respostas_motivo_pausa.editar",
  RESPOSTAS_MOTIVO_PAUSA_EXCLUIR: "respostas_motivo_pausa.excluir",
  // Templates — mensagens pré-aprovadas pela Meta (Marketing/Utilidade/
  // Autenticação). See PROMPT: "nova aba chamada Templates".
  RESPOSTAS_TEMPLATES_VISUALIZAR: "respostas_templates.visualizar",
  RESPOSTAS_TEMPLATES_ADICIONAR: "respostas_templates.adicionar",
  RESPOSTAS_TEMPLATES_EDITAR: "respostas_templates.editar",
  RESPOSTAS_TEMPLATES_EXCLUIR: "respostas_templates.excluir",
  RESPOSTAS_PESQUISA_VISUALIZAR: "respostas_pesquisa.visualizar",
  RESPOSTAS_PESQUISA_EDITAR: "respostas_pesquisa.editar",
  RESPOSTAS_PESQUISA_ADICIONAR: "respostas_pesquisa.adicionar",
  RESPOSTAS_PESQUISA_EXCLUIR: "respostas_pesquisa.excluir",
  RESPOSTAS_EXPEDIENTE_VISUALIZAR: "respostas_expediente.visualizar",
  RESPOSTAS_EXPEDIENTE_ADICIONAR: "respostas_expediente.adicionar",
  RESPOSTAS_EXPEDIENTE_EDITAR: "respostas_expediente.editar",
  RESPOSTAS_EXPEDIENTE_EXCLUIR: "respostas_expediente.excluir",
  RESPOSTAS_ESPERA_VISUALIZAR: "respostas_espera.visualizar",
  RESPOSTAS_ESPERA_ADICIONAR: "respostas_espera.adicionar",
  RESPOSTAS_ESPERA_EDITAR: "respostas_espera.editar",
  RESPOSTAS_ESPERA_EXCLUIR: "respostas_espera.excluir",
  // Kept under their original keys (saved permissions carry over) — the tab now lives in Pop Up › Aniversários.
  RESPOSTAS_ANIVERSARIO_VISUALIZAR: "respostas_aniversario.visualizar",
  RESPOSTAS_ANIVERSARIO_EDITAR: "respostas_aniversario.editar",
  // Pop Up (Automação): the menu itself, Avisos (notices after login) and the Lixeira of deleted notices.
  POPUP_ACESSAR: "popup.acessar",
  POPUP_AVISOS_VISUALIZAR: "popup_avisos.visualizar",
  POPUP_AVISOS_ADICIONAR: "popup_avisos.adicionar",
  POPUP_AVISOS_EDITAR: "popup_avisos.editar",
  POPUP_AVISOS_EXCLUIR: "popup_avisos.excluir",
  POPUP_LIXEIRA_GERENCIAR: "popup_lixeira.gerenciar",
  // The Comunicados board (the newspaper icon in the top bar) — every notice meant for the person.
  COMUNICADOS_VER: "comunicados.ver",
  // Configurações › Modelos de e-mail › Agendamento da apresentação, and Configurações › SMS.
  CONFIGURACOES_AGENDAMENTO_VISUALIZAR: "configuracoes.agendamento.visualizar",
  CONFIGURACOES_AGENDAMENTO_EDITAR: "configuracoes.agendamento.editar",
  CONFIGURACOES_SMS_VISUALIZAR: "configuracoes.sms.visualizar",
  CONFIGURACOES_SMS_EDITAR: "configuracoes.sms.editar",
  // Standalone top-level menu (not nested under CONFIGURACOES_GERENCIAR) —
  // see PROMPT: "planeje um novo menu chamado landing page". Single record
  // to edit (no list), so only visualizar/editar.
  LANDING_PAGE_VISUALIZAR: "landing_page.visualizar",
  LANDING_PAGE_EDITAR: "landing_page.editar",
  // Standalone top-level menu (not nested under CONFIGURACOES_GERENCIAR) —
  // one tab per channel. See PROMPT: "crie um novo menu chamado Conexões,
  // onde terá a aba WhatsApp, Instagram, Facebook e Site". WHATSAPP is a
  // real list (create/edit/delete connections), so it gets the full
  // granular set; INSTAGRAM/FACEBOOK/SITE gate tabs that only show a "not
  // connected yet" placeholder until those integrations exist, so they stay
  // a single permission each — nothing to cadastrar there yet.
  CONEXOES_GERENCIAR: "conexoes.gerenciar",
  CONEXOES_WHATSAPP_VISUALIZAR: "conexoes.whatsapp.visualizar",
  CONEXOES_WHATSAPP_ADICIONAR: "conexoes.whatsapp.adicionar",
  CONEXOES_WHATSAPP_EDITAR: "conexoes.whatsapp.editar",
  CONEXOES_WHATSAPP_EXCLUIR: "conexoes.whatsapp.excluir",
  CONEXOES_INSTAGRAM_GERENCIAR: "conexoes.instagram.gerenciar",
  CONEXOES_FACEBOOK_GERENCIAR: "conexoes.facebook.gerenciar",
  CONEXOES_SITE_GERENCIAR: "conexoes.site.gerenciar",
  // Standalone top-level menu — construtor visual de fluxos de atendimento
  // automático. See PROMPT: "um novo menu chamado Fluxo".
  FLUXO_VISUALIZAR: "fluxo.visualizar",
  FLUXO_ADICIONAR: "fluxo.adicionar",
  FLUXO_EDITAR: "fluxo.editar",
  FLUXO_EXCLUIR: "fluxo.excluir",
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
    key: PERMISSION.ATENDIMENTO_GRUPOS_VISUALIZAR,
    group: "Atendimento",
    label: "Ver grupos",
    description: "Ver a aba Grupos e receber os avisos de mensagens novas nos grupos do WhatsApp das conexões que atende.",
    editableRoles: ["AGENT", "MANAGER"],
    defaultAllowed: { AGENT: true, MANAGER: true },
  },
  {
    key: PERMISSION.ATENDIMENTO_GRUPOS_RESPONDER,
    group: "Atendimento",
    label: "Responder em grupos",
    description: "Enviar mensagens nos grupos do WhatsApp, com o nome de exibição no início, como nas conversas.",
    editableRoles: ["AGENT", "MANAGER"],
    defaultAllowed: { AGENT: true, MANAGER: true },
  },
  {
    key: PERMISSION.GESTAO_ACESSAR,
    group: "Gestão",
    label: "Acessar Gestão",
    description: "Visualizar, em modo leitura, as conversas de todos os atendentes. Necessária para qualquer outra permissão de Gestão.",
    editableRoles: ["AGENT", "MANAGER"],
    defaultAllowed: { AGENT: false, MANAGER: true },
  },
  {
    key: PERMISSION.GESTAO_GERENCIAR,
    group: "Gestão",
    label: "Transferir e enviar para a fila pela Gestão",
    description: "Além de visualizar, poder transferir uma conversa para outro atendente ou devolvê-la para a fila diretamente pela Gestão.",
    editableRoles: ["AGENT", "MANAGER"],
    defaultAllowed: { AGENT: true, MANAGER: true },
  },
  {
    key: PERMISSION.GESTAO_INTERVIR,
    group: "Gestão",
    label: "Intervir na conversa pela Gestão",
    description: "Assumir as respostas de uma conversa em atendimento: o atendente passa a só acompanhar e deixar notas até a conversa ser devolvida, transferida ou encerrada.",
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
    key: PERMISSION.RELATORIOS_PESQUISA_CORRIGIR,
    group: "Relatórios",
    label: "Pesquisa de satisfação — corrigir nota",
    description: "Corrigir a nota que o sistema leu da resposta do cliente. Fica registrado na Auditoria.",
    editableRoles: ["MANAGER"],
    defaultAllowed: { MANAGER: false },
  },
  {
    key: PERMISSION.USUARIOS_VISUALIZAR,
    group: "Usuários",
    label: "Usuários — visualizar",
    description: "Ver a lista de usuários cadastrados.",
    editableRoles: ["AGENT", "MANAGER"],
    defaultAllowed: { AGENT: false, MANAGER: true },
  },
  {
    key: PERMISSION.USUARIOS_ADICIONAR,
    group: "Usuários",
    label: "Usuários — adicionar",
    description: "Cadastrar novos usuários.",
    editableRoles: ["AGENT", "MANAGER"],
    defaultAllowed: { AGENT: false, MANAGER: true },
  },
  {
    key: PERMISSION.USUARIOS_EDITAR,
    group: "Usuários",
    label: "Usuários — editar",
    description: "Editar dados de um usuário existente, redefinir senha e desconectar sessão ativa.",
    editableRoles: ["AGENT", "MANAGER"],
    defaultAllowed: { AGENT: false, MANAGER: true },
  },
  {
    key: PERMISSION.USUARIOS_INATIVAR,
    group: "Usuários",
    label: "Usuários — inativar",
    description: "Ativar ou inativar um usuário. Excluir de forma definitiva continua restrito ao Administrador.",
    editableRoles: ["AGENT", "MANAGER"],
    defaultAllowed: { AGENT: false, MANAGER: true },
  },
  {
    key: PERMISSION.CONFIGURACOES_GERENCIAR,
    group: "Configurações",
    label: "Acessar Configurações",
    description:
      "Acesso geral à tela de Configurações. Necessária para qualquer uma das áreas abaixo — por padrão libera todas; restrinja áreas específicas desmarcando-as individualmente.",
    editableRoles: ["AGENT", "MANAGER"],
    defaultAllowed: { AGENT: false, MANAGER: false },
  },
  {
    key: PERMISSION.CONFIGURACOES_IDENTIDADE_VISUALIZAR,
    group: "Configurações",
    label: "Configurações — Identidade visual (visualizar)",
    description: "Ver nome da empresa, cores, logo, ícone do app e favicon configurados.",
    editableRoles: ["AGENT", "MANAGER"],
    defaultAllowed: { AGENT: false, MANAGER: true },
  },
  {
    key: PERMISSION.CONFIGURACOES_IDENTIDADE_EDITAR,
    group: "Configurações",
    label: "Configurações — Identidade visual (editar)",
    description: "Alterar nome da empresa, cores, logo, ícone do app e favicon.",
    editableRoles: ["AGENT", "MANAGER"],
    defaultAllowed: { AGENT: false, MANAGER: true },
  },
  {
    key: PERMISSION.CONFIGURACOES_EMAIL_VISUALIZAR,
    group: "Configurações",
    label: "Configurações — E-mail, SMTP (visualizar)",
    description: "Ver as credenciais de SMTP configuradas (sem a senha).",
    editableRoles: ["AGENT", "MANAGER"],
    defaultAllowed: { AGENT: false, MANAGER: true },
  },
  {
    key: PERMISSION.CONFIGURACOES_EMAIL_EDITAR,
    group: "Configurações",
    label: "Configurações — E-mail, SMTP (editar)",
    description: "Alterar as credenciais de SMTP e enviar e-mail de teste.",
    editableRoles: ["AGENT", "MANAGER"],
    defaultAllowed: { AGENT: false, MANAGER: true },
  },
  {
    key: PERMISSION.CONFIGURACOES_EMAIL_MODELOS_VISUALIZAR,
    group: "Configurações",
    label: "Configurações — Modelos de e-mail (visualizar)",
    description: "Ver os modelos dos e-mails automáticos do sistema.",
    editableRoles: ["AGENT", "MANAGER"],
    defaultAllowed: { AGENT: false, MANAGER: true },
  },
  {
    key: PERMISSION.CONFIGURACOES_EMAIL_MODELOS_EDITAR,
    group: "Configurações",
    label: "Configurações — Modelos de e-mail (editar)",
    description: "Editar os modelos dos e-mails automáticos do sistema (redefinição de senha, boas-vindas, etc).",
    editableRoles: ["AGENT", "MANAGER"],
    defaultAllowed: { AGENT: false, MANAGER: true },
  },
  {
    key: PERMISSION.CONFIGURACOES_AGENDAMENTO_VISUALIZAR,
    group: "Configurações",
    label: "Configurações — Agendamento da apresentação (visualizar)",
    description: "Ver os envios agendados da apresentação do Dashboard (Modelos de e-mail) e o histórico de cada um.",
    editableRoles: ["MANAGER"],
    defaultAllowed: { MANAGER: true },
  },
  {
    key: PERMISSION.CONFIGURACOES_AGENDAMENTO_EDITAR,
    group: "Configurações",
    label: "Configurações — Agendamento da apresentação (editar)",
    description: "Criar, mudar, duplicar e excluir os envios agendados, enviar agora e baixar a prévia da apresentação.",
    editableRoles: ["MANAGER"],
    defaultAllowed: { MANAGER: true },
  },
  {
    key: PERMISSION.CONFIGURACOES_SMS_VISUALIZAR,
    group: "Configurações",
    label: "Configurações — SMS (visualizar)",
    description: "Ver o provedor de SMS configurado (sem as senhas e chaves).",
    editableRoles: ["MANAGER"],
    defaultAllowed: { MANAGER: false },
  },
  {
    key: PERMISSION.CONFIGURACOES_SMS_EDITAR,
    group: "Configurações",
    label: "Configurações — SMS (editar)",
    description: "Escolher o provedor de SMS, as credenciais e enviar o SMS de teste.",
    editableRoles: ["MANAGER"],
    defaultAllowed: { MANAGER: false },
  },
  {
    key: PERMISSION.CONFIGURACOES_FERIADOS_VISUALIZAR,
    group: "Configurações",
    label: "Configurações — Feriados (visualizar)",
    description: "Ver a lista de feriados cadastrados.",
    editableRoles: ["AGENT", "MANAGER"],
    defaultAllowed: { AGENT: false, MANAGER: true },
  },
  {
    key: PERMISSION.CONFIGURACOES_FERIADOS_ADICIONAR,
    group: "Configurações",
    label: "Configurações — Feriados (adicionar)",
    description: "Cadastrar feriados manualmente ou sincronizar os feriados nacionais do ano.",
    editableRoles: ["AGENT", "MANAGER"],
    defaultAllowed: { AGENT: false, MANAGER: true },
  },
  {
    key: PERMISSION.CONFIGURACOES_FERIADOS_EDITAR,
    group: "Configurações",
    label: "Configurações — Feriados (editar)",
    description: "Editar um feriado cadastrado manualmente.",
    editableRoles: ["AGENT", "MANAGER"],
    defaultAllowed: { AGENT: false, MANAGER: true },
  },
  {
    key: PERMISSION.CONFIGURACOES_FERIADOS_EXCLUIR,
    group: "Configurações",
    label: "Configurações — Feriados (excluir)",
    description: "Excluir um feriado cadastrado.",
    editableRoles: ["AGENT", "MANAGER"],
    defaultAllowed: { AGENT: false, MANAGER: true },
  },
  {
    key: PERMISSION.CONFIGURACOES_FILA_VISUALIZAR,
    group: "Configurações",
    label: "Configurações — Fila (visualizar)",
    description: "Ver o intervalo configurado do lembrete de conversas aguardando na fila.",
    editableRoles: ["AGENT", "MANAGER"],
    defaultAllowed: { AGENT: false, MANAGER: true },
  },
  {
    key: PERMISSION.CONFIGURACOES_FILA_EDITAR,
    group: "Configurações",
    label: "Configurações — Fila (editar)",
    description: "Alterar o intervalo do lembrete de conversas aguardando na fila.",
    editableRoles: ["AGENT", "MANAGER"],
    defaultAllowed: { AGENT: false, MANAGER: true },
  },
  {
    key: PERMISSION.CONFIGURACOES_VISOES_VISUALIZAR,
    group: "Configurações",
    label: "Configurações — Visões de colunas (visualizar)",
    description: "Ver as visões de colunas salvas pelos usuários: tela, colunas, quem salvou e quem pode usar.",
    editableRoles: ["MANAGER"],
    defaultAllowed: { MANAGER: false },
  },
  {
    key: PERMISSION.CONFIGURACOES_VISOES_EDITAR,
    group: "Configurações",
    label: "Configurações — Visões de colunas (editar)",
    description: "Alterar colunas, ordem e quem pode usar uma visão salva, ou excluí-la.",
    editableRoles: ["MANAGER"],
    defaultAllowed: { MANAGER: false },
  },
  {
    key: PERMISSION.CONFIGURACOES_TELEFONE_VISUALIZAR,
    group: "Configurações",
    label: "Configurações — Números de telefone (visualizar)",
    description: "Ver como um número digitado à mão é completado: DDI padrão e correção do 9 a mais.",
    editableRoles: ["AGENT", "MANAGER"],
    defaultAllowed: { AGENT: false, MANAGER: true },
  },
  {
    key: PERMISSION.CONFIGURACOES_TELEFONE_EDITAR,
    group: "Configurações",
    label: "Configurações — Números de telefone (editar)",
    description: "Ligar ou desligar o DDI padrão e a correção do 9 a mais, e trocar o DDI padrão.",
    editableRoles: ["AGENT", "MANAGER"],
    defaultAllowed: { AGENT: false, MANAGER: true },
  },
  {
    key: PERMISSION.CONTATOS_ACESSAR,
    group: "Contatos",
    label: "Contatos — acessar",
    description: "Abrir a tela de Contatos, buscar clientes, ver o histórico de conversas de cada um e iniciar uma conversa. O atendente vê só os contatos da própria conexão.",
    editableRoles: ["AGENT", "MANAGER"],
    defaultAllowed: { AGENT: true, MANAGER: true },
  },
  {
    key: PERMISSION.CONTATOS_EDITAR,
    group: "Contatos",
    label: "Contatos — editar",
    description: "Alterar o nome de um contato e as etiquetas dele.",
    editableRoles: ["AGENT", "MANAGER"],
    defaultAllowed: { AGENT: false, MANAGER: true },
  },
  {
    key: PERMISSION.CONTATOS_IMPORTAR_EXPORTAR,
    group: "Contatos",
    label: "Contatos — importar e exportar",
    description: "Importar contatos de uma planilha CSV e exportar a lista filtrada em CSV.",
    editableRoles: ["AGENT", "MANAGER"],
    defaultAllowed: { AGENT: false, MANAGER: true },
  },
  {
    key: PERMISSION.ETIQUETAS_VISUALIZAR,
    group: "Etiquetas",
    label: "Etiquetas — ver",
    description: "Abrir Automação › Etiquetas. No atendimento, todos só escolhem etiquetas desta lista.",
    editableRoles: ["AGENT", "MANAGER"],
    defaultAllowed: { AGENT: false, MANAGER: true },
  },
  {
    key: PERMISSION.ETIQUETAS_ADICIONAR,
    group: "Etiquetas",
    label: "Etiquetas — adicionar",
    description: "Cadastrar etiquetas novas (o único lugar onde se cria etiqueta).",
    editableRoles: ["AGENT", "MANAGER"],
    defaultAllowed: { AGENT: false, MANAGER: true },
  },
  {
    key: PERMISSION.ETIQUETAS_EDITAR,
    group: "Etiquetas",
    label: "Etiquetas — editar",
    description: "Renomear e mudar a cor das etiquetas.",
    editableRoles: ["AGENT", "MANAGER"],
    defaultAllowed: { AGENT: false, MANAGER: true },
  },
  {
    key: PERMISSION.ETIQUETAS_EXCLUIR,
    group: "Etiquetas",
    label: "Etiquetas — excluir",
    description: "Excluir etiquetas (a exclusão tira a etiqueta de todos os contatos).",
    editableRoles: ["AGENT", "MANAGER"],
    defaultAllowed: { AGENT: false, MANAGER: true },
  },
  {
    key: PERMISSION.ETIQUETAS_BLOQUEIOS,
    group: "Etiquetas",
    label: "Etiquetas — mensagens automáticas bloqueadas",
    description: "Marcar na etiqueta quais mensagens automáticas os clientes com ela não recebem (espera na fila, pesquisa, falta de retorno...).",
    editableRoles: ["MANAGER"],
    defaultAllowed: { AGENT: false, MANAGER: true },
  },
  {
    key: PERMISSION.CONTATOS_OBSERVACAO_EDITAR,
    group: "Contatos",
    label: "Contatos — editar observação fixa",
    description: "Escrever ou apagar a observação fixa do contato, que aparece no topo de todas as conversas dele.",
    editableRoles: ["AGENT", "MANAGER"],
    defaultAllowed: { AGENT: false, MANAGER: true },
  },
  {
    key: PERMISSION.FONTES_DADOS_VER,
    group: "Fontes de dados",
    label: "Fontes de dados — ver",
    description: "Abrir Configurações › Fontes de dados e ver as planilhas, links e bancos ligados, quando atualizaram e se deram erro.",
    editableRoles: ["AGENT", "MANAGER"],
    defaultAllowed: { AGENT: false, MANAGER: true },
  },
  {
    key: PERMISSION.FONTES_DADOS_ADICIONAR,
    group: "Fontes de dados",
    label: "Fontes de dados — adicionar",
    description: "Ligar uma nova planilha (link do OneDrive ou Google, conta Microsoft, arquivo enviado) ou um banco de dados.",
    editableRoles: ["AGENT", "MANAGER"],
    defaultAllowed: { AGENT: false, MANAGER: false },
  },
  {
    key: PERMISSION.FONTES_DADOS_EDITAR,
    group: "Fontes de dados",
    label: "Fontes de dados — editar",
    description: "Alterar, ativar, desativar e atualizar agora uma fonte de dados, e escolher as colunas sensíveis.",
    editableRoles: ["AGENT", "MANAGER"],
    defaultAllowed: { AGENT: false, MANAGER: false },
  },
  {
    key: PERMISSION.FONTES_DADOS_EXCLUIR,
    group: "Fontes de dados",
    label: "Fontes de dados — excluir",
    description: "Excluir uma fonte de dados e os dados que ela trouxe.",
    editableRoles: ["AGENT", "MANAGER"],
    defaultAllowed: { AGENT: false, MANAGER: false },
  },
  {
    key: PERMISSION.CLIENTE_DADOS_SENSIVEIS_VER,
    group: "Fontes de dados",
    label: "Ver dados sensíveis do cliente",
    description: "Revelar as colunas marcadas como sensíveis (ex.: CPF) em Dados do cliente e enviá-las por tag. Cada revelação fica registrada na auditoria.",
    editableRoles: ["AGENT", "MANAGER"],
    defaultAllowed: { AGENT: false, MANAGER: true },
  },
  {
    key: PERMISSION.CHAT_INTERNO_USAR,
    group: "Chat interno",
    label: "Chat interno — usar",
    description: "Conversar com a equipe pelo balão ao lado do sino: #Geral, conversas diretas e grupos.",
    editableRoles: ["AGENT", "MANAGER"],
    defaultAllowed: { AGENT: true, MANAGER: true },
  },
  {
    key: PERMISSION.CHAT_INTERNO_ACOMPANHAR,
    group: "Chat interno",
    label: "Chat interno — acompanhar conversas da equipe",
    description:
      "Só o administrador: ler todas as conversas do chat interno em Gestão › Chat interno — inclusive grupos finalizados, mensagens temporárias, apagadas e editadas — sem aviso para quem conversa. Cada leitura fica registrada na auditoria. Use conforme a política interna e a LGPD.",
    // Administrador only — never offered to Gestor or Atendente.
    editableRoles: [],
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
    // Key left unchanged (still "respostas_rapidas.gerenciar") even though
    // it now also gates Encerramento — renaming it would orphan any
    // per-manager override already stored under the old string. See
    // PROMPT: "O menu de Respostas, deverá estar habilitado nas
    // permissões para o administrador e gestor."
    key: PERMISSION.RESPOSTAS_RAPIDAS_GERENCIAR,
    group: "Respostas",
    label: "Acessar Respostas",
    description:
      "Acesso geral ao menu Respostas. Necessária para qualquer uma das abas abaixo — por padrão libera todas; restrinja abas específicas desmarcando-as individualmente.",
    editableRoles: ["AGENT", "MANAGER"],
    defaultAllowed: { AGENT: false, MANAGER: true },
  },
  {
    key: PERMISSION.RESPOSTAS_RAPIDAS_VISUALIZAR,
    group: "Respostas",
    label: "Respostas — Respostas rápidas (visualizar)",
    description: "Ver a lista de respostas rápidas acionadas no atendimento digitando \"/\".",
    editableRoles: ["AGENT", "MANAGER"],
    defaultAllowed: { AGENT: false, MANAGER: true },
  },
  {
    key: PERMISSION.RESPOSTAS_RAPIDAS_ADICIONAR,
    group: "Respostas",
    label: "Respostas — Respostas rápidas (adicionar)",
    description: "Cadastrar novas respostas rápidas.",
    editableRoles: ["AGENT", "MANAGER"],
    defaultAllowed: { AGENT: false, MANAGER: true },
  },
  {
    key: PERMISSION.RESPOSTAS_RAPIDAS_EDITAR,
    group: "Respostas",
    label: "Respostas — Respostas rápidas (editar)",
    description: "Editar uma resposta rápida existente.",
    editableRoles: ["AGENT", "MANAGER"],
    defaultAllowed: { AGENT: false, MANAGER: true },
  },
  {
    key: PERMISSION.RESPOSTAS_RAPIDAS_EXCLUIR,
    group: "Respostas",
    label: "Respostas — Respostas rápidas (excluir)",
    description: "Excluir uma resposta rápida.",
    editableRoles: ["AGENT", "MANAGER"],
    defaultAllowed: { AGENT: false, MANAGER: true },
  },
  {
    key: PERMISSION.RESPOSTAS_ENCERRAMENTO_VISUALIZAR,
    group: "Respostas",
    label: "Respostas — Encerramento (visualizar)",
    description: "Ver as mensagens de encerramento automático cadastradas (aba Encerramento).",
    editableRoles: ["AGENT", "MANAGER"],
    defaultAllowed: { AGENT: false, MANAGER: true },
  },
  {
    key: PERMISSION.RESPOSTAS_ENCERRAMENTO_ADICIONAR,
    group: "Respostas",
    label: "Respostas — Encerramento (adicionar)",
    description: "Cadastrar novas mensagens de encerramento automático.",
    editableRoles: ["AGENT", "MANAGER"],
    defaultAllowed: { AGENT: false, MANAGER: true },
  },
  {
    key: PERMISSION.RESPOSTAS_ENCERRAMENTO_EDITAR,
    group: "Respostas",
    label: "Respostas — Encerramento (editar)",
    description: "Editar uma mensagem de encerramento automático existente.",
    editableRoles: ["AGENT", "MANAGER"],
    defaultAllowed: { AGENT: false, MANAGER: true },
  },
  {
    key: PERMISSION.RESPOSTAS_ENCERRAMENTO_EXCLUIR,
    group: "Respostas",
    label: "Respostas — Encerramento (excluir)",
    description: "Excluir uma mensagem de encerramento automático.",
    editableRoles: ["AGENT", "MANAGER"],
    defaultAllowed: { AGENT: false, MANAGER: true },
  },
  {
    key: PERMISSION.RESPOSTAS_MIDIA_GERENCIAR,
    group: "Respostas",
    label: "Respostas — Incluir imagem, vídeo ou PDF",
    description: "Incluir, trocar ou remover o anexo (imagem, vídeo ou PDF) das respostas rápidas e das mensagens de encerramento. Só para Gestor e Administrador.",
    editableRoles: ["MANAGER"],
    defaultAllowed: { AGENT: false, MANAGER: true },
  },
  {
    key: PERMISSION.RESPOSTAS_TRANSFERENCIA_VISUALIZAR,
    group: "Respostas",
    label: "Respostas — Transferência (visualizar)",
    description: "Ver a mensagem automática enviada ao cliente quando a conversa é transferida (aba Transferência).",
    editableRoles: ["AGENT", "MANAGER"],
    defaultAllowed: { AGENT: false, MANAGER: true },
  },
  {
    key: PERMISSION.RESPOSTAS_TRANSFERENCIA_ADICIONAR,
    group: "Respostas",
    label: "Respostas — Transferência (adicionar)",
    description: "Cadastrar novas mensagens automáticas de transferência.",
    editableRoles: ["AGENT", "MANAGER"],
    defaultAllowed: { AGENT: false, MANAGER: true },
  },
  {
    key: PERMISSION.RESPOSTAS_TRANSFERENCIA_EDITAR,
    group: "Respostas",
    label: "Respostas — Transferência (editar)",
    description: "Editar uma mensagem automática de transferência existente.",
    editableRoles: ["AGENT", "MANAGER"],
    defaultAllowed: { AGENT: false, MANAGER: true },
  },
  {
    key: PERMISSION.RESPOSTAS_TRANSFERENCIA_EXCLUIR,
    group: "Respostas",
    label: "Respostas — Transferência (excluir)",
    description: "Excluir uma mensagem automática de transferência.",
    editableRoles: ["AGENT", "MANAGER"],
    defaultAllowed: { AGENT: false, MANAGER: true },
  },
  {
    key: PERMISSION.RESPOSTAS_ACEITE_VISUALIZAR,
    group: "Respostas",
    label: "Respostas — Aceite (visualizar)",
    description: "Ver a mensagem automática enviada ao cliente quando o atendente aceita a conversa (aba Aceite).",
    editableRoles: ["AGENT", "MANAGER"],
    defaultAllowed: { AGENT: false, MANAGER: true },
  },
  {
    key: PERMISSION.RESPOSTAS_ACEITE_ADICIONAR,
    group: "Respostas",
    label: "Respostas — Aceite (adicionar)",
    description: "Cadastrar novas mensagens automáticas de aceite.",
    editableRoles: ["AGENT", "MANAGER"],
    defaultAllowed: { AGENT: false, MANAGER: true },
  },
  {
    key: PERMISSION.RESPOSTAS_ACEITE_EDITAR,
    group: "Respostas",
    label: "Respostas — Aceite (editar)",
    description: "Editar uma mensagem automática de aceite existente.",
    editableRoles: ["AGENT", "MANAGER"],
    defaultAllowed: { AGENT: false, MANAGER: true },
  },
  {
    key: PERMISSION.RESPOSTAS_ACEITE_EXCLUIR,
    group: "Respostas",
    label: "Respostas — Aceite (excluir)",
    description: "Excluir uma mensagem automática de aceite.",
    editableRoles: ["AGENT", "MANAGER"],
    defaultAllowed: { AGENT: false, MANAGER: true },
  },
  // Motivo de Pausa — granular from the start (not a single "gerenciar"),
  // and restricted to ADMIN+MANAGER by default, unlike its Respostas
  // siblings above which default-allow AGENT too. See PROMPT: "as
  // permissões novas, devem estar habilitadas apenas para o administrador
  // e gestor".
  {
    key: PERMISSION.RESPOSTAS_MOTIVO_PAUSA_VISUALIZAR,
    group: "Respostas",
    label: "Respostas — Motivo de Pausa (visualizar)",
    description: "Ver a lista de motivos de pausa cadastrados (aba Motivo de Pausa).",
    editableRoles: ["AGENT", "MANAGER"],
    defaultAllowed: { AGENT: false, MANAGER: true },
  },
  {
    key: PERMISSION.RESPOSTAS_MOTIVO_PAUSA_ADICIONAR,
    group: "Respostas",
    label: "Respostas — Motivo de Pausa (adicionar)",
    description: "Cadastrar novos motivos de pausa.",
    editableRoles: ["AGENT", "MANAGER"],
    defaultAllowed: { AGENT: false, MANAGER: true },
  },
  {
    key: PERMISSION.RESPOSTAS_MOTIVO_PAUSA_EDITAR,
    group: "Respostas",
    label: "Respostas — Motivo de Pausa (editar)",
    description: "Editar o nome de um motivo de pausa existente.",
    editableRoles: ["AGENT", "MANAGER"],
    defaultAllowed: { AGENT: false, MANAGER: true },
  },
  {
    key: PERMISSION.RESPOSTAS_MOTIVO_PAUSA_EXCLUIR,
    group: "Respostas",
    label: "Respostas — Motivo de Pausa (excluir)",
    description: "Excluir (desativar) um motivo de pausa.",
    editableRoles: ["AGENT", "MANAGER"],
    defaultAllowed: { AGENT: false, MANAGER: true },
  },
  {
    key: PERMISSION.RESPOSTAS_TEMPLATES_VISUALIZAR,
    group: "Respostas",
    label: "Respostas — Templates (visualizar)",
    description: "Ver os templates de mensagem cadastrados e seu status de aprovação na Meta (aba Templates).",
    editableRoles: ["AGENT", "MANAGER"],
    defaultAllowed: { AGENT: false, MANAGER: true },
  },
  {
    key: PERMISSION.RESPOSTAS_TEMPLATES_ADICIONAR,
    group: "Respostas",
    label: "Respostas — Templates (adicionar)",
    description: "Cadastrar um novo template de mensagem e submetê-lo para aprovação da Meta.",
    editableRoles: ["AGENT", "MANAGER"],
    defaultAllowed: { AGENT: false, MANAGER: true },
  },
  {
    key: PERMISSION.RESPOSTAS_TEMPLATES_EDITAR,
    group: "Respostas",
    label: "Respostas — Templates (editar)",
    description: "Editar um template de mensagem existente.",
    editableRoles: ["AGENT", "MANAGER"],
    defaultAllowed: { AGENT: false, MANAGER: true },
  },
  {
    key: PERMISSION.RESPOSTAS_TEMPLATES_EXCLUIR,
    group: "Respostas",
    label: "Respostas — Templates (excluir)",
    description: "Excluir um template de mensagem.",
    editableRoles: ["AGENT", "MANAGER"],
    defaultAllowed: { AGENT: false, MANAGER: true },
  },
  {
    key: PERMISSION.RESPOSTAS_PESQUISA_VISUALIZAR,
    group: "Respostas",
    label: "Respostas — Pesquisa de satisfação (visualizar)",
    description: "Ver as pesquisas de satisfação enviadas ao encerrar (aba Pesquisa).",
    editableRoles: ["AGENT", "MANAGER"],
    defaultAllowed: { AGENT: false, MANAGER: true },
  },
  {
    key: PERMISSION.RESPOSTAS_PESQUISA_EDITAR,
    group: "Respostas",
    label: "Respostas — Pesquisa de satisfação (editar)",
    description: "Ligar/desligar uma pesquisa de satisfação, escolher as conexões e editar os textos.",
    editableRoles: ["AGENT", "MANAGER"],
    defaultAllowed: { AGENT: false, MANAGER: true },
  },
  {
    key: PERMISSION.RESPOSTAS_PESQUISA_ADICIONAR,
    group: "Respostas",
    label: "Respostas — Pesquisa de satisfação (adicionar)",
    description: "Criar uma pesquisa de satisfação, do zero ou a partir de outra (Duplicar).",
    editableRoles: ["AGENT", "MANAGER"],
    defaultAllowed: { AGENT: false, MANAGER: true },
  },
  {
    key: PERMISSION.RESPOSTAS_PESQUISA_EXCLUIR,
    group: "Respostas",
    label: "Respostas — Pesquisa de satisfação (excluir)",
    description: "Excluir uma pesquisa de satisfação. As notas já recebidas continuam no Dashboard.",
    editableRoles: ["AGENT", "MANAGER"],
    defaultAllowed: { AGENT: false, MANAGER: true },
  },
  {
    key: PERMISSION.RESPOSTAS_EXPEDIENTE_VISUALIZAR,
    group: "Respostas",
    label: "Respostas — Horário de expediente (visualizar)",
    description: "Ver os horários de expediente cadastrados (aba Horário de expediente).",
    editableRoles: ["AGENT", "MANAGER"],
    defaultAllowed: { AGENT: false, MANAGER: true },
  },
  {
    key: PERMISSION.RESPOSTAS_EXPEDIENTE_ADICIONAR,
    group: "Respostas",
    label: "Respostas — Horário de expediente (adicionar)",
    description: "Cadastrar um novo horário de expediente.",
    editableRoles: ["AGENT", "MANAGER"],
    defaultAllowed: { AGENT: false, MANAGER: true },
  },
  {
    key: PERMISSION.RESPOSTAS_EXPEDIENTE_EDITAR,
    group: "Respostas",
    label: "Respostas — Horário de expediente (editar)",
    description: "Editar dias, horários, feriados parciais e a mensagem de fora do expediente.",
    editableRoles: ["AGENT", "MANAGER"],
    defaultAllowed: { AGENT: false, MANAGER: true },
  },
  {
    key: PERMISSION.RESPOSTAS_EXPEDIENTE_EXCLUIR,
    group: "Respostas",
    label: "Respostas — Horário de expediente (excluir)",
    description: "Excluir um horário de expediente que nenhuma conexão esteja usando.",
    editableRoles: ["AGENT", "MANAGER"],
    defaultAllowed: { AGENT: false, MANAGER: true },
  },
  {
    key: PERMISSION.RESPOSTAS_ESPERA_VISUALIZAR,
    group: "Respostas",
    label: "Respostas — Espera na fila (visualizar)",
    description: "Ver as mensagens enviadas ao cliente enquanto ele espera na fila (aba Espera na fila).",
    editableRoles: ["AGENT", "MANAGER"],
    defaultAllowed: { AGENT: false, MANAGER: true },
  },
  {
    key: PERMISSION.RESPOSTAS_ESPERA_ADICIONAR,
    group: "Respostas",
    label: "Respostas — Espera na fila (adicionar)",
    description: "Cadastrar uma nova mensagem de espera.",
    editableRoles: ["AGENT", "MANAGER"],
    defaultAllowed: { AGENT: false, MANAGER: true },
  },
  {
    key: PERMISSION.RESPOSTAS_ESPERA_EDITAR,
    group: "Respostas",
    label: "Respostas — Espera na fila (editar)",
    description: "Editar o texto, o tempo, as conexões e a ordem das mensagens de espera.",
    editableRoles: ["AGENT", "MANAGER"],
    defaultAllowed: { AGENT: false, MANAGER: true },
  },
  {
    key: PERMISSION.RESPOSTAS_ESPERA_EXCLUIR,
    group: "Respostas",
    label: "Respostas — Espera na fila (excluir)",
    description: "Excluir uma mensagem de espera.",
    editableRoles: ["AGENT", "MANAGER"],
    defaultAllowed: { AGENT: false, MANAGER: true },
  },
  {
    key: PERMISSION.RESPOSTAS_ANIVERSARIO_VISUALIZAR,
    group: "Pop Up",
    label: "Pop Up — Aniversários (visualizar)",
    description: "Ver as mensagens de aniversário do cliente e do beneficiário (aba Aniversários).",
    editableRoles: ["AGENT", "MANAGER"],
    defaultAllowed: { AGENT: false, MANAGER: true },
  },
  {
    key: PERMISSION.RESPOSTAS_ANIVERSARIO_EDITAR,
    group: "Pop Up",
    label: "Pop Up — Aniversários (editar)",
    description: "Mudar o texto, a imagem e ligar ou desligar as mensagens de aniversário.",
    editableRoles: ["AGENT", "MANAGER"],
    defaultAllowed: { AGENT: false, MANAGER: true },
  },
  {
    key: PERMISSION.POPUP_ACESSAR,
    group: "Pop Up",
    label: "Pop Up — acessar o menu",
    description: "Ver o menu Pop Up em Automação (Aniversários, Avisos e Lixeira — cada aba tem a sua permissão).",
    editableRoles: ["AGENT", "MANAGER"],
    defaultAllowed: { AGENT: false, MANAGER: true },
  },
  {
    key: PERMISSION.POPUP_AVISOS_VISUALIZAR,
    group: "Pop Up",
    label: "Pop Up — Avisos (visualizar)",
    description: "Ver os avisos cadastrados, o histórico e quem leu e confirmou cada um.",
    editableRoles: ["AGENT", "MANAGER"],
    defaultAllowed: { AGENT: false, MANAGER: true },
  },
  {
    key: PERMISSION.POPUP_AVISOS_ADICIONAR,
    group: "Pop Up",
    label: "Pop Up — Avisos (adicionar)",
    description: "Criar um aviso novo ou duplicar um aviso do histórico.",
    editableRoles: ["AGENT", "MANAGER"],
    defaultAllowed: { AGENT: false, MANAGER: true },
  },
  {
    key: PERMISSION.POPUP_AVISOS_EDITAR,
    group: "Pop Up",
    label: "Pop Up — Avisos (editar)",
    description: "Mudar um aviso, pausar e retomar, lembrar quem ainda não confirmou e o nome da central de Comunicados.",
    editableRoles: ["AGENT", "MANAGER"],
    defaultAllowed: { AGENT: false, MANAGER: true },
  },
  {
    key: PERMISSION.POPUP_AVISOS_EXCLUIR,
    group: "Pop Up",
    label: "Pop Up — Avisos (excluir)",
    description: "Mandar um aviso para a Lixeira.",
    editableRoles: ["AGENT", "MANAGER"],
    defaultAllowed: { AGENT: false, MANAGER: true },
  },
  {
    key: PERMISSION.POPUP_LIXEIRA_GERENCIAR,
    group: "Pop Up",
    label: "Pop Up — Lixeira",
    description: "Restaurar ou excluir de vez os avisos da Lixeira e mudar por quantos dias eles ficam lá.",
    editableRoles: ["AGENT", "MANAGER"],
    defaultAllowed: { AGENT: false, MANAGER: true },
  },
  {
    key: PERMISSION.COMUNICADOS_VER,
    group: "Pop Up",
    label: "Comunicados — receber e ler",
    description: "Receber os avisos depois do login e abrir a central de Comunicados (ícone de jornal na barra superior).",
    editableRoles: ["AGENT", "MANAGER"],
    defaultAllowed: { AGENT: true, MANAGER: true },
  },
  {
    key: PERMISSION.LANDING_PAGE_VISUALIZAR,
    group: "Landing Page",
    label: "Landing Page — visualizar",
    description: "Acessar a tela de Landing Page e ver as configurações atuais.",
    editableRoles: ["AGENT", "MANAGER"],
    defaultAllowed: { AGENT: false, MANAGER: true },
  },
  {
    key: PERMISSION.LANDING_PAGE_EDITAR,
    group: "Landing Page",
    label: "Landing Page — editar",
    description: "Editar a tela de login (logo, alinhamento, subtítulo), reordenar/renomear os itens do menu principal e os títulos das páginas.",
    editableRoles: ["AGENT", "MANAGER"],
    defaultAllowed: { AGENT: false, MANAGER: true },
  },
  {
    key: PERMISSION.CONEXOES_GERENCIAR,
    group: "Conexões",
    label: "Acessar Conexões",
    description:
      "Acesso geral à tela de Conexões. Necessária para qualquer um dos canais abaixo — por padrão libera todos; restrinja canais específicos desmarcando-os individualmente.",
    editableRoles: ["AGENT", "MANAGER"],
    defaultAllowed: { AGENT: false, MANAGER: false },
  },
  {
    key: PERMISSION.CONEXOES_WHATSAPP_VISUALIZAR,
    group: "Conexões",
    label: "Conexões — WhatsApp (visualizar)",
    description: "Ver a lista de conexões de WhatsApp cadastradas.",
    editableRoles: ["AGENT", "MANAGER"],
    defaultAllowed: { AGENT: false, MANAGER: true },
  },
  {
    key: PERMISSION.CONEXOES_WHATSAPP_ADICIONAR,
    group: "Conexões",
    label: "Conexões — WhatsApp (adicionar)",
    description: "Criar novas conexões de WhatsApp.",
    editableRoles: ["AGENT", "MANAGER"],
    defaultAllowed: { AGENT: false, MANAGER: true },
  },
  {
    key: PERMISSION.CONEXOES_WHATSAPP_EDITAR,
    group: "Conexões",
    label: "Conexões — WhatsApp (editar)",
    description: "Editar, conectar e desconectar uma conexão de WhatsApp existente.",
    editableRoles: ["AGENT", "MANAGER"],
    defaultAllowed: { AGENT: false, MANAGER: true },
  },
  {
    key: PERMISSION.CONEXOES_WHATSAPP_EXCLUIR,
    group: "Conexões",
    label: "Conexões — WhatsApp (excluir)",
    description: "Excluir uma conexão de WhatsApp.",
    editableRoles: ["AGENT", "MANAGER"],
    defaultAllowed: { AGENT: false, MANAGER: true },
  },
  {
    key: PERMISSION.CONEXOES_INSTAGRAM_GERENCIAR,
    group: "Conexões",
    label: "Conexões — Instagram",
    description: "Gerenciar a conexão de Instagram (integração ainda não disponível).",
    editableRoles: ["AGENT", "MANAGER"],
    defaultAllowed: { AGENT: true, MANAGER: true },
  },
  {
    key: PERMISSION.CONEXOES_FACEBOOK_GERENCIAR,
    group: "Conexões",
    label: "Conexões — Facebook",
    description: "Gerenciar a conexão de Facebook Messenger (integração ainda não disponível).",
    editableRoles: ["AGENT", "MANAGER"],
    defaultAllowed: { AGENT: true, MANAGER: true },
  },
  {
    key: PERMISSION.CONEXOES_SITE_GERENCIAR,
    group: "Conexões",
    label: "Conexões — Site",
    description: "Gerenciar o widget de chat do site (integração ainda não disponível).",
    editableRoles: ["AGENT", "MANAGER"],
    defaultAllowed: { AGENT: true, MANAGER: true },
  },
  {
    key: PERMISSION.FLUXO_VISUALIZAR,
    group: "Fluxo",
    label: "Fluxo (visualizar)",
    description: "Ver os fluxos de atendimento automático cadastrados, seu status (ativo/inativo) e conexões vinculadas.",
    editableRoles: ["AGENT", "MANAGER"],
    defaultAllowed: { AGENT: false, MANAGER: true },
  },
  {
    key: PERMISSION.FLUXO_ADICIONAR,
    group: "Fluxo",
    label: "Fluxo (adicionar)",
    description: "Criar um novo fluxo de atendimento automático.",
    editableRoles: ["AGENT", "MANAGER"],
    defaultAllowed: { AGENT: false, MANAGER: true },
  },
  {
    key: PERMISSION.FLUXO_EDITAR,
    group: "Fluxo",
    label: "Fluxo (editar)",
    description: "Editar o construtor visual de um fluxo, ativar/desativar, e alterar quais conexões ele atende.",
    editableRoles: ["AGENT", "MANAGER"],
    defaultAllowed: { AGENT: false, MANAGER: true },
  },
  {
    key: PERMISSION.FLUXO_EXCLUIR,
    group: "Fluxo",
    label: "Fluxo (excluir)",
    description: "Excluir um fluxo de atendimento automático.",
    editableRoles: ["AGENT", "MANAGER"],
    defaultAllowed: { AGENT: false, MANAGER: true },
  },
];

export type PermissionMap = Record<Permission, boolean>;

/**
 * The automatic messages a tag can stop (Etiquetas › "Não enviar estas mensagens automáticas"). SURVEY also leaves the
 * contact out of the NPS; NO_RETURN also stops the automatic close; FLOW sends the customer straight to the queue.
 */
export const AUTO_MESSAGE_KINDS = ["QUEUE_WAIT", "ACCEPT", "TRANSFER", "CLOSING", "SURVEY", "NO_RETURN", "OUT_OF_HOURS", "FLOW"] as const;
export type AutoMessageKind = (typeof AUTO_MESSAGE_KINDS)[number];

export const AUTO_MESSAGE_KIND_LABEL: Record<AutoMessageKind, string> = {
  QUEUE_WAIT: "Espera na fila",
  ACCEPT: "Aceite",
  TRANSFER: "Transferência",
  CLOSING: "Encerramento",
  SURVEY: "Pesquisa de satisfação",
  NO_RETURN: "Falta de retorno",
  OUT_OF_HOURS: "Fora do expediente",
  FLOW: "Fluxo",
};

/** What each one means, for the tag form. */
export const AUTO_MESSAGE_KIND_HINT: Record<AutoMessageKind, string> = {
  QUEUE_WAIT: "Mensagens enviadas enquanto o cliente espera na fila.",
  ACCEPT: "Mensagem enviada quando um atendente aceita a conversa.",
  TRANSFER: "Mensagem enviada quando a conversa é transferida.",
  CLOSING: "Mensagem de encerramento do atendente.",
  SURVEY: "Pesquisa de satisfação — o cliente também sai do NPS.",
  NO_RETURN: "Lembrete e encerramento por falta de retorno — a conversa não é encerrada automaticamente.",
  OUT_OF_HOURS: "Aviso de fora do expediente.",
  FLOW: "Robô do Fluxo — o cliente vai direto para a fila.",
};

export interface AutoMessageBlockDTO {
  kind: AutoMessageKind;
  tagName: string;
}

export interface TagDTO {
  id: string;
  name: string;
  color: string;
  /** Automatic messages contacts with this tag never get. */
  blockedAutoMessages: AutoMessageKind[];
  /** "Atendida por": in the queue, only these users see customers with the tag while one of them is online. Empty = everyone. */
  queueUserIds: string[];
}

/** A tag on the attendance card: name and color. */
export interface CardTagDTO {
  id: string;
  name: string;
  color: string;
}

export interface AutoMessageBlocksReportDTO {
  total: number;
  byKind: { kind: AutoMessageKind; count: number }[];
  byTag: { tagName: string; count: number }[];
  items: AutoMessageBlockLogDTO[];
}

/** Relatórios › Mensagens automáticas bloqueadas — one per message a tag stopped. */
export interface AutoMessageBlockLogDTO {
  id: string;
  at: string;
  kind: AutoMessageKind;
  tagName: string;
  conversationId: string;
  contactName: string;
  connectionName: string | null;
  agentName: string | null;
}

/** Card shown under a link in a message — see GET /link-preview. */
export interface LinkPreviewDTO {
  title: string;
  description: string | null;
  url: string;
  /** Data URL of the page's picture, when it has a small enough one. */
  thumbnailUrl: string | null;
}

/** Etiqueta na tela de gestão de etiquetas — com quantos contatos a usam. */
/** Encerramento por falta de retorno (Respostas › Encerramento). Times count only within the connection's work schedule. */
export interface NoReturnSettingsDTO {
  /** The automatic mode; "Encerrar por falta de retorno" in the Encerrar menu works either way. */
  enabled: boolean;
  /** After the agent's last message, how long the customer stays silent before the reminder goes out. */
  reminderMinutes: number;
  /** After the reminder, how long until the conversation is closed. */
  closeMinutes: number;
  reminderText: string;
  closeText: string;
  /** The satisfaction survey follows the no-return close (sent without the agent's name, like every automatic text). */
  sendSurvey: boolean;
}

export interface ManagedTagDTO extends TagDTO {
  contactCount: number;
}

/** A group poll's votes. `readable` false = a poll from before the platform kept its key: no votes can be shown. */
export interface PollResultsDTO {
  readable: boolean;
  /** People with a vote (a vote taken back doesn't count). */
  voters: number;
  options: { option: string; count: number; voters: { name: string; phone: string | null }[] }[];
}

/** A contract of the contact, from the Fonte de dados list (Contatos › Contrato and the client panel). */
export interface ContactContractDTO {
  number: string;
  status: "ACTIVE" | "SUSPENDED" | "CANCELED" | null;
  /** dd/mm/aaaa, as in the list. */
  canceledAt: string | null;
  cancelReason: string | null;
}

/** "Ativo" / "Suspenso" / "Cancelado" (the list's situacao_contrato) → the status; anything else → null. */
export function contractStatusOf(situation: string | null | undefined): ContactContractDTO["status"] {
  const s = (situation ?? "").trim().toLocaleLowerCase("pt-BR");
  if (s.startsWith("ativ")) return "ACTIVE";
  if (s.startsWith("suspens")) return "SUSPENDED";
  if (s.startsWith("cancel")) return "CANCELED";
  return null;
}

/** Contatos › Padronizar nomes: a contact whose name would change. */
export interface NameStandardizationPreviewItemDTO {
  contactId: string;
  phone: string | null;
  current: string;
  proposed: string;
}

export interface NameStandardizationLastBatchDTO {
  batchId: string;
  count: number;
  at: string;
  undone: boolean;
}

export interface ContactListItemDTO {
  id: string;
  name: string | null;
  /** Telefone (WhatsApp) — null para Instagram/Messenger. */
  phone: string | null;
  channel: Channel;
  connectionName: string | null;
  /** WhatsApp connection of the contact — where "Iniciar conversa" starts it. */
  whatsappConnectionId: string | null;
  /** Contract number(s) — filled from the Fonte de dados, editable in the client panel. */
  contractNumber: string | null;
  /** Every contract of this phone in the Fonte de dados (green active, yellow suspended, red canceled). */
  contracts: ContactContractDTO[];
  /** How the customer is called ({{primeiro_nome}}); null = the first word of the name. */
  firstName: string | null;
  tags: TagDTO[];
  conversationCount: number;
  firstConversationAt: string;
  lastInteractionAt: string;
}

/** Columns the Contatos list can be ordered by — text A–Z, numbers and dates in their own order. */
export const CONTACT_SORT_FIELDS = ["name", "phone", "contract", "connection", "tags", "conversations", "firstConversationAt", "lastInteractionAt"] as const;
/** In the Etiquetas column's filter: contacts with no label at all. */
export const CONTACT_NO_TAG = "none";
export type ContactSortField = (typeof CONTACT_SORT_FIELDS)[number];

export interface ContactDetailDTO extends ContactListItemDTO {
  conversations: {
    id: string;
    status: ConversationStatus;
    createdAt: string;
    closedAt: string | null;
    agentName: string | null;
    messageCount: number;
    satisfactionScore: number | null;
    /** Top of the scale the score was given on — 10 (NPS), or 5 for surveys from before it. null without a score. */
    satisfactionScoreMax: 5 | 10 | null;
  }[];
}

export interface ContactImportResultDTO {
  created: number;
  /** Already on the platform (same number, with or without the 9): not duplicated, name kept — only the tags are added. */
  existing: number;
  errors: { line: number; reason: string }[];
}

/** Internal note on a conversation — seen only by the team. */
export interface ConversationNoteDTO {
  id: string;
  conversationId: string;
  /** null = written by the system. */
  authorId: string | null;
  authorName: string;
  body: string;
  createdAt: string;
}

/** Client panel beside the chat: the customer's tags and earlier conversations. */
export interface ContactPanelDTO {
  contactId: string;
  firstConversationAt: string;
  tags: TagDTO[];
  previousConversations: {
    id: string;
    status: ConversationStatus;
    agentName: string | null;
    connectionName: string;
    startedAt: string;
    closedAt: string | null;
    messageCount: number;
  }[];
  previousConversationCount: number;
  /** "Observação fixa" of the contact — shown at the top of every conversation of theirs. */
  pinnedNote: { text: string; updatedAt: string; updatedByName: string | null } | null;
  /** The contact's contract number(s) (Contatos › Contrato), editable by the attendant. */
  contractNumber: string | null;
  /** Every contract of this phone in the Fonte de dados (green active, yellow suspended, red canceled). */
  contracts: ContactContractDTO[];
  /** Contatos › Primeiro nome, editable by the attendant; null = the first word of the name. */
  firstName: string | null;
}

/** A previous conversation opened read-only from the client panel. */
export interface PreviousConversationDetailDTO {
  id: string;
  status: ConversationStatus;
  agentName: string | null;
  startedAt: string;
  closedAt: string | null;
  messages: MessageDTO[];
  notes: ConversationNoteDTO[];
  /** Pesquisa de satisfação answered for it, if any (score 0-10, or 1-5 on old surveys). */
  survey: { score: number | null; answerText: string | null } | null;
}

// ---------------------------------------------------------------------------
// Notas de versão — what changed in each version, written for the people using the system. Kept in the database
// and edited by an administrator in Configurações › Notas de versão. Each note belongs to an area of the app and is
// only shown to users who can open that area (the same permissions that gate the sidebar menu), so nobody reads
// about screens they can't use.
// ---------------------------------------------------------------------------

export type ReleaseNoteType = "novo" | "melhoria" | "correcao";

export type ReleaseNoteArea = "geral" | "atendimento" | "gestao" | "contatos" | "dashboard" | "usuarios" | "respostas" | "popup" | "fluxo" | "dados" | "conexoes" | "configuracoes" | "landingPage" | "administracao";

export interface ReleaseNoteImageDTO {
  /** Address of the screenshot: /notas-de-versao/… (shipped with the system) or /uploads/release-notes/… (sent in Configurações). */
  src: string;
  /** "{1}" renders as the numbered marker drawn on the screenshot. */
  caption: string;
  size?: "small" | "tiny";
}

export interface ReleaseNoteDTO {
  type: ReleaseNoteType;
  area: ReleaseNoteArea;
  title: string;
  text?: string;
  /** Shown together with `after`, as Antes/Agora. */
  before?: string;
  after?: string;
  /** "Como usar" — "{1}" renders as the numbered marker of the screenshot. */
  steps?: string[];
  /** "Onde fica". */
  where?: string;
  images?: ReleaseNoteImageDTO[];
  /** Extra permissions on top of the area's own (e.g. a specific tab). */
  requires?: Permission[];
  /** Only these roles read the note, whatever their permissions. */
  roles?: Role[];
}

/** A version as it is written — what the editor sends. */
export interface ReleaseContent {
  /** "2.2.0" — the newest version (by number) is the current one. */
  version: string;
  /** As shown, e.g. "09 out 2026". */
  date: string;
  name: string;
  summary: string;
  notes: ReleaseNoteDTO[];
}

export interface ReleaseDTO extends ReleaseContent {
  id: string;
}

export const RELEASE_NOTE_TYPE_LABEL: Record<ReleaseNoteType, string> = { novo: "Novo", melhoria: "Melhoria", correcao: "Correção" };

// Area order is the display order inside a release.
export const RELEASE_NOTE_AREAS: Record<ReleaseNoteArea, { label: string; requires: Permission[]; adminOnly?: boolean }> = {
  geral: { label: "Geral", requires: [] },
  atendimento: { label: "Atendimento", requires: [PERMISSION.ATENDIMENTO_ACESSAR] },
  gestao: { label: "Gestão", requires: [PERMISSION.GESTAO_ACESSAR] },
  contatos: { label: "Contatos", requires: [PERMISSION.CONTATOS_ACESSAR] },
  dashboard: { label: "Dashboard e Relatórios", requires: [PERMISSION.DASHBOARD_ACESSAR] },
  usuarios: { label: "Usuários", requires: [PERMISSION.USUARIOS_VISUALIZAR] },
  respostas: { label: "Respostas", requires: [PERMISSION.RESPOSTAS_RAPIDAS_GERENCIAR] },
  popup: { label: "Pop Up", requires: [PERMISSION.POPUP_ACESSAR] },
  fluxo: { label: "Fluxo", requires: [PERMISSION.FLUXO_VISUALIZAR] },
  dados: { label: "Dados", requires: [PERMISSION.FONTES_DADOS_VER] },
  conexoes: { label: "Conexões", requires: [PERMISSION.CONEXOES_GERENCIAR] },
  configuracoes: { label: "Configurações", requires: [PERMISSION.CONFIGURACOES_GERENCIAR] },
  landingPage: { label: "Landing Page", requires: [PERMISSION.LANDING_PAGE_VISUALIZAR] },
  administracao: { label: "Administração", requires: [], adminOnly: true },
};

export function canSeeReleaseNote(note: ReleaseNoteDTO, role: Role, permissions: PermissionMap): boolean {
  const area = RELEASE_NOTE_AREAS[note.area];
  if (note.roles && note.roles.length > 0 && !note.roles.includes(role)) return false;
  if (area.adminOnly) return role === "ADMIN";
  return [...area.requires, ...(note.requires ?? [])].every((p) => permissions[p]);
}

/** Releases trimmed to the notes this user can see; releases left empty are dropped. */
export function visibleReleases<R extends ReleaseContent>(releases: R[], role: Role, permissions: PermissionMap): R[] {
  return releases.map((r) => ({ ...r, notes: r.notes.filter((n) => canSeeReleaseNote(n, role, permissions)) })).filter((r) => r.notes.length > 0);
}

/** Compares "2.10.0" and "2.9.1" as numbers, part by part. */
export function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) - (pb[i] ?? 0);
  return 0;
}

// --- Atendimento: ferramentas do atendente (fixar, lembrar de retornar, agendar envio, Meu dia) ---

export interface ConversationReminderDTO {
  id: string;
  conversationId: string;
  remindAt: string;
  note: string | null;
  /** Set once the notice went off — the reminder stays until the attendant dismisses it. */
  firedAt: string | null;
}

export interface ScheduledMessageDTO {
  id: string;
  conversationId: string;
  body: string;
  sendAt: string;
}

export interface AgentExtrasDTO {
  pinnedConversationIds: string[];
  reminders: ConversationReminderDTO[];
  scheduledMessages: ScheduledMessageDTO[];
}

export interface MyDayDTO {
  /** Conversations this attendant closed today. */
  closedToday: number;
  /** Average time from accepting to the first reply, today; null without any. */
  avgFirstResponseMs: number | null;
  /** This attendant's NPS (0 to 100) this month; null without answers. */
  npsThisMonth: number | null;
  /** Progress on each active goal that applies to this attendant (see GoalDTO). */
  goals: MyDayGoalDTO[];
}

export type GoalType = "CLOSED_PER_DAY" | "AVG_FIRST_RESPONSE" | "NPS";
export type GoalScope = "ALL" | "CONNECTIONS" | "AGENTS";

export const GOAL_TYPE_LABEL: Record<GoalType, string> = {
  CLOSED_PER_DAY: "Encerradas por dia",
  AVG_FIRST_RESPONSE: "Tempo médio de 1ª resposta (min)",
  NPS: "NPS do mês",
};

/** Metas (Configurações › Fila). When several active goals of a type match someone, the most specific wins: AGENTS > CONNECTIONS > ALL. */
export interface GoalDTO {
  id: string;
  type: GoalType;
  /** Count (CLOSED_PER_DAY), minutes (AVG_FIRST_RESPONSE, lower is better) or NPS (-100..100). */
  target: number;
  active: boolean;
  scope: GoalScope;
  connectionIds: string[];
  agentIds: string[];
}

export interface MyDayGoalDTO {
  type: GoalType;
  target: number;
  /** Same unit as target; null when there is nothing to measure yet (no reply / no survey answer). */
  current: number | null;
  achieved: boolean;
}

// ---------------------------------------------------------------------------
// Fontes de dados: a spreadsheet (link, Microsoft account or upload) or a
// database the client panel, the {{dados.coluna}} tags and the boleto read.
// Only one source is active at a time, and nothing is shown unless it is
// active, synced without error and not older than its limit.
// ---------------------------------------------------------------------------

export type DataSourceKind = "LINK" | "MICROSOFT" | "UPLOAD" | "DATABASE";
export type DataSourceDialect = "sqlserver" | "postgres" | "mysql";
/** OK = usable; the others explain why nothing is shown to the attendant. */
export type DataSourceStatus = "OK" | "INACTIVE" | "ERROR" | "STALE" | "EMPTY";

/** The columns the system understands, with the column name the WhatsAtendende spreadsheet script produces. */
export const DATA_SOURCE_ROLES = {
  phone: { label: "Telefone (WhatsApp)", column: "telefone_whatsapp" },
  clientKey: { label: "Código do cliente", column: "codigo_cliente" },
  clientName: { label: "Nome do cliente", column: "nome_cliente" },
  cpf: { label: "CPF/CNPJ", column: "cpf_cnpj" },
  contract: { label: "Número do contrato", column: "numero_contrato" },
  plan: { label: "Plano", column: "plano" },
  contractStatus: { label: "Situação do contrato", column: "situacao_contrato" },
  cancelDate: { label: "Data do cancelamento", column: "data_cancelamento" },
  cancelReason: { label: "Motivo do cancelamento", column: "motivo_cancelamento" },
  beneficiaries: { label: "Beneficiários", column: "beneficiarios" },
  suspensionThreshold: { label: "Parcelas para suspender", column: "parcelas_suspensao" },
  document: { label: "Documento da parcela", column: "documento" },
  parcelDue: { label: "Vencimento da parcela", column: "vencimento_parcela" },
  daysLate: { label: "Dias em atraso", column: "dias_em_atraso" },
  parcelValue: { label: "Saldo da parcela", column: "saldo" },
  fine: { label: "Multa", column: "multa" },
  interest: { label: "Juros", column: "juros" },
  updatedValue: { label: "Valor atualizado", column: "valor_atualizado" },
  paymentMethod: { label: "Forma de pagamento", column: "forma_pagamento" },
  boletoDue: { label: "Vencimento do boleto", column: "vencimento_boleto" },
  boletoValue: { label: "Valor do boleto", column: "valor_boleto" },
  ourNumber: { label: "Nosso número", column: "nosso_numero" },
  pixCode: { label: "PIX copia e cola (QR Code do boleto)", column: "qr_code_boleto" },
  bankCode: { label: "Código do banco", column: "banco_codigo" },
  agency: { label: "Agência do beneficiário", column: "agencia_beneficiario" },
  account: { label: "Conta do beneficiário", column: "conta_beneficiario" },
  agreement: { label: "Convênio", column: "convenio" },
  wallet: { label: "Carteira", column: "carteira" },
  walletVariation: { label: "Variação da carteira", column: "variacao_carteira" },
  post: { label: "Posto do beneficiário (Sicredi)", column: "posto_beneficiario" },
  payeeName: { label: "Beneficiário (empresa)", column: "beneficiario_nome" },
  payeeDocument: { label: "CNPJ do beneficiário", column: "beneficiario_cnpj" },
  payerAddress: { label: "Endereço do cliente", column: "endereco" },
  payerCity: { label: "Cidade do cliente", column: "cidade" },
  payerZip: { label: "CEP do cliente", column: "cep" },
} as const;
export type DataSourceRole = keyof typeof DATA_SOURCE_ROLES;

// Spreadsheet column names are written without accents ("situacao_contrato"): the words as people read them.
const COLUMN_WORDS: Record<string, string> = {
  codigo: "código", numero: "número", situacao: "situação", endereco: "endereço", beneficiarios: "beneficiários",
  beneficiario: "beneficiário", mae: "mãe", pai: "pai", observacao: "observação", observacoes: "observações",
  informacao: "informação", informacoes: "informações", ultimo: "último", ultima: "última", proximo: "próximo",
  proxima: "próxima", responsavel: "responsável", conjuge: "cônjuge", orgao: "órgão", emissao: "emissão",
  inicio: "início", adesao: "adesão", cep: "CEP", cpf: "CPF", cnpj: "CNPJ", rg: "RG", uf: "UF", whatsapp: "WhatsApp", email: "e-mail",
  id: "ID", ddd: "DDD", nascimento: "nascimento",
};
const COLUMN_LABELS: Record<string, string> = {
  cpf_cnpj: "CPF/CNPJ",
  telefone_whatsapp: "Telefone (WhatsApp)",
};

// "data_contrato" reads "Data do contrato": the article a second word takes.
const OF_THE: Record<string, string> = {
  contrato: "do", cliente: "do", vencimento: "do", plano: "do", pagamento: "do", cadastro: "do", titular: "do", boleto: "do",
  parcela: "da", adesao: "da", empresa: "da", cidade: "da", mae: "da",
};

/** "situacao_contrato" → "Situação do contrato"; the system's own columns keep their names ("CPF/CNPJ", "Telefone (WhatsApp)"). */
export function dataColumnLabel(column: string): string {
  if (COLUMN_LABELS[column]) return COLUMN_LABELS[column];
  const raw = column.split(/_+/).filter(Boolean);
  const words = raw.map((w) => COLUMN_WORDS[w] ?? w);
  if (raw.length >= 2 && OF_THE[raw[1]]) words.splice(1, 0, OF_THE[raw[1]]);
  const text = words.join(" ");
  return text ? text.charAt(0).toUpperCase() + text.slice(1) : column;
}

export interface DataSourceDTO {
  id: string;
  name: string;
  kind: DataSourceKind;
  active: boolean;
  status: DataSourceStatus;
  /** LINK: url · MICROSOFT: shareUrl/tenantId/clientId · UPLOAD: fileName · DATABASE: dialect/host/port/database/user/query. Never secrets. */
  config: Record<string, string | number | null>;
  /** MICROSOFT: a Microsoft account is signed in. DATABASE: a password is saved. */
  hasSecrets: boolean;
  columnMap: Partial<Record<DataSourceRole, string>>;
  sensitiveColumns: string[];
  overrideContactName: boolean;
  maxAgeHours: number;
  refreshMinutes: number;
  columns: string[];
  rowCount: number;
  dataUpdatedAt: string | null;
  lastSyncAt: string | null;
  lastSyncError: string | null;
  /** Being read right now (a big sheet takes minutes); the panel shows "Processando..." until it ends. */
  syncing: boolean;
  /** Every connection not linked to another active source, or only connectionIds. */
  allConnections: boolean;
  connectionIds: string[];
  /** Bank code → BoletoLayout id. */
  bankLayouts: Record<string, string>;
}

/** A bank found in a source's parcels, and the layout its boletos come out in. */
export interface DataSourceBankDTO {
  code: string;
  name: string;
  parcels: number;
  /** Boletos of this bank can be sent (validated with real ones). */
  enabled: boolean;
}

export interface ClientBeneficiaryDTO {
  name: string;
  relation: string | null;
  /** Computed from the birth date; null when the source has none. */
  age: number | null;
  aggregated: boolean;
  holder: boolean;
  /** "dd/mm" of the birth date; null when the source has none. */
  birthday?: string | null;
  /** Days until the next birthday (0 = today). */
  daysUntilBirthday?: number | null;
}

export interface ClientParcelDTO {
  /** DataSourceRow id — what the boleto sending refers to. */
  id: string;
  document: string | null;
  due: string | null;
  daysLate: number;
  value: string | null;
  /** Multa, juros e saldo + encargos até hoje, como o ERP calcula — o boleto continua com o valor registrado. */
  fine: string | null;
  interest: string | null;
  updatedValue: string | null;
  paymentMethod: string | null;
  overdue: boolean;
}

export interface ClientContractDTO {
  number: string;
  plan: string | null;
  status: string | null;
  overdueCount: number;
  /** ≥ this many overdue parcels suspends the contract (ERP parameter); null when the source doesn't say. */
  suspensionThreshold: number | null;
  suspended: boolean;
  /** Canceled contracts: when and why (dd/mm/aaaa, as in the list). */
  canceledAt: string | null;
  cancelReason: string | null;
  beneficiaries: ClientBeneficiaryDTO[];
  parcels: ClientParcelDTO[];
  /** This contract's own columns (data do contrato, dia do vencimento, valor em atraso...). */
  fields: ClientDataFieldDTO[];
}

export interface ClientDataFieldDTO {
  column: string;
  /** Masked ("•••") for a sensitive column until revealed. */
  value: string;
  sensitive: boolean;
}

export interface ClientDataDTO {
  /** NO_SOURCE: no active source · UNAVAILABLE: error or stale beyond the limit · NOT_FOUND: phone not in the data · OK. */
  status: "NO_SOURCE" | "UNAVAILABLE" | "NOT_FOUND" | "OK";
  /** Why it's unavailable — only for people who can see Fontes de dados. */
  reason: string | null;
  dataUpdatedAt: string | null;
  /** Several clients share this phone and none was picked yet: the attendant chooses (name + partial CPF). */
  clients: { key: string; name: string; cpfPartial: string | null }[];
  selectedClientKey: string | null;
  client: {
    key: string;
    name: string | null;
    fields: ClientDataFieldDTO[];
    contracts: ClientContractDTO[];
  } | null;
  /** A contract is suspended and this conversation hasn't shown the warning yet. */
  suspensionWarningPending: boolean;
}

/** Result of filling the {{dados.coluna}} tags for a conversation. */
export interface DataTagRenderDTO {
  text: string;
  /** Tags with no value for this client — the message can't be sent. */
  missing: string[];
}

/** Columns available as {{dados.coluna}} tags right now — empty when no source is usable. */
export interface DataTagsDTO {
  available: boolean;
  columns: string[];
}

// ---------------------------------------------------------------------------
// Boleto: sent from Dados do cliente, built only from the data source (never
// from a linha typed by someone). A bank is only enabled after its boletos
// matched 3 real ones (Configurações › Fontes de dados).
// ---------------------------------------------------------------------------

export const BOLETO_SAMPLES_REQUIRED = 3;

export interface BoletoBankValidationDTO {
  code: string;
  name: string;
  matched: number;
  required: number;
  enabled: boolean;
  lastFailure: string | null;
}

export interface BoletoPreviewItemDTO {
  parcelId: string;
  contract: string;
  document: string | null;
  due: string;
  value: string;
  overdue: boolean;
  linha: string;
  /** The boleto's PIX copia e cola (its QR Code), when the source has a valid one; null = no PIX on this boleto. */
  pix: string | null;
}

export interface BoletoPreviewDTO {
  items: BoletoPreviewItemDTO[];
  /** Suggested message, editable before sending. */
  message: string;
  /** "Boleto vencido em ..." — must be confirmed, the due date is never changed. */
  warnings: string[];
}

// --- Dados › Mensagens do boleto: instruction lines printed on the boleto -------------------------------------------

/** {multa} and {juros_dia} are worked out from each boleto's original value. */
export interface BoletoInstructionInput {
  name: string;
  finePercent: number;
  interestMonthPercent: number;
  lines: string[];
}

export interface BoletoInstructionDTO extends BoletoInstructionInput {
  id: string;
  /** Names of the layouts that bring it in with {mensagem:Nome}. */
  usedBy: string[];
}

export const BOLETO_INSTRUCTION_LINES_MAX = 6;
export const BOLETO_INSTRUCTION_LINE_MAX_LENGTH = 90;
export const BOLETO_INSTRUCTION_TAGS = ["{multa}", "{juros_dia}", "{contrato}", "{documento}", "{vencimento}", "{valor}"] as const;

export const DEFAULT_BOLETO_INSTRUCTION: BoletoInstructionInput = {
  name: "Instruções padrão",
  finePercent: 2,
  interestMonthPercent: 1,
  lines: [
    "-> Após Vencimento Cobrar Multa de R$ {multa}",
    "-> Após Vencimento Cobrar Juros Diários de R$ {juros_dia}",
    "-> Sujeito a protesto após 5 (cinco) dias do vencto.",
    "-> Para pagamento até o vencimento o desconto será de 5%",
    "-> Contrato: {contrato}  Documento: {documento}",
  ],
};

const centsText = (cents: number) => (cents / 100).toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** Instruction lines of one boleto: multa = value × %, juros ao dia = value × % ao mês ÷ 30, rounded to the cent. */
export function fillBoletoInstructions(
  settings: Pick<BoletoInstructionInput, "finePercent" | "interestMonthPercent" | "lines">,
  boleto: { cents: number; contract: string; document: string | null; due: string }
): string[] {
  const values: Record<string, string> = {
    "{multa}": centsText(Math.round((boleto.cents * settings.finePercent) / 100)),
    "{juros_dia}": centsText(Math.round((boleto.cents * settings.interestMonthPercent) / 100 / 30)),
    "{contrato}": boleto.contract,
    "{documento}": boleto.document ?? "",
    "{vencimento}": boleto.due,
    "{valor}": centsText(boleto.cents),
  };
  return settings.lines.map((line) => line.replace(/\{(multa|juros_dia|contrato|documento|vencimento|valor)\}/g, (tag) => values[tag]));
}

// --- Dados › Layouts de boleto ------------------------------------------------------------------------------------

/** Banks a layout can be made for (the boleto code is only built for these). */
export const BOLETO_BANKS: Record<string, string> = { "001": "Banco do Brasil", "748": "Sicredi", "237": "Bradesco", "341": "Itaú", "104": "Caixa" };
/** The banks by name ("104" would otherwise come before "001": numeric keys go first in an object). */
export const BOLETO_BANK_CODES = Object.keys(BOLETO_BANKS).sort((a, b) => BOLETO_BANKS[a].localeCompare(BOLETO_BANKS[b], "pt-BR"));

/**
 * "Local de Pagamento" as each bank's manual tells it to be printed (a new layout of that bank starts with it):
 * Sicredi CNAB 400 item 10.7; Bradesco 4008.524.0121 v17, modelo do boleto; Itaú FEBRABAN 240, nota 25 (boleto com
 * registro); Caixa SIGCB 67.119 v014, modelo do boleto. Banco do Brasil keeps the text in use.
 */
export const BOLETO_PAYMENT_PLACES: Record<string, string> = {
  "001": "Pagável em qualquer banco até o vencimento",
  "748": "PAGÁVEL PREFERENCIALMENTE NAS COOPERATIVAS DE CRÉDITO DO SICREDI",
  "237": "Pagável Preferencialmente na Rede Bradesco ou no Bradesco Expresso",
  "341": "ATÉ O VENCIMENTO, PAGUE EM QUALQUER BANCO OU CORRESPONDENTE NÃO BANCÁRIO. APÓS O VENCIMENTO, ACESSE ITAU.COM.BR/BOLETOS E PAGUE EM QUALQUER BANCO OU CORRESPONDENTE NÃO BANCÁRIO.",
  "104": "EM TODA A REDE BANCÁRIA E SEUS CORRESPONDENTES ATÉ O VALOR LIMITE",
};

export const BOLETO_LAYOUT_MODELS = {
  CARNE: { label: "Carnê: recibo à esquerda e ficha", maxPerPage: 3 },
  PADRAO: { label: "Padrão: recibo em cima e ficha", maxPerPage: 1 },
  DEMONSTRATIVO: { label: "Com demonstrativo: mensagem, recibo e ficha", maxPerPage: 1 },
  FICHA: { label: "Só a ficha de compensação", maxPerPage: 3 },
} as const;
export type BoletoLayoutModel = keyof typeof BOLETO_LAYOUT_MODELS;

/** "Data do Documento" / "Data Process.": the day the PDF is printed, or left blank. */
export type BoletoDateSource = "PRINT" | "BLANK";

export interface BoletoLayoutSettings {
  paymentPlace: string;
  documentKind: string;
  acceptance: string;
  documentDate: BoletoDateSource;
  processDate: BoletoDateSource;
  showLogo: boolean;
  showPayerDocument: boolean;
  showPayerAddress: boolean;
  showPayeeDocument: boolean;
  showGuarantor: boolean;
  /** Yellow behind Vencimento and Valor do Documento. */
  highlight: boolean;
  /** The "Instruções" box: {mensagem:Nome} lines and/or fixed lines. */
  instructions: string;
  /** The DEMONSTRATIVO model's top box — same tags. */
  demonstrative: string;
}

export const DEFAULT_BOLETO_LAYOUT_SETTINGS: BoletoLayoutSettings = {
  paymentPlace: "Pagável em qualquer banco até o vencimento",
  documentKind: "DM",
  acceptance: "N",
  documentDate: "PRINT",
  processDate: "PRINT",
  showLogo: true,
  showPayerDocument: true,
  showPayerAddress: true,
  showPayeeDocument: true,
  showGuarantor: false,
  highlight: true,
  instructions: `{mensagem:${DEFAULT_BOLETO_INSTRUCTION.name}}`,
  demonstrative: "",
};

export interface BoletoLayoutInput {
  name: string;
  bankCode: string;
  model: BoletoLayoutModel;
  perPage: number;
  settings: BoletoLayoutSettings;
}

export interface BoletoLayoutDTO extends BoletoLayoutInput {
  id: string;
  /** Names of the data sources that use it for its bank. */
  usedBy: string[];
}

/** {mensagem:Nome} in a layout's text: brings in that instruction message. */
export const BOLETO_MESSAGE_TAG = /\{mensagem:([^}]+)\}/g;

// --- Dados › Mensagem de envio: the WhatsApp text that goes with the PDF -----------------------------------------

export interface BoletoSendMessageDTO {
  /** One boleto. */
  single: string;
  /** Several boletos in the same PDF. */
  plural: string;
}

/**
 * {{primeiro_nome}} (Respostas) and {primeiro_nome} (boleto): the first word of the customer's name, "MARIA SILVA" →
 * "Maria". With no name saved the conversation shows the number, and a number stays whole.
 */
export function firstNameOf(name: string | null | undefined): string {
  const trimmed = (name ?? "").trim();
  // Just the number: it stays whole.
  if (!/\p{L}/u.test(trimmed)) return trimmed.split(/\s+/)[0] ?? "";
  // "123 tgs maria" → "Maria"; "dr carlos mendes" → "Dr. Carlos" (see normalizeContactName).
  return firstNameWithTitle(normalizeContactName(trimmed) ?? trimmed);
}

/**
 * {{saudacao}}: "Bom dia" from 05:00 to 12:00, "Boa tarde" from 12:01 to 17:59 and "Boa noite" from 18:00 to 04:59, at
 * the business' local time. utcOffsetMinutes is what Date.getTimezoneOffset reports there (240 = UTC−4).
 */
export function greetingFor(now: Date, utcOffsetMinutes: number): "Bom dia" | "Boa tarde" | "Boa noite" {
  const minutes = (((now.getUTCHours() * 60 + now.getUTCMinutes() - utcOffsetMinutes) % 1440) + 1440) % 1440;
  if (minutes >= 5 * 60 && minutes <= 12 * 60) return "Bom dia";
  if (minutes < 18 * 60 && minutes > 12 * 60) return "Boa tarde";
  return "Boa noite";
}

/** Replaces {{saudacao}} with the greeting for this moment. */
export function fillGreetingTag(text: string, utcOffsetMinutes: number, now: Date = new Date()): string {
  return text.replace(/\{\{\s*saudacao\s*\}\}/gi, () => greetingFor(now, utcOffsetMinutes));
}

/** {{primeiro_nome}}: the contact's own Primeiro nome when filled, else the first word of the name. */
export function customerFirstName(customerName: string, savedFirstName?: string | null): string {
  return savedFirstName?.trim() || firstNameOf(customerName);
}

/** Replaces {{cliente}} and {{primeiro_nome}} in a text sent to a customer. */
export function fillCustomerTags(text: string, customerName: string, savedFirstName?: string | null): string {
  return text
    .replace(/\{\{\s*primeiro_nome\s*\}\}/gi, customerFirstName(customerName, savedFirstName))
    .replace(/\{\{\s*cliente\s*\}\}/gi, customerName);
}

export const BOLETO_SEND_MESSAGE_MAX_LENGTH = 1000;
export const BOLETO_SEND_MESSAGE_TAGS = ["{primeiro_nome}", "{cliente}", "{quantidade}", "{vencimento}", "{valor}", "{total}"] as const;

export const DEFAULT_BOLETO_SEND_MESSAGE: BoletoSendMessageDTO = {
  single: "Olá, {primeiro_nome}! Segue o boleto da parcela com vencimento em {vencimento}, no valor de {valor}.",
  plural: "Olá, {primeiro_nome}! Seguem os boletos das {quantidade} parcelas, todos no mesmo arquivo, no total de {total}.",
};

/**
 * The send message for these boletos: the plural one when there's more than one. {vencimento} and {valor} are the
 * first boleto's (the only one, in the singular); {total} adds them all up.
 */
export function fillBoletoSendMessage(
  settings: BoletoSendMessageDTO,
  input: { clientName: string; boletos: { due: string; cents: number }[] }
): string {
  const template = input.boletos.length > 1 ? settings.plural : settings.single;
  const total = input.boletos.reduce((sum, b) => sum + b.cents, 0);
  const values: Record<string, string> = {
    "{primeiro_nome}": firstNameOf(input.clientName),
    "{cliente}": input.clientName.trim(),
    "{quantidade}": String(input.boletos.length),
    "{vencimento}": input.boletos[0]?.due ?? "",
    "{valor}": `R$ ${centsText(input.boletos[0]?.cents ?? 0)}`,
    "{total}": `R$ ${centsText(total)}`,
  };
  return template
    .replace(/\{(primeiro_nome|cliente|quantidade|vencimento|valor|total)\}/g, (tag) => values[tag])
    .replace(/,\s*!/g, "!");
}

/** Why a parcel can't get a boleto (shown next to it), or null when it can. */
export interface BoletoAvailabilityDTO {
  parcelId: string;
  blockedReason: string | null;
}

// ---------------------------------------------------------------------------
// Chat interno: the team talking among themselves. Messages are kept forever.
// ---------------------------------------------------------------------------

export type ChatRoomKind = "GENERAL" | "DIRECT" | "GROUP";

export interface ChatMemberDTO {
  userId: string;
  name: string;
  photoUrl: string | null;
  presence: AgentPresence;
  isOwner: boolean;
  isAdmin: boolean;
}

/** Gestão › Chat interno: someone who is no longer in the group, and how they left. */
export interface ChatFormerMemberDTO {
  userId: string;
  name: string;
  leftAt: string;
  /** Who took them out (an owner/admin, or the owner deleting the group); null when they left by themselves. */
  removedByName: string | null;
}

export interface ChatPinDTO {
  messageId: string;
  preview: string;
  authorName: string | null;
  pinnedByName: string;
  until: string | null;
}

/** Mensagens autoexplosivas da conversa individual: the choices offered (seconds); any other value is "Personalizado". */
export const CHAT_AUTO_DELETE_PRESETS = [5, 10, 30, 60, 300, 3600, 86400] as const;
/** "Enviar como temporária": gone this long after sending. */
export const CHAT_TEMPORARY_PRESETS = [60, 3600, 86400, 604800] as const;
/** Editing and deleting one's own message is possible for this long after sending. */
export const CHAT_EDIT_WINDOW_MINUTES = 15;
/** Up to this many pinned messages per conversation. */
export const CHAT_MAX_PINS = 3;
/** Up to this many conversations pinned to the top of one's list. */
export const CHAT_MAX_FAVORITES = 3;
/** "Chamar a atenção" again only after this long, per person. */
export const CHAT_NUDGE_COOLDOWN_SECONDS = 30;
/** Audio messages up to this long. */
export const CHAT_MAX_AUDIO_SECONDS = 300;

/** "30 segundos", "5 minutos", "1 hora", "1 dia", "2 horas"... */
export function chatDurationLabel(seconds: number): string {
  const units: [number, string, string][] = [
    [604800, "semana", "semanas"],
    [86400, "dia", "dias"],
    [3600, "hora", "horas"],
    [60, "minuto", "minutos"],
    [1, "segundo", "segundos"],
  ];
  for (const [size, one, many] of units) {
    if (seconds >= size && seconds % size === 0) {
      const n = seconds / size;
      return `${n} ${n === 1 ? one : many}`;
    }
  }
  return `${seconds} segundos`;
}

export interface ChatRoomDTO {
  id: string;
  kind: ChatRoomKind;
  /** "#Geral", the group's name, or the other person's name in a direct conversation. */
  name: string;
  description: string | null;
  /** GROUP: the emoji drawn as its picture. */
  icon: string | null;
  /** Direct conversation: the other person (for photo and online status). */
  peer: ChatMemberDTO | null;
  members: ChatMemberDTO[];
  lastMessage: { body: string; authorName: string | null; createdAt: string } | null;
  unreadCount: number;
  /** Unread messages that mention the logged-in person (or @todos). */
  unreadMentions: number;
  mutedUntil: string | null;
  /** Pinned to the top of the logged-in person's list. */
  favorite: boolean;
  /** DIRECT: mensagens autoexplosivas, in seconds after being read; null = off. */
  autoDeleteSeconds: number | null;
  pins: ChatPinDTO[];
  /** What the logged-in person can do here. */
  canManageMembers: boolean;
  canManageAdmins: boolean;
  canLeave: boolean;
  canDelete: boolean;
  canPin: boolean;
  canNudge: boolean;
}

export type ChatMessageKind = "TEXT" | "AUDIO" | "POLL" | "NUDGE";
/** The sender's ticks, like WhatsApp: ✓ sent, ✓✓ delivered to everyone, ✓✓ colored once everyone read it. */
export type ChatMessageStatus = "SENT" | "DELIVERED" | "READ";

export interface ChatPollDTO {
  id: string;
  question: string;
  multiple: boolean;
  /** People who voted at least once. */
  voters: number;
  options: { id: string; text: string; votes: number; voterNames: string[]; mine: boolean }[];
}

export interface ChatReactionDTO {
  emoji: string;
  count: number;
  names: string[];
  mine: boolean;
}

export interface ChatMessageDTO {
  id: string;
  roomId: string;
  kind: ChatMessageKind;
  /** Null for the system's lines ("Ana saiu do grupo"). */
  authorId: string | null;
  authorName: string | null;
  body: string | null;
  attachment: { name: string; mimeType: string; size: number; url: string } | null;
  audio: { durationMs: number; waveform: number[] } | null;
  /** A customer conversation mentioned in the message. */
  conversation: { id: string; contactName: string } | null;
  replyTo: { id: string; authorName: string | null; preview: string } | null;
  /** User ids marked with @ ("ALL" for @todos). */
  mentions: string[];
  poll: ChatPollDTO | null;
  reactions: ChatReactionDTO[];
  /** NUDGE: who was called. */
  nudgeTargetId: string | null;
  nudgeTargetName: string | null;
  /** Temporary message: how long it lives, whether the clock starts on reading, and when it disappears (once started). */
  ttlSeconds: number | null;
  ttlFromRead: boolean;
  expiresAt: string | null;
  viewOnce: boolean;
  /** "Visualização única": the logged-in person already opened it (the file is no longer offered). */
  viewedByMe: boolean;
  editedAt: string | null;
  /** "Apagada": body, file and poll are gone for the people talking. */
  deletedAt: string | null;
  createdAt: string;
  /** Own messages: every other current member has read it (✓✓). */
  readByAll: boolean;
  status: ChatMessageStatus;
  /** Gestão › Chat interno only: what the people talking no longer see. */
  oversight?: {
    /** The temporary message already disappeared for them. */
    expired: boolean;
    edits: { body: string | null; editedAt: string }[];
    viewedBy: { name: string; at: string }[];
  };
}

/** "Dados da mensagem": who read it and who only received it, each with the time. */
export interface ChatMessageInfoDTO {
  readBy: { userId: string; name: string; photoUrl: string | null; at: string }[];
  deliveredTo: { userId: string; name: string; photoUrl: string | null; at: string }[];
  pending: { userId: string; name: string; photoUrl: string | null }[];
}

/** Gestão › Chat interno: every room, the finished ones included. */
export interface ChatOversightRoomDTO {
  id: string;
  kind: ChatRoomKind;
  name: string;
  icon: string | null;
  members: ChatMemberDTO[];
  formerMembers: ChatFormerMemberDTO[];
  lastMessageAt: string | null;
  autoDeleteSeconds: number | null;
  pins: ChatPinDTO[];
  /** Deleted by its owner ("finalizado"). */
  deletedAt: string | null;
  deletedByName: string | null;
  createdAt: string;
}

export interface ChatSearchResultDTO {
  roomId: string;
  roomName: string;
  messageId: string;
  authorName: string | null;
  body: string;
  createdAt: string;
}

export interface ChatUserDTO {
  id: string;
  name: string;
  photoUrl: string | null;
  presence: AgentPresence;
}

// ---------------------------------------------------------------------------
// Aniversário do cliente: the holder's and the beneficiaries' birth dates come from the Fonte de dados
// (column "beneficiarios": "Nome;Parentesco;dd/mm/aaaa;Sim|Não", the titular first).
// ---------------------------------------------------------------------------

export type BirthdayKind = "HOLDER" | "BENEFICIARY";

/** One person of a contact's contracts with a birth date — kept on the contact at every upload of the list. */
export interface ContactBirthdayEntry {
  name: string;
  relation: string | null;
  /** dd/mm/aaaa */
  birth: string;
  holder: boolean;
  contract: string | null;
}

/** Someone of the contact's contracts who has a birthday today. */
export interface BirthdayTodayDTO {
  /** Stable key of the person within the contact (their name, normalized). */
  key: string;
  name: string;
  firstName: string;
  relation: string | null;
  holder: boolean;
  /** The age they turn today. */
  age: number;
  contract: string | null;
}

export interface BirthdayPersonDTO extends BirthdayTodayDTO {
  kind: BirthdayKind;
  /** Already congratulated this year (by anyone, in any conversation). */
  greeted: { byName: string; at: string } | null;
  /** The message of Respostas › Aniversários with the tags filled; null when that message is switched off. */
  text: string | null;
  /** The card (image) that goes with it, when one was chosen. */
  media: { fileName: string; mimeType: string; url: string } | null;
}

export interface ConversationBirthdayDTO {
  /** Show the pop-up now: someone has a birthday today and the conversation hasn't shown it yet. */
  pending: boolean;
  people: BirthdayPersonDTO[];
}

export interface BirthdayMessageDTO {
  kind: BirthdayKind;
  text: string;
  active: boolean;
  media: ReplyMediaDTO | null;
  updatedAt: string;
  updatedByName: string | null;
}

/** The tags a birthday message may carry, besides the usual ones ({{saudacao}}, {{primeiro_nome}}, {{cliente}}, {{atendente}}). */
export const BIRTHDAY_TAGS = ["{{aniversariante}}", "{{aniversariante_primeiro_nome}}", "{{parentesco}}", "{{idade}}"] as const;

export const DEFAULT_BIRTHDAY_MESSAGES: Record<BirthdayKind, string> = {
  HOLDER:
    "{{saudacao}}, {{primeiro_nome}}! 🎉\n\nHoje o dia é seu, e a gente não podia deixar passar! Toda a nossa equipe deseja um feliz aniversário, com muita saúde, paz e alegria ao lado de quem você ama. 🎂🎈\n\nObrigado por fazer parte da nossa história. Conte sempre com a gente! 💙",
  BENEFICIARY:
    "{{saudacao}}, {{primeiro_nome}}! 🎉\n\nHoje é aniversário de {{aniversariante}} ({{parentesco}}), e a gente quer fazer parte dessa alegria! Mande para {{aniversariante_primeiro_nome}} um abraço carinhoso de toda a nossa equipe, com votos de muita saúde, paz e felicidade. 🎂💐",
};

/** The business' calendar day right now (BUSINESS_TZ_OFFSET_MINUTES: minutes behind UTC, 240 = UTC-4). */
export function businessDay(now: Date, utcOffsetMinutes: number): { year: number; month: number; day: number } {
  const local = new Date(now.getTime() - utcOffsetMinutes * 60_000);
  return { year: local.getUTCFullYear(), month: local.getUTCMonth() + 1, day: local.getUTCDate() };
}

const isLeapYear = (y: number) => (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;

/** dd/mm/aaaa → its parts, or null. */
export function parseBirthDate(value: string | null | undefined): { day: number; month: number; year: number } | null {
  const m = value?.trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (!m) return null;
  const [day, month, year] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (month < 1 || month > 12 || day < 1 || day > 31 || year < 1900) return null;
  return { day, month, year };
}

/** Born on 29/02: in a year without it, the birthday is on 28/02. */
export function isBirthdayOn(birth: string, today: { year: number; month: number; day: number }): boolean {
  const b = parseBirthDate(birth);
  if (!b) return false;
  if (b.month === 2 && b.day === 29 && !isLeapYear(today.year)) return today.month === 2 && today.day === 28;
  return b.month === today.month && b.day === today.day;
}

/** Days from `today` to the next birthday (0 = today). */
export function daysUntilBirthday(birth: string, today: { year: number; month: number; day: number }): number | null {
  const b = parseBirthDate(birth);
  if (!b) return null;
  const at = (year: number) => {
    const day = b.month === 2 && b.day === 29 && !isLeapYear(year) ? 28 : b.day;
    return Date.UTC(year, b.month - 1, day);
  };
  const t = Date.UTC(today.year, today.month - 1, today.day);
  const next = at(today.year) >= t ? at(today.year) : at(today.year + 1);
  return Math.round((next - t) / 86_400_000);
}

export const birthdayPersonKey = (name: string) =>
  name.normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/\s+/g, " ").trim().toLowerCase();

/** Who of these entries has a birthday today, each person once (the holder first). */
export function birthdaysToday(entries: ContactBirthdayEntry[] | null | undefined, today: { year: number; month: number; day: number }): BirthdayTodayDTO[] {
  const seen = new Set<string>();
  const result: BirthdayTodayDTO[] = [];
  for (const e of [...(entries ?? [])].sort((a, b) => Number(b.holder) - Number(a.holder))) {
    const key = birthdayPersonKey(e.name);
    if (!key || seen.has(key) || !isBirthdayOn(e.birth, today)) continue;
    seen.add(key);
    result.push({ key, name: e.name, firstName: e.name.trim().split(/\s+/)[0], relation: e.holder ? "Titular" : e.relation, holder: e.holder, age: today.year - parseBirthDate(e.birth)!.year, contract: e.contract });
  }
  return result;
}

/** Fills the birthday tags; the usual ones are filled afterwards by whoever sends it. */
export function fillBirthdayTags(text: string, person: Pick<BirthdayTodayDTO, "name" | "firstName" | "relation" | "age">): string {
  return text
    .replace(/\{\{\s*aniversariante_primeiro_nome\s*\}\}/gi, person.firstName)
    .replace(/\{\{\s*aniversariante\s*\}\}/gi, person.name)
    .replace(/\{\{\s*parentesco\s*\}\}/gi, (person.relation ?? "beneficiário").toLowerCase())
    .replace(/\{\{\s*idade\s*\}\}/gi, String(person.age));
}

// ---------------------------------------------------------------------------
// Pop Up › Avisos and the Comunicados board.
// ---------------------------------------------------------------------------

export type AnnouncementKind = "INFO" | "IMPORTANT" | "URGENT" | "CELEBRATION" | "NEWS";
export type AnnouncementLayout = "COVER" | "POSTER" | "TEXT";
export type AnnouncementDisplay = "POPUP_AND_BOARD" | "BOARD_ONLY";
export type AnnouncementRecurrence = "ONCE" | "DAILY" | "WEEKLY" | "MONTHLY";
export type AnnouncementStatus = "ACTIVE" | "SCHEDULED" | "ENDED" | "PAUSED";

export const ANNOUNCEMENT_KIND_LABEL: Record<AnnouncementKind, string> = {
  INFO: "Informativo",
  IMPORTANT: "Importante",
  URGENT: "Urgente",
  CELEBRATION: "Comemoração",
  NEWS: "Novidade",
};

export const ANNOUNCEMENT_RECURRENCE_LABEL: Record<AnnouncementRecurrence, string> = {
  ONCE: "Só no dia de início",
  DAILY: "1 vez por dia",
  WEEKLY: "1 vez por semana",
  MONTHLY: "1 vez por mês",
};

/** A person sees the pop-up of a notice at most this many times on each day it shows (each login, or live, counts once). */
export const ANNOUNCEMENT_MAX_SHOWS_PER_DAY = 2;
/** Up to this many pending notices open as pop-ups; more than this, they're grouped in a single "Você tem N novidades". */
export const ANNOUNCEMENT_POPUP_LIMIT = 2;
export const ANNOUNCEMENT_REACTIONS = ["👍", "❤️", "👏"] as const;

export interface AnnouncementAudience {
  all: boolean;
  roles: Role[];
  connectionIds: string[];
  userIds: string[];
}

export interface AnnouncementFileDTO {
  url: string;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  width?: number | null;
  height?: number | null;
}

export interface AnnouncementInput {
  title: string;
  body: string;
  kind: AnnouncementKind;
  layout: AnnouncementLayout;
  display: AnnouncementDisplay;
  category: string | null;
  requireAck: boolean;
  pinned: boolean;
  linkUrl: string | null;
  linkLabel: string | null;
  startDate: string;
  endDate: string | null;
  recurrence: AnnouncementRecurrence;
  audience: AnnouncementAudience;
}

/** A notice as the people who receive it see it (pop-up and Comunicados). */
export interface AnnouncementDTO extends AnnouncementInput {
  id: string;
  images: AnnouncementFileDTO[];
  attachments: AnnouncementFileDTO[];
  createdAt: string;
  authorName: string | null;
  readAt: string | null;
  ackAt: string | null;
  reactions: { emoji: string; count: number; mine: boolean }[];
  /** Whether it shows today (in its date range and recurrence) — older ones are the board's "Anteriores". */
  showsToday: boolean;
}

/** A notice in Pop Up › Avisos — with its state and the reading numbers. */
export interface AnnouncementAdminDTO extends AnnouncementDTO {
  paused: boolean;
  status: AnnouncementStatus;
  deletedAt: string | null;
  audienceCount: number;
  readCount: number;
  ackCount: number;
  updatedAt: string;
  /** The next day it shows (YYYY-MM-DD), null once it has ended. */
  nextDay: string | null;
}

export interface AnnouncementReceiptRowDTO {
  userId: string;
  name: string;
  role: Role;
  readAt: string | null;
  ackAt: string | null;
  shownCount: number;
}

export interface AnnouncementBoardSettingsDTO {
  /** "Comunicados" — what the board is called in the top bar and its page. */
  name: string;
  /** Days a deleted notice stays in the Lixeira before it is removed for good. */
  trashDays: number;
}

/** Dashboard › Comunicados card and the presentation's slide — Gestor and Administrador. */
export interface AnnouncementStatsDTO {
  published: number;
  audience: number;
  readRate: number | null;
  ackRate: number | null;
  items: {
    id: string;
    title: string;
    kind: AnnouncementKind;
    startDate: string;
    audience: number;
    read: number;
    acked: number;
    requireAck: boolean;
    /** Who hasn't confirmed yet (requireAck only), by name. */
    pendingNames: string[];
  }[];
  /** Readings per day of the period (YYYY-MM-DD), for the evolution chart. */
  readsByDay: { day: string; reads: number; acks: number }[];
}

// ---------------------------------------------------------------------------
// Agendamento da apresentação (Configurações › Modelos de e-mail).
// ---------------------------------------------------------------------------

export type ReportScheduleFrequency = "DAILY" | "WEEKLY" | "BIWEEKLY" | "MONTHLY" | "YEARLY" | "CUSTOM";
export type ReportScheduleRunStatus = "SENT" | "PARTIAL" | "FAILED" | "RETRYING";
export type ReportSchedulePeriod = "AUTO" | "yesterday" | "last7days" | "last15days" | "lastMonth" | "month" | "lastYear" | "year" | "all";

export const REPORT_SCHEDULE_FREQUENCY_LABEL: Record<ReportScheduleFrequency, string> = {
  DAILY: "Diário",
  WEEKLY: "Semanal",
  BIWEEKLY: "Quinzenal",
  MONTHLY: "Mensal",
  YEARLY: "Anual",
  CUSTOM: "Personalizado",
};

export const REPORT_SCHEDULE_PERIOD_LABEL: Record<ReportSchedulePeriod, string> = {
  AUTO: "Automático (acompanha a frequência)",
  yesterday: "Dia anterior",
  last7days: "Últimos 7 dias",
  last15days: "Últimos 15 dias",
  lastMonth: "Mês anterior",
  month: "Mês atual até hoje",
  lastYear: "Ano anterior",
  year: "Ano atual até hoje",
  all: "Todo o período",
};

export interface ReportScheduleAlerts {
  emails: string[];
  whatsapp: { connectionId: string; phones: string[] } | null;
  sms: { phones: string[] } | null;
}

export interface ReportScheduleInput {
  name: string;
  enabled: boolean;
  subject: string;
  title: string;
  bodyText: string;
  to: string[];
  cc: string[];
  frequency: ReportScheduleFrequency;
  time: string;
  tzOffsetMinutes: number;
  startDate: string;
  weekdays: number[];
  monthDay: number | null;
  month: number | null;
  customInterval: number;
  customUnit: "DAY" | "WEEK" | "MONTH";
  endType: "NEVER" | "AFTER" | "ON_DATE";
  endAfter: number | null;
  endDate: string | null;
  skipSaturday: boolean;
  skipSunday: boolean;
  period: ReportSchedulePeriod;
  agentId: string | null;
  connectionIds: string[];
  alerts: ReportScheduleAlerts;
}

export interface ReportScheduleDTO extends ReportScheduleInput {
  id: string;
  nextRunAt: string | null;
  lastRunAt: string | null;
  lastStatus: ReportScheduleRunStatus | null;
  lastError: string | null;
  runCount: number;
  createdByName: string | null;
  updatedAt: string;
}

export interface ReportScheduleRunDTO {
  id: string;
  scheduledFor: string;
  createdAt: string;
  attempt: number;
  manual: boolean;
  status: ReportScheduleRunStatus;
  recipients: string[];
  rejected: string[];
  error: string | null;
}

/** Returned with a save: other schedules that send on the same day to someone in common — a warning, never a block. */
export interface ReportScheduleConflictDTO {
  scheduleId: string;
  name: string;
  day: string;
  recipients: string[];
}

export interface ReportScheduleSaveResultDTO {
  schedule: ReportScheduleDTO;
  conflicts: ReportScheduleConflictDTO[];
  externalRecipients: string[];
}

// ---------------------------------------------------------------------------
// Configurações › SMS — one provider at a time; the option to warn by SMS only
// shows once a test SMS went through (verifiedAt).
// ---------------------------------------------------------------------------

export type SmsProviderId = "ZENVIA" | "TWILIO" | "COMTELE" | "MOBIZON" | "TOTALVOICE" | "SMSDEV" | "VONAGE" | "AWS_SNS" | "GENERIC_HTTP";

export interface SmsProviderField {
  key: string;
  label: string;
  secret?: boolean;
  placeholder?: string;
  help?: string;
  multiline?: boolean;
  options?: { value: string; label: string }[];
}

export const SMS_PROVIDERS: Record<SmsProviderId, { label: string; site: string; fields: SmsProviderField[] }> = {
  ZENVIA: {
    label: "Zenvia",
    site: "zenvia.com",
    fields: [
      { key: "token", label: "API Token (X-API-TOKEN)", secret: true },
      { key: "from", label: "Remetente (nome da conta de SMS)", placeholder: "minha-conta" },
    ],
  },
  TWILIO: {
    label: "Twilio",
    site: "twilio.com",
    fields: [
      { key: "accountSid", label: "Account SID", placeholder: "ACxxxxxxxx" },
      { key: "authToken", label: "Auth Token", secret: true },
      { key: "from", label: "Número remetente (ou Messaging Service SID)", placeholder: "+15551234567" },
    ],
  },
  COMTELE: {
    label: "Comtele",
    site: "comtele.com.br",
    fields: [{ key: "authKey", label: "Chave de autenticação (auth-key)", secret: true }],
  },
  MOBIZON: {
    label: "Mobizon",
    site: "mobizon.com.br",
    fields: [
      { key: "apiKey", label: "Chave da API", secret: true },
      { key: "apiServer", label: "Servidor da API", placeholder: "api.mobizon.com.br" },
      { key: "from", label: "Remetente (opcional)" },
    ],
  },
  TOTALVOICE: {
    label: "TotalVoice",
    site: "totalvoice.com.br",
    fields: [{ key: "accessToken", label: "Access-Token", secret: true }],
  },
  SMSDEV: {
    label: "SMSDev",
    site: "smsdev.com.br",
    fields: [{ key: "key", label: "Chave da API", secret: true }],
  },
  VONAGE: {
    label: "Vonage (Nexmo)",
    site: "vonage.com",
    fields: [
      { key: "apiKey", label: "API Key" },
      { key: "apiSecret", label: "API Secret", secret: true },
      { key: "from", label: "Remetente", placeholder: "Empresa" },
    ],
  },
  AWS_SNS: {
    label: "Amazon SNS (AWS)",
    site: "aws.amazon.com/sns",
    fields: [
      { key: "accessKeyId", label: "Access Key ID" },
      { key: "secretAccessKey", label: "Secret Access Key", secret: true },
      { key: "region", label: "Região", placeholder: "sa-east-1" },
      { key: "senderId", label: "Sender ID (opcional)" },
    ],
  },
  GENERIC_HTTP: {
    label: "Outro provedor (HTTP genérico)",
    site: "",
    fields: [
      { key: "url", label: "Endereço (URL) da API", placeholder: "https://api.provedor.com/sms/send" },
      { key: "method", label: "Método", options: [{ value: "POST", label: "POST" }, { value: "GET", label: "GET" }] },
      { key: "headers", label: "Cabeçalhos (um por linha, Nome: valor)", multiline: true, secret: true, placeholder: "Authorization: Bearer SEU_TOKEN" },
      {
        key: "body",
        label: "Corpo da requisição",
        multiline: true,
        placeholder: '{"to": "{{numero}}", "message": "{{mensagem}}"}',
        help: "Use {{numero}} (com DDI, só dígitos) e {{mensagem}}. Num GET, as tags também valem no endereço.",
      },
      {
        key: "contentType",
        label: "Tipo do corpo",
        options: [
          { value: "application/json", label: "JSON" },
          { value: "application/x-www-form-urlencoded", label: "Formulário (x-www-form-urlencoded)" },
          { value: "text/plain", label: "Texto" },
        ],
      },
    ],
  },
};

export interface SmsSettingsDTO {
  enabled: boolean;
  provider: SmsProviderId | null;
  /** Secret fields come back as "" with `secretsSet[key]` telling whether one is saved. */
  config: Record<string, string>;
  secretsSet: Record<string, boolean>;
  verifiedAt: string | null;
  lastError: string | null;
}

/** Whether the alert of a failed send can go by SMS — what the schedule form asks before showing the option. */
export interface SmsAvailabilityDTO {
  available: boolean;
  providerLabel: string | null;
}
