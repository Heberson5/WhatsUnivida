import type { Role } from "./index";

export interface ColumnDefinition {
  key: string;
  label: string;
  /** Essential column — always shown, can still be moved. */
  fixed?: boolean;
  /** Starts hidden: shown once someone turns it on in the ⋮ menu. */
  hiddenByDefault?: boolean;
}

export interface ColumnScreenDefinition {
  label: string;
  columns: ColumnDefinition[];
}

/**
 * Every table that has the ⋮ column menu, with its columns in the system's
 * default order. Shared so Configurações › Visões de colunas can name and
 * edit any screen's columns, and the API can reject unknown keys.
 */
export const COLUMN_SCREENS = {
  gestao: {
    label: "Gestão",
    columns: [
      { key: "client", label: "Cliente", fixed: true },
      { key: "status", label: "Status" },
      { key: "agent", label: "Atendente" },
      { key: "connection", label: "Conexão" },
      { key: "waiting", label: "Esperando" },
      { key: "lastActivity", label: "Última atividade" },
    ],
  },
  contatos: {
    label: "Contatos",
    columns: [
      { key: "name", label: "Nome", fixed: true },
      { key: "phone", label: "Telefone" },
      { key: "contract", label: "Contrato" },
      { key: "firstName", label: "Primeiro nome", hiddenByDefault: true },
      { key: "connection", label: "Conexão" },
      { key: "tags", label: "Etiquetas" },
      { key: "conversations", label: "Conversas" },
      { key: "firstConversationAt", label: "Primeiro contato" },
      { key: "lastInteractionAt", label: "Última interação" },
    ],
  },
  usuarios: {
    label: "Usuários",
    columns: [
      { key: "name", label: "Nome", fixed: true },
      { key: "email", label: "E-mail" },
      { key: "role", label: "Perfil" },
      { key: "connection", label: "Conexão WhatsApp" },
      { key: "status", label: "Status" },
      { key: "presence", label: "Presença" },
      { key: "lastAccess", label: "Último acesso" },
    ],
  },
  auditoria: {
    label: "Auditoria",
    columns: [
      { key: "createdAt", label: "Data/hora", fixed: true },
      { key: "user", label: "Usuário" },
      { key: "action", label: "Ação" },
      { key: "entity", label: "Entidade" },
      { key: "client", label: "Cliente" },
      { key: "text", label: "Texto" },
      { key: "ip", label: "IP" },
    ],
  },
  // Report rows are keyed by their column title (reports.service.ts), so key and label are the same.
  relatorioAtendimentos: {
    label: "Relatórios › Atendimentos",
    columns: [
      { key: "Data", label: "Data", fixed: true },
      { key: "Conexão", label: "Conexão" },
      { key: "Cliente", label: "Cliente" },
      { key: "Telefone", label: "Telefone" },
      { key: "Atendente", label: "Atendente" },
      { key: "Entrada na fila", label: "Entrada na fila" },
      { key: "Aceite", label: "Aceite" },
      { key: "Até aceite", label: "Até aceite" },
      { key: "Até 1ª resposta", label: "Até 1ª resposta" },
      { key: "Encerramento", label: "Encerramento" },
      { key: "Duração total", label: "Duração total" },
      { key: "Mensagens recebidas", label: "Mensagens recebidas" },
      { key: "Mensagens enviadas", label: "Mensagens enviadas" },
      { key: "Transferências", label: "Transferências" },
      { key: "Status", label: "Status" },
    ],
  },
  relatorioPorAtendente: {
    label: "Relatórios › Por atendente",
    columns: [
      { key: "Atendente", label: "Atendente", fixed: true },
      { key: "Conversas", label: "Conversas" },
      { key: "Mensagens enviadas", label: "Mensagens enviadas" },
      { key: "Tempo médio até aceite", label: "Tempo médio até aceite" },
      { key: "Tempo médio até 1ª resposta", label: "Tempo médio até 1ª resposta" },
      { key: "Tempo médio de atendimento", label: "Tempo médio de atendimento" },
      { key: "Transferências recebidas", label: "Transferências recebidas" },
      { key: "Transferências realizadas", label: "Transferências realizadas" },
      { key: "Avaliações recebidas", label: "Avaliações recebidas" },
      { key: "Pesquisas não respondidas", label: "Pesquisas não respondidas" },
      { key: "NPS (0 a 100)", label: "NPS (0 a 100)" },
    ],
  },
  relatorioSatisfacaoAtendentes: {
    label: "Relatórios › Satisfação por atendente",
    columns: [
      { key: "agent", label: "Atendente", fixed: true },
      { key: "sent", label: "Pesquisas" },
      { key: "answered", label: "Respostas" },
      { key: "unanswered", label: "Não responderam" },
      { key: "rate", label: "Taxa" },
      { key: "average", label: "Nota média" },
      { key: "nps", label: "NPS (0–100)" },
      { key: "variation", label: "Variação" },
      { key: "promoters", label: "Promotores" },
      { key: "passives", label: "Neutros" },
      { key: "detractors", label: "Detratores" },
      { key: "range", label: "Menor / maior" },
    ],
  },
  relatorioSatisfacaoRespostas: {
    label: "Relatórios › Respostas da pesquisa",
    columns: [
      { key: "date", label: "Data", fixed: true },
      { key: "client", label: "Cliente" },
      { key: "agent", label: "Atendente" },
      { key: "connection", label: "Conexão" },
      { key: "score", label: "Nota" },
      { key: "answer", label: "Resposta do cliente" },
      { key: "category", label: "Classificação" },
    ],
  },
  dashboardEquipe: {
    label: "Dashboard › Equipe agora",
    columns: [
      { key: "agent", label: "Atendente", fixed: true },
      { key: "now", label: "Agora" },
      { key: "conversations", label: "Conversas" },
      { key: "noReturn", label: "Sem retorno" },
      { key: "avgTime", label: "Tempo médio" },
      { key: "online", label: "Online" },
      { key: "paused", label: "Em pausa" },
    ],
  },
  respostasRapidas: {
    label: "Respostas › Respostas rápidas",
    columns: [
      { key: "name", label: "Nome", fixed: true },
      { key: "shortcut", label: "Atalho" },
      { key: "connections", label: "Conexões" },
      { key: "text", label: "Texto" },
    ],
  },
  respostasEncerramento: {
    label: "Respostas › Encerramento",
    columns: [
      { key: "name", label: "Nome", fixed: true },
      { key: "text", label: "Texto" },
      { key: "users", label: "Usuários" },
      { key: "connections", label: "Conexões" },
      { key: "status", label: "Status" },
    ],
  },
  respostasTransferencia: {
    label: "Respostas › Transferência",
    columns: [
      { key: "name", label: "Nome", fixed: true },
      { key: "text", label: "Texto" },
      { key: "connections", label: "Conexões" },
      { key: "status", label: "Status" },
    ],
  },
  respostasAceite: {
    label: "Respostas › Aceite",
    columns: [
      { key: "name", label: "Nome", fixed: true },
      { key: "text", label: "Texto" },
      { key: "connections", label: "Conexões" },
      { key: "users", label: "Quem pode usar" },
      { key: "status", label: "Status" },
    ],
  },
  respostasTemplates: {
    label: "Respostas › Templates",
    columns: [
      { key: "name", label: "Nome", fixed: true },
      { key: "category", label: "Categoria" },
      { key: "connection", label: "Conexão" },
      { key: "status", label: "Status" },
    ],
  },
  respostasPesquisa: {
    label: "Respostas › Pesquisa",
    columns: [
      { key: "name", label: "Nome", fixed: true },
      { key: "question", label: "Pergunta" },
      { key: "connections", label: "Conexões" },
      { key: "status", label: "Status" },
    ],
  },
  respostasExpediente: {
    label: "Respostas › Horário de expediente",
    columns: [
      { key: "name", label: "Nome", fixed: true },
      { key: "city", label: "Cidade" },
      { key: "schedule", label: "Dias e horários" },
      { key: "connections", label: "Conexões" },
    ],
  },
  respostasMotivoPausa: {
    label: "Respostas › Motivo de pausa",
    columns: [
      { key: "name", label: "Nome", fixed: true },
      { key: "status", label: "Status" },
    ],
  },
  feriados: {
    label: "Configurações › Feriados",
    columns: [
      { key: "date", label: "Data", fixed: true },
      { key: "name", label: "Nome" },
      { key: "scope", label: "Abrangência" },
      { key: "source", label: "Origem" },
      { key: "repeat", label: "Repete" },
    ],
  },
  permissoes: {
    label: "Configurações › Permissões",
    columns: [
      { key: "permission", label: "Permissão", fixed: true },
      { key: "AGENT", label: "Atendente" },
      { key: "MANAGER", label: "Gestor" },
      { key: "ADMIN", label: "Administrador" },
    ],
  },
  notasDeVersao: {
    label: "Configurações › Notas de versão",
    columns: [
      { key: "version", label: "Versão", fixed: true },
      { key: "date", label: "Data" },
      { key: "name", label: "Nome" },
      { key: "notes", label: "Notas" },
    ],
  },
  visoesColunas: {
    label: "Configurações › Visões de colunas",
    columns: [
      { key: "screen", label: "Tela", fixed: true },
      { key: "name", label: "Nome" },
      { key: "owner", label: "Quem salvou" },
      { key: "date", label: "Dia" },
      { key: "columns", label: "Colunas" },
      { key: "audience", label: "Quem pode usar" },
    ],
  },
} satisfies Record<string, ColumnScreenDefinition>;

export type ColumnScreen = keyof typeof COLUMN_SCREENS;
export const COLUMN_SCREEN_KEYS = Object.keys(COLUMN_SCREENS) as ColumnScreen[];

export function columnLabel(screen: ColumnScreen, key: string): string {
  const columns: ColumnDefinition[] = COLUMN_SCREENS[screen].columns;
  return columns.find((c) => c.key === key)?.label ?? key;
}

export interface ColumnViewColumn {
  key: string;
  visible: boolean;
}

export interface ColumnViewDTO {
  id: string;
  screen: ColumnScreen;
  name: string;
  columns: ColumnViewColumn[];
  ownerId: string;
  ownerName: string;
  ownerRole: Role;
  /** Everyone can use it (otherwise only the owner plus sharedWith). */
  shareAll: boolean;
  sharedWith: { id: string; name: string }[];
  createdAt: string;
  updatedAt: string;
}

/** Where the view a user sees on a screen came from: their own, one shared with them. */
export type ColumnViewSource = "own" | "shared";

export interface EffectiveColumnViewDTO extends ColumnViewDTO {
  source: ColumnViewSource;
}

/**
 * The saved columns laid over the screen's current definition: unknown keys
 * dropped, columns added after the view was saved appended at the end
 * (visible, unless they start hidden), and essential ones always visible.
 */
export function mergeColumnView(screen: ColumnScreen, saved: ColumnViewColumn[] | null | undefined): ColumnViewColumn[] {
  const defs: ColumnDefinition[] = COLUMN_SCREENS[screen].columns;
  const byKey = new Map(defs.map((d) => [d.key, d]));
  const seen = new Set<string>();
  const merged: ColumnViewColumn[] = [];
  for (const column of saved ?? []) {
    const def = byKey.get(column.key);
    if (!def || seen.has(column.key)) continue;
    seen.add(column.key);
    merged.push({ key: column.key, visible: def.fixed ? true : column.visible });
  }
  for (const def of defs) if (!seen.has(def.key)) merged.push({ key: def.key, visible: !def.hiddenByDefault });
  return merged;
}
