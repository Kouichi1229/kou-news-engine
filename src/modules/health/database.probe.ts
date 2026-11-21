import type { ReadinessProbe, ReadinessProbeResult } from './readiness.js';

/** Key this probe's result is published under in the response `checks` object. */
export const DATABASE_PROBE_NAME = 'database';

/** Stable reason code published when the database answers but is not usable. */
export const DATABASE_UNAVAILABLE_DETAIL = 'database_unavailable';

/**
 * Reports whether the database can serve a query right now.
 *
 * Returns `false` for a condition the check can classify (a closed handle, a
 * handle whose query did not return the expected row). Throwing is reserved for
 * an unexpected failure; `getReady` turns that into the `probe_failed` code.
 */
export type DatabaseHealthCheck = () => boolean;

/**
 * Readiness entry for the database.
 *
 * The check is injected rather than imported, for the reason `readiness.ts`
 * states: the health module never imports the persistence layer and never opens
 * a connection of its own. The composition root owns the handle and passes one
 * query through it, so probing cannot create a second connection that leaks or
 * reports on a database the application is not actually using.
 *
 * `check()` runs on every request rather than snapshotting the result, so a
 * handle closed by disposal, or a database that becomes unusable later, is
 * reflected immediately instead of being cached as healthy.
 *
 * Neither the check's return value nor a thrown error is serialised: the
 * response carries only `ready` and this module's fixed reason code, because the
 * endpoint is unauthenticated.
 */
export function createDatabaseProbe(check: DatabaseHealthCheck): ReadinessProbe {
  return {
    name: DATABASE_PROBE_NAME,
    check: (): ReadinessProbeResult =>
      check() ? { ready: true } : { ready: false, detail: DATABASE_UNAVAILABLE_DETAIL },
  };
}
