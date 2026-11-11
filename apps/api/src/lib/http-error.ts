export class HttpError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public details?: unknown
  ) {
    super(message);
  }
}

export const Errors = {
  unauthorized: (message = "Nao autenticado") => new HttpError(401, "UNAUTHORIZED", message),
  forbidden: (message = "Acesso negado") => new HttpError(403, "FORBIDDEN", message),
  notFound: (message = "Nao encontrado") => new HttpError(404, "NOT_FOUND", message),
  conflict: (message: string) => new HttpError(409, "CONFLICT", message),
  // The password was chosen by someone else: nothing else works until the person chooses their own.
  passwordChangeRequired: () => new HttpError(403, "PASSWORD_CHANGE_REQUIRED", "Defina uma nova senha para continuar"),
  twoFactorSetupRequired: () => new HttpError(403, "TWO_FACTOR_SETUP_REQUIRED", "Ative a verificação em duas etapas para continuar"),
  // The password was right; the second step is missing or wrong.
  twoFactorRequired: () => new HttpError(401, "TOTP_REQUIRED", "Informe o código do aplicativo autenticador"),
  twoFactorInvalid: () => new HttpError(401, "TOTP_INVALID", "Código de verificação incorreto"),
  badRequest: (message: string, details?: unknown) => new HttpError(400, "BAD_REQUEST", message, details),
  // Distinct code (not just the 503 status) so the frontend can reliably
  // tell "system in maintenance" apart from any other server error and
  // swap in the maintenance screen instead of a generic error toast.
  maintenance: (message = "O sistema esta em manutencao. Tente novamente mais tarde.") => new HttpError(503, "MAINTENANCE", message),
};
