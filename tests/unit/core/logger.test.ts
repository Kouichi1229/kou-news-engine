import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { logger, setLogLevel } from '../../../src/core/logger.js';

function captureStdout() {
  const chunks: string[] = [];
  const spy = vi
    .spyOn(process.stdout, 'write')
    .mockImplementation((chunk: string | Uint8Array): boolean => {
      chunks.push(String(chunk));
      return true;
    });
  return { chunks, spy };
}

function captureStderr() {
  const chunks: string[] = [];
  const spy = vi
    .spyOn(process.stderr, 'write')
    .mockImplementation((chunk: string | Uint8Array): boolean => {
      chunks.push(String(chunk));
      return true;
    });
  return { chunks, spy };
}

describe('logger', () => {
  let stdout: ReturnType<typeof captureStdout>;
  let stderr: ReturnType<typeof captureStderr>;

  beforeEach(() => {
    stdout = captureStdout();
    stderr = captureStderr();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    setLogLevel('info');
  });

  it('writes info entries to stdout as JSON', () => {
    setLogLevel('info');
    logger.info('hello', { a: 1 });

    expect(stderr.chunks).toHaveLength(0);
    expect(stdout.chunks).toHaveLength(1);

    const entry = JSON.parse(stdout.chunks[0] ?? '');
    expect(entry).toMatchObject({ level: 'info', message: 'hello', meta: { a: 1 } });
    expect(typeof entry.time).toBe('string');
  });

  it('routes warn and error entries to stderr', () => {
    setLogLevel('debug');
    logger.warn('careful');
    logger.error('boom');

    expect(stdout.chunks).toHaveLength(0);
    expect(stderr.chunks).toHaveLength(2);
    expect(JSON.parse(stderr.chunks[0] ?? '').level).toBe('warn');
    expect(JSON.parse(stderr.chunks[1] ?? '').level).toBe('error');
  });

  it('omits the meta field when no metadata is supplied', () => {
    setLogLevel('info');
    logger.info('plain');

    const entry = JSON.parse(stdout.chunks[0] ?? '');
    expect(entry).not.toHaveProperty('meta');
  });

  it('suppresses entries below the configured level', () => {
    setLogLevel('warn');
    logger.debug('hidden');
    logger.info('hidden');

    expect(stdout.chunks).toHaveLength(0);
    expect(stderr.chunks).toHaveLength(0);
  });

  it('emits entries at or above the configured level', () => {
    setLogLevel('warn');
    logger.warn('shown');
    logger.error('shown');

    expect(stderr.chunks).toHaveLength(2);
  });
});
