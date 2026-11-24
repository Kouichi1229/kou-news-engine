export const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
export const DEFAULT_TIMEOUT_MS = 10_000;
export const MAX_RETRIES = 2;
export const BASE_BACKOFF_MS = 500;
export const MAX_RETRY_AFTER_MS = 30_000;
export const USER_AGENT = 'KouNewsEngine/0.0.0 (+https://github.com/kou-ai/kou-news-engine)';

export class FeedFetchError extends Error {
  readonly code: string;
  readonly status: number | undefined;
  /** Delay requested by the server via `Retry-After`, already capped. */
  retryAfterMs: number | undefined;

  constructor(code: string, message: string, status?: number) {
    super(message);
    this.name = 'FeedFetchError';
    this.code = code;
    this.status = status;
    this.retryAfterMs = undefined;
  }
}

export interface FetchResponseLike {
  status: number;
  headers: { get(name: string): string | null };
  body: ReadableStream<Uint8Array> | null;
}

export type FetchLike = (url: string, init: RequestInit) => Promise<FetchResponseLike>;

export interface FeedClientOptions {
  fetchImpl?: FetchLike;
  /** Injected for deterministic tests; defaults to a real timer. */
  sleepImpl?: (ms: number) => Promise<void>;
  /** Injected for deterministic tests; defaults to `Math.random`. */
  randomImpl?: () => number;
  timeoutMs?: number;
  maxRetries?: number;
  maxBytes?: number;
}

export interface FeedResponse {
  /** Decoded response body. */
  body: string;
  status: number;
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

function isRetryableStatus(status: number): boolean {
  return status === 429 || (status >= 500 && status <= 599);
}

/** Parses `Retry-After` (delta-seconds or HTTP-date), capped at `MAX_RETRY_AFTER_MS`. */
export function parseRetryAfter(
  value: string | null,
  now: number = Date.now(),
): number | undefined {
  if (value === null || value.trim() === '') {
    return undefined;
  }

  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.min(seconds * 1000, MAX_RETRY_AFTER_MS);
  }

  const timestamp = Date.parse(value);
  if (Number.isNaN(timestamp)) {
    return undefined;
  }

  return Math.min(Math.max(0, timestamp - now), MAX_RETRY_AFTER_MS);
}

/** Exponential backoff with jitter, bounded by `MAX_RETRY_AFTER_MS`. */
export function backoffDelay(attempt: number, random: () => number): number {
  const exponential = BASE_BACKOFF_MS * 2 ** attempt;
  return Math.min(Math.round(exponential * (1 + random() * 0.5)), MAX_RETRY_AFTER_MS);
}

async function readBodyWithLimit(
  body: ReadableStream<Uint8Array> | null,
  maxBytes: number,
): Promise<string> {
  if (body === null) {
    return '';
  }

  const reader = body.getReader();
  const decoder = new TextDecoder('utf-8');
  const chunks: string[] = [];
  let total = 0;

  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    if (value === undefined) {
      continue;
    }

    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new FeedFetchError(
        'RESPONSE_TOO_LARGE',
        `Response exceeded the ${maxBytes} byte limit`,
      );
    }

    chunks.push(decoder.decode(value, { stream: true }));
  }

  chunks.push(decoder.decode());
  return chunks.join('');
}

/**
 * Fetches a feed document.
 *
 * Redirects are never followed: a `3xx` is treated as a permanent failure so a
 * source cannot silently send the client to an unapproved host. Only network
 * errors, timeouts, `429` and `5xx` are retried.
 */
export async function fetchFeed(
  url: string,
  options: FeedClientOptions = {},
): Promise<FeedResponse> {
  const fetchImpl = options.fetchImpl ?? (globalThis.fetch as unknown as FetchLike);
  const sleep = options.sleepImpl ?? defaultSleep;
  const random = options.randomImpl ?? Math.random;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxRetries = options.maxRetries ?? MAX_RETRIES;
  const maxBytes = options.maxBytes ?? MAX_RESPONSE_BYTES;

  let lastError: FeedFetchError | undefined;

  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    if (attempt > 0) {
      const delay =
        lastError?.code === 'HTTP_ERROR' && lastError.retryAfterMs !== undefined
          ? lastError.retryAfterMs
          : backoffDelay(attempt - 1, random);
      await sleep(delay);
    }

    try {
      const response = await fetchImpl(url, {
        method: 'GET',
        redirect: 'manual',
        headers: {
          'User-Agent': USER_AGENT,
          Accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml;q=0.9',
        },
        signal: AbortSignal.timeout(timeoutMs),
      });

      if (response.status >= 300 && response.status <= 399) {
        throw new FeedFetchError(
          'REDIRECT_NOT_ALLOWED',
          `Refusing to follow redirect (status ${response.status})`,
          response.status,
        );
      }

      if (response.status >= 200 && response.status <= 299) {
        const contentLength = response.headers.get('content-length');
        if (contentLength !== null) {
          const declared = Number(contentLength);
          if (Number.isFinite(declared) && declared > maxBytes) {
            throw new FeedFetchError(
              'RESPONSE_TOO_LARGE',
              `Declared content length ${declared} exceeds the ${maxBytes} byte limit`,
            );
          }
        }

        const body = await readBodyWithLimit(response.body, maxBytes);
        return { body, status: response.status };
      }

      if (isRetryableStatus(response.status)) {
        const retryAfterMs = parseRetryAfter(response.headers.get('retry-after'));
        const error = new FeedFetchError(
          'HTTP_ERROR',
          `Feed request failed with status ${response.status}`,
          response.status,
        );
        if (retryAfterMs !== undefined) {
          error.retryAfterMs = retryAfterMs;
        }
        lastError = error;
        continue;
      }

      throw new FeedFetchError(
        'HTTP_ERROR',
        `Feed request failed with status ${response.status}`,
        response.status,
      );
    } catch (error) {
      if (error instanceof FeedFetchError) {
        // Size and redirect failures are permanent; retrying cannot help.
        if (error.code === 'RESPONSE_TOO_LARGE' || error.code === 'REDIRECT_NOT_ALLOWED') {
          throw error;
        }
        lastError = error;
        if (!isRetryableStatus(error.status ?? 0)) {
          throw error;
        }
        continue;
      }

      const isTimeout =
        error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError');

      lastError = new FeedFetchError(
        isTimeout ? 'TIMEOUT' : 'NETWORK_ERROR',
        isTimeout
          ? `Request timed out after ${timeoutMs}ms`
          : `Network error: ${error instanceof Error ? error.message : 'unknown'}`,
      );
      continue;
    }
  }

  throw (
    lastError ?? new FeedFetchError('NETWORK_ERROR', 'Feed request failed without a recorded error')
  );
}
