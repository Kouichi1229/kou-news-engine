import { Router } from 'express';

import { createHealthRouter } from '../modules/health/health.routes.js';
import type { ReadinessProbe } from '../modules/health/readiness.js';

export interface ApiRouterOptions {
  /** Readiness dependencies exposed by `/api/ready`. Empty when none are wired. */
  readinessProbes?: readonly ReadinessProbe[];
}

/** Builds the `/api` router with the dependencies of one app instance. */
export function createApiRouter(options: ApiRouterOptions = {}): Router {
  const router: Router = Router();

  router.use(createHealthRouter(options.readinessProbes ?? []));

  return router;
}
