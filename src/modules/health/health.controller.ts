import type { Request, RequestHandler, Response } from 'express';

import type { ReadinessProbe } from './readiness.js';
import { getHealth, getReady } from './health.service.js';

export function healthController(_req: Request, res: Response): void {
  res.status(200).json(getHealth());
}

/**
 * Builds the readiness handler bound to a fixed probe list.
 *
 * The probes are captured in a closure rather than read from module state, so
 * two apps built in the same process keep independent readiness and neither can
 * observe the other's dependencies.
 */
export function createReadyController(probes: readonly ReadinessProbe[]): RequestHandler {
  return (_req: Request, res: Response): void => {
    const result = getReady(probes);
    const statusCode = result.status === 'ready' ? 200 : 503;
    res.status(statusCode).json(result);
  };
}
