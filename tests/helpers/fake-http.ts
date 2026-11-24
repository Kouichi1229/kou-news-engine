import { EventEmitter } from 'node:events';

/**
 * A fake `http.request` used to exercise `safeFetch`'s success path.
 *
 * The real SSRF guard cannot be satisfied by a test server: it denies every
 * address a test can bind to, and its port allowlist admits only 80/443. Rather
 * than add a policy-relaxing switch to production code, these tests let the
 * guard run untouched against a public address and an allowed port, then serve a
 * canned response instead of opening a socket. Nothing in `src/` learns that it
 * is being tested.
 *
 * The guard itself is covered separately, against the real code, in the
 * private-address and port tests.
 */

export interface FakeResponseSpec {
  /** Defaults to 200. */
  status?: number;
  /** Lower-case header names, as Node delivers them. */
  headers?: Record<string, string>;
  /** Body chunks in order. */
  body?: Buffer[];
  /** Never answer, so the request's own timeout fires. */
  hang?: boolean;
}

export interface RecordedRequest {
  host: string | undefined;
  port: number | undefined;
  path: string | undefined;
  headers: Record<string, string> | undefined;
  /** The pinned lookup handed to the transport, if any. */
  lookup: unknown;
  /** TLS options, present only on an https request. */
  servername?: string;
  rejectUnauthorized?: boolean;
}

const queue: FakeResponseSpec[] = [];
const recorded: RecordedRequest[] = [];

export function enqueueResponse(spec: FakeResponseSpec): void {
  queue.push(spec);
}

export function recordedRequests(): readonly RecordedRequest[] {
  return recorded;
}

export function resetFakeHttp(): void {
  queue.length = 0;
  recorded.length = 0;
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
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<Buffer> {
    for (const chunk of this.chunks) {
      if (this.destroyed) {
        return;
      }
      yield chunk;
    }
  }
}

interface RequestOptionsLike {
  host?: string;
  port?: number;
  path?: string;
  headers?: Record<string, string>;
  lookup?: unknown;
  servername?: string;
  rejectUnauthorized?: boolean;
}

export function fakeRequest(
  options: RequestOptionsLike,
  callback: (response: FakeResponse) => void,
): EventEmitter {
  recorded.push({
    host: options.host,
    port: options.port,
    path: options.path,
    headers: options.headers,
    lookup: options.lookup,
    ...(options.servername === undefined ? {} : { servername: options.servername }),
    ...(options.rejectUnauthorized === undefined
      ? {}
      : { rejectUnauthorized: options.rejectUnauthorized }),
  });

  const spec = queue.shift();
  const req = new EventEmitter();
  let onTimeout: (() => void) | undefined;

  const request = Object.assign(req, {
    setTimeout: (_ms: number, cb: () => void) => {
      onTimeout = cb;
      return request;
    },
    destroy: (error?: Error) => {
      if (error !== undefined) {
        queueMicrotask(() => {
          req.emit('error', error);
        });
      }
    },
    end: () => {
      if (spec === undefined) {
        queueMicrotask(() => {
          req.emit('error', new Error('no fake response enqueued'));
        });
        return;
      }
      if (spec.hang === true) {
        setTimeout(() => {
          onTimeout?.();
        }, 1);
        return;
      }
      queueMicrotask(() => {
        callback(new FakeResponse(spec));
      });
    },
  });

  return request;
}
