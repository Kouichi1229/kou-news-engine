import { z } from 'zod';

import {
  DEFAULT_DATABASE_PATH,
  DEFAULT_HOST,
  DEFAULT_PORT,
  DEFAULT_SHUTDOWN_TIMEOUT_MS,
  DEFAULT_TIMEZONE,
  MAX_SHUTDOWN_TIMEOUT_MS,
  MIN_SHUTDOWN_TIMEOUT_MS,
} from './constants.js';

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().max(65535).default(DEFAULT_PORT),
  HOST: z.string().min(1).default(DEFAULT_HOST),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
  APP_TIMEZONE: z.string().min(1).default(DEFAULT_TIMEZONE),
  DATABASE_PATH: z.string().min(1).default(DEFAULT_DATABASE_PATH),
  SHUTDOWN_TIMEOUT_MS: z.coerce
    .number()
    .int()
    .min(MIN_SHUTDOWN_TIMEOUT_MS)
    .max(MAX_SHUTDOWN_TIMEOUT_MS)
    .default(DEFAULT_SHUTDOWN_TIMEOUT_MS),
});

export type Env = z.infer<typeof envSchema>;

export function loadEnv(source: NodeJS.ProcessEnv): Env {
  const result = envSchema.safeParse(source);

  if (!result.success) {
    const details = result.error.issues
      .map((issue) => `  - ${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('\n');
    throw new Error(`Invalid environment configuration:\n${details}`);
  }

  return result.data;
}

export const env: Env = loadEnv(process.env);
