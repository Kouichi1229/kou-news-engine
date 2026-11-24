export interface AppErrorOptions {
  statusCode?: number;
  code?: string;
  expose?: boolean;
  cause?: unknown;
}

export class AppError extends Error {
  readonly statusCode: number;
  readonly code: string;
  readonly expose: boolean;

  constructor(message: string, options: AppErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = new.target.name;
    this.statusCode = options.statusCode ?? 500;
    this.code = options.code ?? 'INTERNAL_ERROR';
    this.expose = options.expose ?? false;
  }
}

export class NotFoundError extends AppError {
  constructor(message = 'Route not found') {
    super(message, { statusCode: 404, code: 'NOT_FOUND', expose: true });
  }
}
