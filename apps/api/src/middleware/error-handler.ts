import type { NextFunction, Request, Response } from "express";
import { ZodError } from "zod";
import { MulterError } from "multer";
import { HttpError } from "../lib/http-error";
import { logger } from "../lib/logger";

const MULTER_ERROR_MESSAGE: Record<string, string> = {
  LIMIT_FILE_SIZE: "Arquivo muito grande",
};

export function errorHandler(err: unknown, req: Request, res: Response, _next: NextFunction) {
  if (err instanceof ZodError) {
    return res.status(400).json({
      error: "VALIDATION_ERROR",
      message: "Dados invalidos",
      details: err.flatten(),
    });
  }

  // A file exceeding multer's own `limits.fileSize` used to fall through to
  // the generic 500 below, showing as an unexplained "erro interno do
  // servidor" instead of the actual reason (e.g. "arquivo muito grande").
  if (err instanceof MulterError) {
    return res.status(400).json({ error: "BAD_REQUEST", message: MULTER_ERROR_MESSAGE[err.code] ?? err.message });
  }

  if (err instanceof HttpError) {
    if (err.status >= 500) logger.error({ err }, "request failed");
    return res.status(err.status).json({ error: err.code, message: err.message, details: err.details });
  }

  logger.error({ err, path: req.path }, "unhandled error");
  return res.status(500).json({ error: "INTERNAL_ERROR", message: "Erro interno do servidor" });
}
