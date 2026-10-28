import { fillGreetingTag, firstNameOf } from "@whatsatendende/types";

/**
 * Mirrors auto-message-templates.service.ts's renderAutoMessageTemplate on
 * the backend — used only to build the live preview shown while editing a
 * template (Respostas > Transferência/Aceite/Encerramento), never to build
 * the real outbound text (that always goes through the backend's own
 * substitution, with the real customer/agent on each send).
 */
export interface AutoMessageTagValues {
  atendente: string;
  atendenteNome: string;
  atendenteCargo: string;
  cliente: string;
}

const TAG_PATTERNS: { key: keyof AutoMessageTagValues; pattern: RegExp }[] = [
  { key: "atendente", pattern: /\{\{\s*atendente\s*\}\}/gi },
  { key: "atendenteNome", pattern: /\{\{\s*atendente_nome\s*\}\}/gi },
  { key: "atendenteCargo", pattern: /\{\{\s*atendente_cargo\s*\}\}/gi },
  { key: "cliente", pattern: /\{\{\s*cliente\s*\}\}/gi },
];

export function fillAutoMessageTags(text: string, values: AutoMessageTagValues): string {
  const filled = TAG_PATTERNS.reduce((acc, { key, pattern }) => acc.replace(pattern, values[key]), text);
  // {{saudacao}} in the preview: the greeting for the time on this computer now.
  return fillGreetingTag(filled.replace(/\{\{\s*primeiro_nome\s*\}\}/gi, firstNameOf(values.cliente)), new Date().getTimezoneOffset());
}

// Example values for the live preview only — illustrate the two agents a
// TRANSFER involves (who it lands ON vs. who it's SENT AS) with different
// people, same as the real distinction fixed for that trigger.
export const AGENT_EXAMPLE = { displayName: "Ana", fullName: "Ana Paula Souza", cargo: "Atendente" };
export const TRANSFER_TO_EXAMPLE = { displayName: "Administrador", fullName: "Carlos Administrador Neto", cargo: "Administrador" };
export const TRANSFER_FROM_EXAMPLE_FULLNAME = "Gislaine Souza Pereira";
export const CLIENT_EXAMPLE_NAME = "Maria Cliente";
