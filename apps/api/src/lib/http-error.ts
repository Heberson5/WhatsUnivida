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
  badRequest: (message: string, details?: unknown) => new HttpError(400, "BAD_REQUEST", message, details),
  // Distinct code (not just the 503 status) so the frontend can reliably
  // tell "system in maintenance" apart from any other server error and
  // swap in the maintenance screen instead of a generic error toast.
  maintenance: (message = "O sistema esta em manutencao. Tente novamente mais tarde.") => new HttpError(503, "MAINTENANCE", message),
};
