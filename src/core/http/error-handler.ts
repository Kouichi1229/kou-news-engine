import type { NextFunction, Request, Response } from 'express';

import type { ApiErrorBody } from '../../types/api.js';
import { AppError } from '../errors.js';
import { logger } from '../logger.js';

function isJsonParseError(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    (err as { type?: unknown }).type === 'entity.parse.failed'
  );
}

export function errorHandler(err: unknown, _req: Request, res: Response, next: NextFunction): void {
  if (res.headersSent) {
    next(err);
    return;
  }

  if (isJsonParseError(err)) {
    const parseBody: ApiErrorBody = {
      error: { code: 'BAD_REQUEST', message: 'Invalid JSON request body' },
    };
    res.status(400).json(parseBody);
    return;
  }

  const isAppError = err instanceof AppError;
  const statusCode = isAppError ? err.statusCode : 500;
  const code = isAppError ? err.code : 'INTERNAL_ERROR';
  const message = isAppError && err.expose ? err.message : 'Internal server error';

  if (statusCode >= 500) {
    logger.error('Request failed', {
      code,
      message: err instanceof Error ? err.message : String(err),
    });
  }

  const body: ApiErrorBody = { error: { code, message } };
  res.status(statusCode).json(body);
}
