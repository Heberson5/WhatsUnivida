import { z, ZodIssueCode, type ZodError, type ZodErrorMap } from "zod";

/** The field an issue is about, for a message with no hand-written text: "config.host" -> "host". */
function fieldOf(path: (string | number)[]): string {
  const named = path.filter((p): p is string => typeof p === "string");
  return named[named.length - 1] ?? "dados";
}

/**
 * Portuguese for zod's own messages ("String must contain at least 1 character(s)"), used only where a schema didn't
 * write its own. They name the field, so the screen can tell the person which one to fix.
 */
const ptBrErrorMap: ZodErrorMap = (issue, ctx) => {
  const field = fieldOf(issue.path);
  switch (issue.code) {
    case ZodIssueCode.invalid_type:
      if (issue.received === "undefined" || issue.received === "null") return { message: `${field}: preencha este campo` };
      return { message: `${field}: valor em formato inválido` };
    case ZodIssueCode.too_small:
      if (issue.type === "string") return { message: Number(issue.minimum) <= 1 ? `${field}: preencha este campo` : `${field}: use pelo menos ${issue.minimum} caracteres` };
      if (issue.type === "array") return { message: `${field}: escolha pelo menos ${issue.minimum}` };
      return { message: `${field}: o mínimo é ${issue.minimum}` };
    case ZodIssueCode.too_big:
      if (issue.type === "string") return { message: `${field}: use no máximo ${issue.maximum} caracteres` };
      if (issue.type === "array") return { message: `${field}: no máximo ${issue.maximum} itens` };
      return { message: `${field}: o máximo é ${issue.maximum}` };
    case ZodIssueCode.invalid_enum_value:
      return { message: `${field}: opção inválida` };
    case ZodIssueCode.invalid_string:
      return { message: `${field}: formato inválido` };
    case ZodIssueCode.unrecognized_keys:
      return { message: `Campos não reconhecidos: ${issue.keys.join(", ")}` };
    case ZodIssueCode.invalid_union:
      return { message: `${field}: valor em formato inválido` };
    default:
      return { message: `${field}: ${ctx.defaultError}` };
  }
};

z.setErrorMap(ptBrErrorMap);

/** "Dados inválidos: Preencha o servidor; Preencha a consulta" — what the screen shows when a form is refused. */
export function validationMessage(err: ZodError): string {
  const reasons = [...new Set(err.issues.map((issue) => issue.message).filter(Boolean))];
  if (reasons.length === 0) return "Dados inválidos";
  const shown = reasons.slice(0, 4).join("; ");
  return `Dados inválidos: ${shown}${reasons.length > 4 ? ` (e mais ${reasons.length - 4})` : ""}`;
}
