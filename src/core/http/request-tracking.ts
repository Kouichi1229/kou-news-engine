import type { NextFunction, Request, RequestHandler, Response } from 'express';

import type { LifecycleState } from '../lifecycle/lifecycle-state.js';
import type { RequestTracker } from '../lifecycle/request-tracker.js';

/** The logging surface the middleware needs; `logger` satisfies it structurally. */
export interface RequestTrackingLogger {
  info: (message: string, meta?: unknown) => void;
  error: (message: string, meta?: unknown) => void;
}

export interface RequestTrackingOptions {
  tracker: RequestTracker;
  /** Read once per request to decide whether the request arrived while draining. */
  lifecycle: LifecycleState;
  /** Defaults to no logging. */
  logger?: RequestTrackingLogger;
}

/**
 * Tracks every request from arrival until its response is finished or its
 * connection is closed.
 *
 * Must be mounted **before** `express.json()`. Body parsing can reject a request
 * (malformed JSON) and that rejection is answered by the error handler, so a
 * tracker mounted after it would never see those requests.
 *
 * Both `finish` and `close` are observed because neither alone is sufficient:
 *
 * - `finish` fires when the response was fully written, but not when the client
 *   disconnected mid-response.
 * - `close` fires in both cases, but on a normal response it arrives after
 *   `finish`, so the release would otherwise run twice.
 *
 * The release function is idempotent, so attaching it to both events covers both
 * outcomes without double-counting.
 *
 * Tracking is best-effort. A tracker that throws is logged and the request
 * continues untracked: an observability failure must never break a request.
 */
export function createRequestTrackingMiddleware(options: RequestTrackingOptions): RequestHandler {
  const { tracker, lifecycle, logger } = options;

  return (req: Request, res: Response, next: NextFunction): void => {
    let release: (() => void) | undefined;

    try {
      const whileDraining = lifecycle.isDraining();
      release = tracker.begin({ draining: whileDraining });

      if (whileDraining) {
        log(logger, 'info', 'Request received while draining', {
          method: req.method,
          path: req.path,
          active: tracker.activeCount(),
        });
      }

      const done = (): void => {
        release?.();
      };

      res.once('finish', done);
      res.once('close', done);
    } catch (error) {
      // A registration that failed after `begin()` succeeded would never be
      // released, and an unreleasable request makes every later shutdown wait
      // out its deadline. Release now and treat the request as untracked.
      release?.();
      release = undefined;
      log(logger, 'error', 'Failed to track request', { error: String(error) });
    }

    next();
  };
}

function log(
  logger: RequestTrackingLogger | undefined,
  level: 'info' | 'error',
  message: string,
  meta: unknown,
): void {
  if (logger === undefined) {
    return;
  }

  try {
    logger[level](message, meta);
  } catch {
    // Logging must never be the reason a request fails.
  }
}
