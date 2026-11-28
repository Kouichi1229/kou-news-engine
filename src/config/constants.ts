export const APP_NAME = 'kou-news-engine';
export const APP_VERSION = '0.0.0';
export const DEFAULT_PORT = 3000;
export const DEFAULT_HOST = '0.0.0.0';
export const DEFAULT_TIMEZONE = 'Asia/Taipei';
export const DEFAULT_DATABASE_PATH = './data/kou-news.db';

/**
 * When the in-process daily pipeline fires: 08:00 every day, in `APP_TIMEZONE`.
 *
 * A deployment that needs another time sets `SCHEDULE_CRON`. The value is
 * validated against `node-cron` at startup, so a typo fails loudly.
 */
export const DEFAULT_SCHEDULE_CRON = '0 8 * * *';

/**
 * How long graceful shutdown may spend draining before it gives up.
 *
 * Bounded so a stuck connection cannot hold the process open indefinitely: the
 * container's own stop grace period is expected to be larger than this value.
 */
export const DEFAULT_SHUTDOWN_TIMEOUT_MS = 8000;
export const MIN_SHUTDOWN_TIMEOUT_MS = 1000;
export const MAX_SHUTDOWN_TIMEOUT_MS = 60000;

/**
 * Provider-level default timeout for one LLM call.
 *
 * Unlike `LEASE_MS`, this is a deployment property: a slower vendor or a larger
 * model legitimately needs longer, so it is configurable rather than fixed.
 */
export const DEFAULT_LLM_TIMEOUT_MS = 30000;
export const MIN_LLM_TIMEOUT_MS = 1000;
export const MAX_LLM_TIMEOUT_MS = 120000;

/**
 * Seeds `LlmRequest.maxOutputTokens` at the composition layer.
 *
 * Not a provider setting: different callers legitimately want different caps, so
 * this is only the fallback a caller may override per request.
 */
export const DEFAULT_LLM_MAX_OUTPUT_TOKENS = 2048;
export const MIN_LLM_MAX_OUTPUT_TOKENS = 1;
export const MAX_LLM_MAX_OUTPUT_TOKENS = 32768;

/**
 * How many articles one `extract --execute` run processes.
 *
 * Small on purpose: every processed article costs one real LLM call, and a single
 * run over a large backlog would exhaust a free-tier quota before it finished.
 * `--limit <n>` overrides it per invocation.
 */
export const DEFAULT_EXTRACT_LIMIT = 5;
export const MIN_EXTRACT_LIMIT = 1;
export const MAX_EXTRACT_LIMIT = 100;

/**
 * Fixed pause between two real LLM calls in one extraction run.
 *
 * Free tiers are limited per minute, and the extraction loop is serial, so a
 * fixed 4 s gap keeps the run inside 15 requests per minute without any adaptive
 * logic. Only real providers are paced; the `fake` provider never builds a hook.
 */
export const DEFAULT_LLM_CALL_INTERVAL_MS = 4000;
