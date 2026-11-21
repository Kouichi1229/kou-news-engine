import { describe, expect, it, vi } from 'vitest';

import {
  createDatabaseProbe,
  DATABASE_PROBE_NAME,
  DATABASE_UNAVAILABLE_DETAIL,
} from '../../../../src/modules/health/database.probe.js';

describe('createDatabaseProbe', () => {
  it('D1: reports ready without a detail when the check succeeds', () => {
    const probe = createDatabaseProbe(() => true);

    const result = probe.check();

    expect(result).toEqual({ ready: true });
    expect(result.detail).toBeUndefined();
  });

  it('D2: reports not ready with the exact unavailable detail when the check fails', () => {
    const probe = createDatabaseProbe(() => false);

    expect(probe.check()).toEqual({ ready: false, detail: 'database_unavailable' });
    expect(DATABASE_UNAVAILABLE_DETAIL).toBe('database_unavailable');
  });

  it('D3: publishes the exact probe name', () => {
    expect(createDatabaseProbe(() => true).name).toBe('database');
    expect(DATABASE_PROBE_NAME).toBe('database');
  });

  it('D4: propagates a throw rather than swallowing it', () => {
    // `getReady` is the layer that converts a throw into `probe_failed`; the
    // probe must not pre-empt it by returning a value of its own.
    const failure = new Error('database is gone');
    const probe = createDatabaseProbe(() => {
      throw failure;
    });

    expect(() => probe.check()).toThrow(failure);
  });

  it('D5: calls the check on every invocation rather than caching a result', () => {
    const check = vi.fn(() => true);
    const probe = createDatabaseProbe(check);

    probe.check();
    probe.check();
    probe.check();

    expect(check).toHaveBeenCalledTimes(3);
  });

  it('D6: reflects a later failure after an earlier success', () => {
    let healthy = true;
    const probe = createDatabaseProbe(() => healthy);

    expect(probe.check().ready).toBe(true);

    healthy = false;

    expect(probe.check()).toEqual({ ready: false, detail: 'database_unavailable' });
  });

  it('D7: publishes no fields beyond ready and detail', () => {
    const probe = createDatabaseProbe(() => false);

    expect(Object.keys(probe.check()).sort()).toEqual(['detail', 'ready']);
  });
});
