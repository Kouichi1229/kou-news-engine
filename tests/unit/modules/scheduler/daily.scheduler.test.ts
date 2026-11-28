import { describe, expect, it } from 'vitest';

import { DEFAULT_EXTRACT_LIMIT } from '../../../../src/config/constants.js';
import { loadEnv } from '../../../../src/config/env.js';
import {
  runDailyPipeline,
  startDailyScheduler,
  type CronSchedule,
  type DailyPipelineSteps,
} from '../../../../src/modules/scheduler/daily.scheduler.js';

/**
 * The daily schedule: step order, failure isolation, and the cron registration.
 *
 * The cron implementation and the clock are injected, so no test waits for a
 * trigger and none reads the real time.
 */
function recordingLog() {
  const lines: Array<{ level: 'info' | 'warn'; message: string }> = [];
  return {
    lines,
    log: {
      info: (message: string): void => {
        lines.push({ level: 'info', message });
      },
      warn: (message: string): void => {
        lines.push({ level: 'warn', message });
      },
    },
  };
}

function steps(
  order: string[],
  codes: Partial<Record<keyof DailyPipelineSteps, number>> = {},
): DailyPipelineSteps {
  const step = (name: keyof DailyPipelineSteps) => async (): Promise<number> => {
    order.push(name);
    return codes[name] ?? 0;
  };
  return { ingest: step('ingest'), extract: step('extract'), notify: step('notify') };
}

/** Captures the registration so a test can fire the handler itself. */
function fakeSchedule() {
  const calls: Array<{ expression: string; options: unknown }> = [];
  let fired: (() => void | Promise<void>) | undefined;
  let stops = 0;

  const schedule: CronSchedule = (expression, task, options) => {
    calls.push({ expression, options });
    fired = task;
    return {
      stop: (): void => {
        stops += 1;
      },
    };
  };

  return {
    calls,
    schedule,
    fire: async (): Promise<void> => {
      await fired?.();
    },
    stopCount: (): number => stops,
  };
}

describe('runDailyPipeline — order and logging', () => {
  it('runs ingest, then extract, then notify', async () => {
    const order: string[] = [];
    const { log } = recordingLog();

    const result = await runDailyPipeline({ steps: steps(order), log, now: () => 1_000 });

    expect(order).toEqual(['ingest', 'extract', 'notify']);
    expect(result).toEqual({ ingest: 0, extract: 0, notify: 0 });
  });

  it('logs a start line, one line per step, and a finish line', async () => {
    const order: string[] = [];
    const { lines, log } = recordingLog();

    await runDailyPipeline({ steps: steps(order), log, now: () => 1_000 });

    const messages = lines.map((line) => line.message);
    expect(messages[0]).toBe('Daily pipeline started');
    expect(messages).toContain('Daily pipeline: Ingestion finished');
    expect(messages).toContain('Daily pipeline: Extraction finished');
    expect(messages).toContain('Daily pipeline: Notification finished');
    expect(messages.at(-1)).toBe('Daily pipeline finished');
  });

  it('reports each step exit code', async () => {
    const { log } = recordingLog();

    const result = await runDailyPipeline({
      steps: steps([], { ingest: 0, extract: 3, notify: 1 }),
      log,
      now: () => 1_000,
    });

    expect(result).toEqual({ ingest: 0, extract: 3, notify: 1 });
  });
});

describe('runDailyPipeline — failure isolation', () => {
  it('keeps going when a step returns a non-zero code', async () => {
    const order: string[] = [];
    const { log } = recordingLog();

    await runDailyPipeline({ steps: steps(order, { ingest: 1 }), log, now: () => 1_000 });

    expect(order).toEqual(['ingest', 'extract', 'notify']);
  });

  it('keeps going when a step throws, and warns', async () => {
    const order: string[] = [];
    const { lines, log } = recordingLog();
    const base = steps(order);

    const result = await runDailyPipeline({
      steps: {
        ingest: async (): Promise<number> => {
          throw new Error('feed unreachable');
        },
        extract: base.extract,
        notify: base.notify,
      },
      log,
      now: () => 1_000,
    });

    expect(order).toEqual(['extract', 'notify']);
    expect(result.ingest).toBe(1);
    expect(lines.some((line) => line.level === 'warn')).toBe(true);
  });
});

describe('startDailyScheduler — registration', () => {
  it('registers 08:00 daily in the given timezone, without overlap', async () => {
    const cron = fakeSchedule();
    const { log } = recordingLog();

    const handle = await startDailyScheduler({
      timezone: 'Asia/Taipei',
      run: async (): Promise<void> => undefined,
      log,
      schedule: cron.schedule,
      validate: () => true,
    });

    expect(handle.expression).toBe('0 8 * * *');
    expect(handle.timezone).toBe('Asia/Taipei');
    expect(cron.calls).toEqual([
      { expression: '0 8 * * *', options: { timezone: 'Asia/Taipei', noOverlap: true } },
    ]);
  });

  it('honours a custom expression', async () => {
    const cron = fakeSchedule();
    const { log } = recordingLog();

    const handle = await startDailyScheduler({
      expression: '*/5 * * * *',
      timezone: 'Asia/Taipei',
      run: async (): Promise<void> => undefined,
      log,
      schedule: cron.schedule,
      validate: () => true,
    });

    expect(handle.expression).toBe('*/5 * * * *');
    expect(cron.calls[0]?.expression).toBe('*/5 * * * *');
  });

  it('runs the pipeline when the trigger fires', async () => {
    const cron = fakeSchedule();
    const { log } = recordingLog();
    const order: string[] = [];

    await startDailyScheduler({
      timezone: 'Asia/Taipei',
      run: async (): Promise<void> => {
        await runDailyPipeline({ steps: steps(order), log, now: () => 1_000 });
      },
      log,
      schedule: cron.schedule,
      validate: () => true,
    });

    await cron.fire();
    expect(order).toEqual(['ingest', 'extract', 'notify']);
  });

  it('logs a rejection instead of letting it escape the timer', async () => {
    const cron = fakeSchedule();
    const { lines, log } = recordingLog();

    await startDailyScheduler({
      timezone: 'Asia/Taipei',
      run: async (): Promise<void> => {
        throw new Error('quota exhausted');
      },
      log,
      schedule: cron.schedule,
      validate: () => true,
    });

    await expect(cron.fire()).resolves.toBeUndefined();
    expect(
      lines.some((line) => line.level === 'warn' && line.message === 'Daily pipeline run failed'),
    ).toBe(true);
  });

  it('refuses an expression the validator rejects, registering nothing', async () => {
    const cron = fakeSchedule();
    const { log } = recordingLog();

    await expect(
      startDailyScheduler({
        expression: 'every morning',
        timezone: 'Asia/Taipei',
        run: async (): Promise<void> => undefined,
        log,
        schedule: cron.schedule,
        validate: () => false,
      }),
    ).rejects.toThrow(/Invalid SCHEDULE_CRON/);

    expect(cron.calls).toHaveLength(0);
  });

  it('validates against the real cron parser', async () => {
    const cron = fakeSchedule();
    const { log } = recordingLog();

    await expect(
      startDailyScheduler({
        timezone: 'Asia/Taipei',
        run: async (): Promise<void> => undefined,
        log,
        schedule: cron.schedule,
      }),
    ).resolves.toBeDefined();

    await expect(
      startDailyScheduler({
        expression: 'nonsense',
        timezone: 'Asia/Taipei',
        run: async (): Promise<void> => undefined,
        log,
        schedule: cron.schedule,
      }),
    ).rejects.toThrow(/Invalid SCHEDULE_CRON/);
  });

  it('stops on request', async () => {
    const cron = fakeSchedule();
    const { log } = recordingLog();

    const handle = await startDailyScheduler({
      timezone: 'Asia/Taipei',
      run: async (): Promise<void> => undefined,
      log,
      schedule: cron.schedule,
      validate: () => true,
    });
    handle.stop();

    expect(cron.stopCount()).toBe(1);
  });
});

describe('SCHEDULE_CRON configuration', () => {
  it('defaults to 08:00 daily', () => {
    expect(loadEnv({}).SCHEDULE_CRON).toBe('0 8 * * *');
  });

  it('accepts an override for local testing', () => {
    expect(loadEnv({ SCHEDULE_CRON: '*/2 * * * *' }).SCHEDULE_CRON).toBe('*/2 * * * *');
  });

  it('keeps five articles per scheduled extraction pass', () => {
    expect(DEFAULT_EXTRACT_LIMIT).toBe(5);
  });
});
