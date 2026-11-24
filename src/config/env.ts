import { z } from 'zod';

import {
  DEFAULT_DATABASE_PATH,
  DEFAULT_HOST,
  DEFAULT_LLM_MAX_OUTPUT_TOKENS,
  DEFAULT_LLM_TIMEOUT_MS,
  DEFAULT_PORT,
  DEFAULT_SHUTDOWN_TIMEOUT_MS,
  DEFAULT_TIMEZONE,
  MAX_LLM_MAX_OUTPUT_TOKENS,
  MAX_LLM_TIMEOUT_MS,
  MAX_SHUTDOWN_TIMEOUT_MS,
  MIN_LLM_MAX_OUTPUT_TOKENS,
  MIN_LLM_TIMEOUT_MS,
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

  // LLM settings. Every one has a default except the credential, so an
  // environment with no LLM configuration still boots.
  LLM_PROVIDER: z.enum(['gemini', 'fake']).default('fake'),
  LLM_MODEL: z.string().min(1).default('default'),
  LLM_TIMEOUT_MS: z.coerce
    .number()
    .int()
    .min(MIN_LLM_TIMEOUT_MS)
    .max(MAX_LLM_TIMEOUT_MS)
    .default(DEFAULT_LLM_TIMEOUT_MS),
  LLM_MAX_OUTPUT_TOKENS: z.coerce
    .number()
    .int()
    .min(MIN_LLM_MAX_OUTPUT_TOKENS)
    .max(MAX_LLM_MAX_OUTPUT_TOKENS)
    .default(DEFAULT_LLM_MAX_OUTPUT_TOKENS),
  // Declared optional on purpose: a missing key is not a startup error. The
  // factory validates it only when a Gemini provider is actually built, so a
  // process that selects `fake`, or builds no provider at all, needs no secret.
  // Deliberately no `superRefine` and no cross-field rule here — the schema
  // cannot know whether a provider will ever be constructed.
  GEMINI_API_KEY: z.string().optional(),
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
