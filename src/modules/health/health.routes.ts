import { Router } from 'express';

import { createReadyController, healthController } from './health.controller.js';
import type { ReadinessProbe } from './readiness.js';

/**
 * Builds a health router bound to the given probes.
 *
 * A factory rather than a module-level singleton: readiness has to receive the
 * dependencies of the app being built, and a shared router would force every app
 * in the process to share one probe list.
 */
export function createHealthRouter(probes: readonly ReadinessProbe[] = []): Router {
  const router: Router = Router();

  router.get('/health', healthController);
  router.get('/ready', createReadyController(probes));

  return router;
}
