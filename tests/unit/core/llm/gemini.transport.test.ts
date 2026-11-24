import { EventEmitter } from 'node:events';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { LlmError, LlmTimeoutError } from '../../../../src/core/llm/llm.errors.js';
import {
  GEMINI_ORIGIN,
  MAX_ERROR_BODY_BYTES,
  MAX_SUCCESS_BODY_BYTES,
  createGeminiTransport,
} from '../../../../src/core/llm/providers/gemini.transport.js';

/**
 * The socket is faked, the transport is not.
 *
 * Only `https.request` is replaced, so the production code path — origin
 * assertion, header construction, bounded read, abort classification — runs
 * unchanged. No real Gemini API call is made and no credential is read.
 */

interface FakeResponseSpec {
  status?: number;
  headers?: Record<string, string>;
  body?: Buffer[];
  hang?: boolean;
}

interface RecordedRequest {
  hostname: string | undefined;
  port: number | undefined;
  path: string | undefined;
  method: string | undefined;
  headers: Record<string, string> | undefined;
  body: string | undefined;
}

const queue: FakeResponseSpec[] = [];
const recorded: RecordedRequest[] = [];
let destroyedCount = 0;
/** Bytes actually delivered to the reader before it destroyed the response. */
let deliveredBytes = 0;

function enqueueResponse(spec: FakeResponseSpec): void {
  queue.push(spec);
}

function resetFake(): void {
  queue.length = 0;
  recorded.length = 0;
  destroyedCount = 0;
  deliveredBytes = 0;
}

class FakeResponse extends EventEmitter {
  readonly statusCode: number;
  readonly headers: Record<string, string>;
  private readonly chunks: Buffer[];
  private destroyed = false;

  constructor(spec: FakeResponseSpec) {
    super();
    this.statusCode = spec.status ?? 200;
    this.headers = spec.headers ?? {};
    this.chunks = spec.body ?? [];
  }

  resume(): void {
    /* nothing to drain */
  }

  destroy(): void {
    this.destroyed = true;
    destroyedCount += 1;
  }

  start(): void {
    // Emit one chunk per turn, stopping as soon as the reader destroys the
    // stream — this is what makes "stopped early" observable.
    const pump = (index: number): void => {
      setImmediate(() => {
        if (this.destroyed || index >= this.chunks.length) {
          if (!this.destroyed) this.emit('end');
          return;
        }
        const chunk = this.chunks[index];
        if (chunk !== undefined) {
          deliveredBytes += chunk.byteLength;
          this.emit('data', chunk);
        }
        pump(index + 1);
      });
    };
    pump(0);
  }
}

function fakeRequest(
  options: {
    hostname?: string;
    port?: number;
    path?: string;
    method?: string;
    headers?: Record<string, string>;
    signal?: AbortSignal;
  },
  callback: (response: FakeResponse) => void,
): EventEmitter {
  const record: RecordedRequest = {
    hostname: options.hostname,
    port: options.port,
    path: options.path,
    method: options.method,
    headers: options.headers,
    body: undefined,
  };
  recorded.push(record);

  const req = new EventEmitter() as EventEmitter & {
    end: (body?: string) => void;
    destroy: (error?: Error) => void;
    setTimeout: (ms: number, cb: () => void) => void;
  };

  req.end = (body?: string) => {
    record.body = body;
    const spec = queue.shift();
    if (spec === undefined) {
      queueMicrotask(() => req.emit('error', new Error('no fake response enqueued')));
      return;
    }
    if (spec.hang === true) return;
    const response = new FakeResponse(spec);
    queueMicrotask(() => {
      callback(response);
      response.start();
    });
  };

  req.destroy = (error?: Error) => {
    if (error !== undefined) {
      queueMicrotask(() => req.emit('error', error));
    }
  };

  req.setTimeout = () => {
    /* the transport uses AbortSignal, not request.setTimeout */
  };

  if (options.signal !== undefined) {
    const signal = options.signal;
    const onAbort = (): void => {
      const error = new Error('The operation was aborted');
      error.name = 'AbortError';
      req.emit('error', error);
    };
    if (signal.aborted) {
      queueMicrotask(onAbort);
    } else {
      signal.addEventListener('abort', onAbort, { once: true });
    }
  }

  return req;
}

vi.mock('node:https', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:https')>();
  return { ...actual, request: fakeRequest };
});

const API_KEY = 'test-key-not-real';
const URL_UNDER_TEST = `${GEMINI_ORIGIN}/v1/interactions`;

function newTransport(timeoutMs?: number) {
  return createGeminiTransport(
    timeoutMs === undefined ? { apiKey: API_KEY } : { apiKey: API_KEY, timeoutMs },
  );
}

function send(transport = newTransport(), signal = new AbortController().signal) {
  return transport.send(URL_UNDER_TEST, {
    body: '{"store":false}',
    headers: { 'content-type': 'application/json' },
    signal,
  });
}

/** A body of exactly `bytes` bytes, split into `chunkSize` pieces. */
function bodyOf(bytes: number, chunkSize = 16 * 1024): Buffer[] {
  const chunks: Buffer[] = [];
  let remaining = bytes;
  while (remaining > 0) {
    const size = Math.min(chunkSize, remaining);
    chunks.push(Buffer.alloc(size, 0x61));
    remaining -= size;
  }
  return chunks;
}

beforeEach(() => {
  resetFake();
});

describe('Gemini transport — request construction', () => {
  it('sends a single POST to the fixed interactions path with the key header', async () => {
    enqueueResponse({ status: 200, body: [Buffer.from('{"ok":true}')] });

    const result = await send();

    expect(result).toEqual({ status: 200, body: '{"ok":true}' });
    expect(recorded).toHaveLength(1);
    const [request] = recorded;
    expect(request?.method).toBe('POST');
    expect(request?.hostname).toBe('generativelanguage.googleapis.com');
    expect(request?.path).toBe('/v1/interactions');
    expect(request?.headers?.['x-goog-api-key']).toBe(API_KEY);
    expect(request?.body).toBe('{"store":false}');
  });

  it('refuses a non-Gemini origin before opening a socket', async () => {
    const transport = newTransport();

    await expect(
      transport.send('https://evil.example.com/v1/interactions', {
        body: '{}',
        headers: {},
        signal: new AbortController().signal,
      }),
    ).rejects.toBeInstanceOf(LlmError);

    // No request was ever constructed.
    expect(recorded).toHaveLength(0);
  });

  it('is inert at import: constructing opens no socket', () => {
    newTransport();
    expect(recorded).toHaveLength(0);
  });
});

describe('Gemini transport — T-19 response body ceilings', () => {
  it('assertion 1: accepts a success body of exactly 1 MiB', async () => {
    enqueueResponse({ status: 200, body: bodyOf(MAX_SUCCESS_BODY_BYTES) });

    const result = await send();

    expect(result.status).toBe(200);
    expect(Buffer.byteLength(result.body, 'utf8')).toBe(MAX_SUCCESS_BODY_BYTES);
  });

  it('assertion 2: rejects a success body of 1 MiB + 1 byte as invalid_response', async () => {
    enqueueResponse({ status: 200, body: bodyOf(MAX_SUCCESS_BODY_BYTES + 1) });

    await expect(send()).rejects.toMatchObject({ kind: 'invalid_response' });
  });

  it('assertion 3: accepts exactly 64 KiB for an error body, rejects 64 KiB + 1', async () => {
    enqueueResponse({ status: 400, body: bodyOf(MAX_ERROR_BODY_BYTES) });
    const accepted = await send();
    expect(accepted.status).toBe(400);
    expect(Buffer.byteLength(accepted.body, 'utf8')).toBe(MAX_ERROR_BODY_BYTES);

    resetFake();
    enqueueResponse({ status: 400, body: bodyOf(MAX_ERROR_BODY_BYTES + 1) });
    await expect(send()).rejects.toMatchObject({ kind: 'invalid_response' });
  });

  it('assertion 4: destroys the response stream when the ceiling is exceeded', async () => {
    enqueueResponse({ status: 200, body: bodyOf(MAX_SUCCESS_BODY_BYTES + 1024) });

    await expect(send()).rejects.toMatchObject({ kind: 'invalid_response' });

    expect(destroyedCount).toBeGreaterThan(0);
  });

  it('assertion 5: stops reading early and retains at most the ceiling', async () => {
    // 64 chunks of 64 KiB = 4 MiB, four times the ceiling. A reader that
    // buffered the whole body would receive all 4 MiB before rejecting.
    enqueueResponse({
      status: 200,
      body: bodyOf(MAX_SUCCESS_BODY_BYTES * 4, 64 * 1024),
    });

    await expect(send()).rejects.toMatchObject({ kind: 'invalid_response' });

    // Stopped as soon as the total crossed the ceiling: the reader never saw
    // the whole body, so held bytes stay bounded rather than growing to 4 MiB.
    expect(deliveredBytes).toBeLessThan(MAX_SUCCESS_BODY_BYTES * 4);
    // At most one chunk beyond the ceiling could have been delivered.
    expect(deliveredBytes).toBeLessThanOrEqual(MAX_SUCCESS_BODY_BYTES + 64 * 1024);
    expect(destroyedCount).toBeGreaterThan(0);
  });

  it('assertion 6: never parses a body truncated at the ceiling', async () => {
    // Valid JSON prefix, then garbage past the limit. A truncating reader would
    // try to parse the prefix and might succeed; the transport must reject.
    const valid = Buffer.from('{"a":"');
    const filler = Buffer.alloc(MAX_SUCCESS_BODY_BYTES, 0x62);
    enqueueResponse({ status: 200, body: [valid, filler, Buffer.from('"}')] });

    await expect(send()).rejects.toMatchObject({ kind: 'invalid_response' });
  });

  it('assertion 7: an under-declared Content-Length cannot bypass the ceiling', async () => {
    enqueueResponse({
      status: 200,
      headers: { 'content-length': '10' },
      body: bodyOf(MAX_SUCCESS_BODY_BYTES + 1),
    });

    await expect(send()).rejects.toMatchObject({ kind: 'invalid_response' });
  });

  it('assertion 8: counts many small chunks cumulatively without resetting', async () => {
    // 2048 chunks of 512 B exceed 1 MiB only if the total accumulates.
    enqueueResponse({ status: 200, body: bodyOf(MAX_SUCCESS_BODY_BYTES + 512, 512) });

    await expect(send()).rejects.toMatchObject({ kind: 'invalid_response' });

    resetFake();
    // The same chunk count staying under the ceiling must succeed, proving the
    // counter is not simply rejecting on chunk count.
    enqueueResponse({ status: 200, body: bodyOf(MAX_SUCCESS_BODY_BYTES, 512) });
    const result = await send();
    expect(Buffer.byteLength(result.body, 'utf8')).toBe(MAX_SUCCESS_BODY_BYTES);
  });
});

describe('Gemini transport — redirects and failures', () => {
  it('rejects a redirect instead of following it', async () => {
    enqueueResponse({ status: 302, headers: { location: 'https://evil.example.com/' }, body: [] });

    await expect(send()).rejects.toMatchObject({ kind: 'invalid_response' });
    expect(recorded).toHaveLength(1);
  });

  it('maps a local deadline to LlmTimeoutError', async () => {
    enqueueResponse({ status: 200, hang: true });

    await expect(send(newTransport(5))).rejects.toBeInstanceOf(LlmTimeoutError);
  });

  it('maps a caller abort to a timeout-kind LlmError', async () => {
    enqueueResponse({ status: 200, hang: true });
    const controller = new AbortController();
    const promise = send(newTransport(), controller.signal);
    controller.abort();

    await expect(promise).rejects.toMatchObject({ kind: 'timeout' });
  });

  it('returns a non-2xx status and body without raising, so no error surface can leak', async () => {
    enqueueResponse({
      status: 401,
      body: [Buffer.from(`{"error":{"code":"authentication","message":"bad key ${API_KEY}"}}`)],
    });

    // The transport's job is to report status + body; classification and body
    // redaction belong to the adapter (T-18, Section 11.1.7). Resolving rather
    // than throwing is what keeps the vendor body off an error object entirely.
    const result = await send();
    expect(result.status).toBe(401);
  });

  it('never puts the key in a transport-generated error', async () => {
    const errors: unknown[] = [];

    // No response enqueued: the request fails and the transport rejects.
    await send().catch((error: unknown) => errors.push(error));

    const transport = newTransport();
    await transport
      .send('https://evil.example.com/v1/interactions', {
        body: '{}',
        headers: {},
        signal: new AbortController().signal,
      })
      .catch((error: unknown) => errors.push(error));

    expect(errors).toHaveLength(2);
    for (const error of errors) {
      expect(error).toBeInstanceOf(LlmError);
      expect(String(error)).not.toContain(API_KEY);
      expect(JSON.stringify(error)).not.toContain(API_KEY);
      expect((error as Error).message).not.toContain(API_KEY);
    }
  });
});
