import { EventEmitter } from 'node:events';

import { DEFAULT_EXTRACT_LIMIT, DEFAULT_SCHEDULE_CRON } from '../../config/constants.js';
import type { SignalHost } from '../../core/lifecycle/signal-coordinator.js';

/**
 * The daily pipeline and the cron wrapper that starts it.
 *
 * ## What runs, in what order
 *
 * `ingest` → `extract` → `notify`, once, sequentially. The steps are the same
 * entry functions the manual commands use (`runIngestionCli`, `runExtractionCli`,
 * `runNotificationCli`), so the schedule adds timing and nothing else: no second
 * implementation of selection, extraction or delivery.
 *
 * A failing step does not cancel the rest. An unreachable feed should not stop
 * the derived articles already stored from being published, so every step's exit
 * code is logged and the next step still runs. The run's own outcome is the log.
 *
 * ## Why the steps are injected
 *
 * `startDailyPipeline` in production builds them from the CLIs, but the runner
 * itself takes plain functions: a test can then assert order, failure isolation
 * and logging without a database, a feed or a Telegram token.
 */
export interface DailyPipelineLog {
  info: (message: string, meta?: unknown) => void;
  warn: (message: string, meta?: unknown) => void;
}

export interface DailyPipelineSteps {
  /** One ingestion pass. Returns the process exit code of the manual command. */
  readonly ingest: () => Promise<number>;
  /** One capped extraction pass, which also derives the Chinese summaries. */
  readonly extract: () => Promise<number>;
  /** Publishes at most one derived article to Telegram. */
  readonly notify: () => Promise<number>;
}

export interface DailyPipelineResult {
  readonly ingest: number;
  readonly extract: number;
  readonly notify: number;
}

export interface DailyPipelineOptions {
  readonly steps: DailyPipelineSteps;
  readonly log: DailyPipelineLog;
  /** Epoch milliseconds; injected so tests do not read the clock. */
  readonly now?: () => number;
}

const STEP_NAMES = {
  ingest: 'Ingestion',
  extract: 'Extraction',
  notify: 'Notification',
} as const;

/**
 * Runs the three steps in order and returns their exit codes.
 *
 * Each step is wrapped so a thrown error becomes a recorded failure instead of
 * ending the pipeline: the remaining steps still run, and the log says which one
 * broke.
 */
export async function runDailyPipeline(
  options: DailyPipelineOptions,
): Promise<DailyPipelineResult> {
  const { steps, log } = options;
  const now = options.now ?? Date.now;
  const startedAt = now();

  log.info('Daily pipeline started', { steps: ['ingest', 'extract', 'notify'] });

  const results: Record<keyof typeof STEP_NAMES, number> = { ingest: 1, extract: 1, notify: 1 };

  for (const name of ['ingest', 'extract', 'notify'] as const) {
    const stepStartedAt = now();
    try {
      const code = await steps[name]();
      results[name] = code;
      log.info(`Daily pipeline: ${STEP_NAMES[name]} finished`, {
        step: name,
        exitCode: code,
        durationMs: now() - stepStartedAt,
      });
    } catch (error) {
      log.warn(`Daily pipeline: ${STEP_NAMES[name]} threw`, {
        step: name,
        error: error instanceof Error ? error.message : String(error),
        durationMs: now() - stepStartedAt,
      });
    }
  }

  log.info('Daily pipeline finished', {
    ...results,
    durationMs: now() - startedAt,
  });

  return results;
}

/** The subset of `node-cron`'s `schedule` this module needs. */
export type CronSchedule = (
  expression: string,
  task: () => void | Promise<void>,
  options: { readonly timezone: string; readonly noOverlap?: boolean },
) => { readonly stop: () => unknown };

export interface DailySchedulerOptions {
  /** Five-field cron expression, in the deployment's timezone. */
  readonly expression?: string;
  /** IANA zone the expression is interpreted in. Defaults to `Asia/Taipei`. */
  readonly timezone: string;
  /** One pipeline run. Rejections are logged and never terminate the schedule. */
  readonly run: () => Promise<unknown>;
  readonly log: DailyPipelineLog;
  /** Injected by tests; defaults to `node-cron`'s `schedule` and `validate`. */
  readonly schedule?: CronSchedule;
  readonly validate?: (expression: string) => boolean;
}

export interface DailySchedulerHandle {
  readonly expression: string;
  readonly timezone: string;
  /** Stops future triggers. A run already in flight is not interrupted. */
  stop(): void;
}

/**
 * Starts the daily schedule.
 *
 * The expression is validated before anything is registered: a typo in
 * `SCHEDULE_CRON` must fail at startup, where the operator sees it, rather than
 * silently never firing. `noOverlap` keeps a slow run from stacking a second one
 * on top of itself.
 */
export async function startDailyScheduler(
  options: DailySchedulerOptions,
): Promise<DailySchedulerHandle> {
  const expression = options.expression ?? DEFAULT_SCHEDULE_CRON;

  const schedule: CronSchedule =
    options.schedule ??
    ((async (...args: Parameters<CronSchedule>) => {
      const cron = await import('node-cron');
      return cron.schedule(...args);
    }) as unknown as CronSchedule);

  const validate = options.validate ?? (await import('node-cron')).validate;

  if (!validate(expression)) {
    throw new Error(
      `Invalid SCHEDULE_CRON expression "${expression}". Expected five cron fields, e.g. "0 8 * * *".`,
    );
  }

  const task = schedule(
    expression,
    (): Promise<void> => {
      options.log.info('Daily schedule fired', { expression, timezone: options.timezone });
      return options
        .run()
        .then(() => undefined)
        .catch((error: unknown) => {
          options.log.warn('Daily pipeline run failed', {
            error: error instanceof Error ? error.message : String(error),
          });
        });
    },
    { timezone: options.timezone, noOverlap: true },
  );

  options.log.info('Daily schedule registered', {
    expression,
    timezone: options.timezone,
    nextHint: 'fires at 08:00 local time unless SCHEDULE_CRON overrides it',
  });

  return {
    expression,
    timezone: options.timezone,
    stop: (): void => {
      void task.stop();
    },
  };
}

/**
 * Builds the production steps from the existing entry functions.
 *
 * The CLI modules are imported here rather than at the top of this file so the
 * HTTP server's startup does not evaluate the ingestion, extraction or
 * notification entry points until the schedule actually fires.
 *
 * `extract` runs with signals detached: `runExtractionCli` installs SIGINT and
 * SIGTERM listeners for a one-shot process, and in the server those signals
 * belong to the shutdown handler. Each run therefore gets its own EventEmitter,
 * which no signal ever reaches.
 */
export function createProductionDailyPipeline(): DailyPipelineSteps {
  return {
    ingest: async (): Promise<number> => {
      const { runCli } = await import('../../cli/ingestion.cli.js');
      const result = await runCli({
        execute: true,
        // The server owns the process: a scheduled run reports its code instead of
        // ending the process the schedule lives in.
        exit: (): void => undefined,
        terminate: (): void => undefined,
        host: new EventEmitter() as unknown as SignalHost,
      });
      return result.exitCode;
    },
    extract: async (): Promise<number> => {
      const { runExtractionCli } = await import('../../cli/extraction.cli.js');
      return runExtractionCli({
        execute: true,
        limit: DEFAULT_EXTRACT_LIMIT,
        signalHost: new EventEmitter() as unknown as SignalHost,
        exit: (): void => undefined,
      });
    },
    notify: async (): Promise<number> => {
      const { env } = await import('../../config/env.js');
      const { runNotificationCli } = await import('../../cli/notification.cli.js');
      return runNotificationCli({
        botToken: env.TELEGRAM_BOT_TOKEN,
        chatId: env.TELEGRAM_CHAT_ID,
      });
    },
  };
}
