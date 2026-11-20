import { APP_NAME, APP_VERSION } from '../../config/constants.js';
import type { HealthResponse, ReadyResponse } from '../../types/api.js';
import type { ReadinessProbe, ReadinessProbeResult } from './readiness.js';

export function getHealth(): HealthResponse {
  return {
    status: 'ok',
    service: APP_NAME,
    version: APP_VERSION,
    uptimeSeconds: Math.round(process.uptime()),
    timestamp: new Date().toISOString(),
  };
}

/**
 * Reason code published when a probe throws. The thrown value is deliberately
 * discarded: an exception message can carry SQL, paths, or credentials.
 */
const PROBE_FAILED_DETAIL = 'probe_failed';

/**
 * Copies only the fields the public response may carry.
 *
 * The probe's own object is never serialised: a probe that adds `error`, `path`
 * or `sql` alongside the declared fields would otherwise publish them on an
 * unauthenticated endpoint. Reading the two allowed keys explicitly keeps the
 * response shape fixed regardless of what a probe returns.
 */
function toPublicCheck(result: ReadinessProbeResult): ReadinessProbeResult {
  const check: ReadinessProbeResult = { ready: result.ready };
  if (result.detail !== undefined) {
    check.detail = result.detail;
  }
  return check;
}

/**
 * Builds the readiness response from the injected probes.
 *
 * With no probes the service reports `ready` and an empty `checks` object — the
 * documented behaviour for a build with no external dependencies wired yet.
 * That default is *not* a database health check: a composition root that owns a
 * database must inject a probe, or readiness cannot see it.
 *
 * Every probe runs on every call. A throwing probe marks the service
 * `not_ready` and contributes only a fixed reason code, so one broken dependency
 * neither leaks details nor masks the others.
 */
export function getReady(probes: readonly ReadinessProbe[] = []): ReadyResponse {
  const checks: Record<string, unknown> = {};
  let ready = true;

  for (const probe of probes) {
    try {
      const result = probe.check();
      checks[probe.name] = toPublicCheck(result);
      if (!result.ready) {
        ready = false;
      }
    } catch {
      checks[probe.name] = { ready: false, detail: PROBE_FAILED_DETAIL };
      ready = false;
    }
  }

  return {
    status: ready ? 'ready' : 'not_ready',
    checks,
    timestamp: new Date().toISOString(),
  };
}
