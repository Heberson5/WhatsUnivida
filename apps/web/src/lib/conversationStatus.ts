/** Conversation status labels and chip colors — shared by Gestão and Contatos. */
export const STATUS_LABEL: Record<string, string> = {
  IN_FLOW: "No fluxo",
  NEW: "Nova",
  WAITING: "Aguardando",
  IN_PROGRESS: "Em atendimento",
  TRANSFERRED: "Transferida",
  CLOSED: "Encerrada",
  ABANDONED: "Abandonada",
  FLOW_ABANDONED: "Abandonado no fluxo",
  HANDLED_EXTERNALLY: "Atendido pelo celular",
};

export const STATUS_COLOR: Record<string, string> = {
  IN_FLOW: "bg-info-soft text-info",
  NEW: "bg-warning-soft text-warning",
  WAITING: "bg-warning-soft text-warning",
  IN_PROGRESS: "bg-primary/15 text-primary",
  TRANSFERRED: "bg-info-soft text-info",
  CLOSED: "border border-border bg-surface-alt text-muted",
  ABANDONED: "bg-danger-soft text-danger",
  FLOW_ABANDONED: "bg-danger-soft text-danger",
  HANDLED_EXTERNALLY: "bg-secondary/40 text-[var(--color-text)]",
};
