import { describe, expect, it } from 'vitest';

import { APP_NAME, APP_VERSION } from '../../../../src/config/constants.js';
import { getHealth, getReady } from '../../../../src/modules/health/health.service.js';

describe('getHealth', () => {
  it('reports the service identity and ok status', () => {
    const health = getHealth();

    expect(health.status).toBe('ok');
    expect(health.service).toBe(APP_NAME);
    expect(health.version).toBe(APP_VERSION);
  });

  it('reports a non-negative uptime in whole seconds', () => {
    const health = getHealth();

    expect(Number.isInteger(health.uptimeSeconds)).toBe(true);
    expect(health.uptimeSeconds).toBeGreaterThanOrEqual(0);
  });

  it('reports an ISO-8601 timestamp', () => {
    const health = getHealth();

    expect(new Date(health.timestamp).toISOString()).toBe(health.timestamp);
  });
});

describe('getReady', () => {
  it('reports ready with no dependency checks', () => {
    const ready = getReady();

    expect(ready.status).toBe('ready');
    expect(ready.checks).toEqual({});
  });

  it('reports an ISO-8601 timestamp', () => {
    const ready = getReady();

    expect(new Date(ready.timestamp).toISOString()).toBe(ready.timestamp);
  });
});
