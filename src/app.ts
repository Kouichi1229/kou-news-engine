import express, { type Express } from 'express';

import { errorHandler } from './core/http/error-handler.js';
import { notFoundHandler } from './core/http/not-found.js';
import { createRequestTrackingMiddleware } from './core/http/request-tracking.js';
import type { LifecycleState } from './core/lifecycle/lifecycle-state.js';
import type { RequestTracker } from './core/lifecycle/request-tracker.js';
import type { ReadinessProbe } from './modules/health/readiness.js';
import { createApiRouter } from './routes/index.js';

export interface AppOptions {
  /**
   * Readiness dependencies exposed by `/api/ready`.
   *
   * Omitted by tests and by any build with no external dependencies, in which
   * case readiness reports `ready` with an empty `checks` object. A composition
   * root that owns a database must pass a probe here, otherwise readiness cannot
   * observe that database.
   */
  readinessProbes?: readonly ReadinessProbe[];

  /**
   * In-flight request tracking. When omitted, requests are not tracked.
   *
   * Supplied by `createRuntime()` so the app and the shutdown orchestration share
   * one tracker: the middleware increments it and shutdown waits on it. The
   * lifecycle state travels with it because the middleware reads it to record
   * requests that arrive while draining.
   *
   * The two are one object rather than two optional fields so the app cannot be
   * built in a half-configured state — a tracker with no lifecycle would have
   * nothing to read, and a lifecycle with no tracker would track nothing.
   */
  requestTracking?: {
    tracker: RequestTracker;
    lifecycle: LifecycleState;
  };
}

/**
 * Builds the Express app.
 *
 * Opens no resources: no database, no sockets, no filesystem access. Everything
 * that needs a lifetime longer than one request is injected by the caller, so
 * `createApp()` stays safe to call in tests and cheap to call repeatedly.
 */
export function createApp(options: AppOptions = {}): Express {
  const app = express();

  app.disable('x-powered-by');

  // Mounted before `express.json()` so a request rejected during body parsing is
  // still counted and released.
  if (options.requestTracking !== undefined) {
    app.use(
      createRequestTrackingMiddleware({
        tracker: options.requestTracking.tracker,
        lifecycle: options.requestTracking.lifecycle,
      }),
    );
  }

  app.use(express.json());

  app.use('/api', createApiRouter({ readinessProbes: options.readinessProbes ?? [] }));

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
