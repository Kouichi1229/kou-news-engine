import { env } from './config/env.js';
import { createShutdownHandler } from './core/lifecycle/shutdown.js';
import { logger, setLogLevel } from './core/logger.js';
import { createRuntime, disposeRuntimeAfterFailure, type Runtime } from './runtime.js';
import {
  createProductionDailyPipeline,
  runDailyPipeline,
  startDailyScheduler,
} from './modules/scheduler/daily.scheduler.js';
import { startServer } from './server.js';

async function main(): Promise<void> {
  setLogLevel(env.LOG_LEVEL);

  const runtime: Runtime = createRuntime();

  // Nothing is listening when startup fails, so no request can be in flight:
  // disposal runs here so the database is released. A disposal failure is
  // aggregated behind the startup error instead of masking it.
  const running = await startServer(runtime.app, env.PORT, env.HOST).catch(
    async (error: unknown): Promise<never> => disposeRuntimeAfterFailure(runtime, error),
  );

  // Registered only after a successful listen: a startup failure leaves no timer
  // behind, and the pipeline never runs while the server is not up.
  const scheduler = await startDailyScheduler({
    expression: env.SCHEDULE_CRON,
    timezone: env.APP_TIMEZONE,
    run: () => runDailyPipeline({ steps: createProductionDailyPipeline(), log: logger }),
    log: logger,
  });

  const shutdown = createShutdownHandler({
    // Wrapped rather than passed by reference: the handler may be invoked from a
    // signal listener, so binding here keeps the method's receiver intact
    // regardless of how it is eventually called.
    beginDraining: () => {
      // Stops future fires first: a run starting while the server drains would
      // compete with shutdown for the database.
      scheduler.stop();
      runtime.lifecycle.beginDraining();
    },
    closeServer: running.close,
    closeIdleConnections: running.closeIdleConnections,
    closeAllConnections: running.closeAllConnections,
    awaitRequestsDrained: () => runtime.requests.whenIdle(),
    disposeRuntime: runtime.dispose,
    exit: (code) => process.exit(code),
    timeoutMs: env.SHUTDOWN_TIMEOUT_MS,
  });

  // Registered only after a successful listen, so a startup failure leaves no
  // handler behind.
  process.on('SIGTERM', (signal) => void shutdown(signal));
  process.on('SIGINT', (signal) => void shutdown(signal));
}

main().catch((err: unknown) => {
  logger.error('Failed to start server', { error: String(err) });
  process.exit(1);
});
