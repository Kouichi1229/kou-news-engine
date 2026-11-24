import { describe, expect, it, vi } from 'vitest';

import {
  backoffDelay,
  DEFAULT_TIMEOUT_MS,
  FeedFetchError,
  fetchFeed,
  MAX_RESPONSE_BYTES,
  MAX_RETRY_AFTER_MS,
  parseRetryAfter,
  USER_AGENT,
  type FetchLike,
  type FetchResponseLike,
} from '../../../../src/modules/ingestion/feed/feed.client.js';

function headers(map: Record<string, string> = {}): { get(name: string): string | null } {
  const lowered = new Map(Object.entries(map).map(([k, v]) => [k.toLowerCase(), v]));
  return { get: (name: string) => lowered.get(name.toLowerCase()) ?? null };
}

function bodyStream(chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(chunk);
      }
      controller.close();
    },
  });
}

function response(
  status: number,
  options: { body?: string; headerMap?: Record<string, string> } = {},
): FetchResponseLike {
  const encoder = new TextEncoder();
  return {
    status,
    headers: headers(options.headerMap),
    body: bodyStream([encoder.encode(options.body ?? '')]),
  };
}

/** Collects the sleeps requested by the client so retries stay deterministic. */
function harness(responses: Array<FetchResponseLike | Error>) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const sleeps: number[] = [];
  let index = 0;

  const fetchImpl: FetchLike = async (url, init) => {
    calls.push({ url, init });
    const next = responses[index];
    index += 1;
    if (next === undefined) {
      throw new Error('harness exhausted');
    }
    if (next instanceof Error) {
      throw next;
    }
    return next;
  };

  return {
    fetchImpl,
    calls,
    sleeps,
    sleepImpl: async (ms: number) => {
      sleeps.push(ms);
    },
    randomImpl: () => 0,
  };
}

function timeoutError(): Error {
  const error = new Error('The operation timed out');
  error.name = 'TimeoutError';
  return error;
}

describe('fetchFeed — success', () => {
  it('returns the decoded body for a 200 response', async () => {
    const h = harness([response(200, { body: '<rss/>' })]);
    const result = await fetchFeed('https://example.com/feed.xml', h);

    expect(result.body).toBe('<rss/>');
    expect(result.status).toBe(200);
    expect(h.calls).toHaveLength(1);
  });

  it('sends a descriptive User-Agent', async () => {
    const h = harness([response(200, { body: 'x' })]);
    await fetchFeed('https://example.com/feed.xml', h);

    const sent = h.calls[0]?.init.headers as Record<string, string>;

    expect(sent['User-Agent']).toBe(USER_AGENT);
    expect(USER_AGENT).toMatch(/KouNewsEngine/);
  });

  it('refuses to follow redirects', async () => {
    const h = harness([response(200, { body: 'x' })]);
    await fetchFeed('https://example.com/feed.xml', h);

    expect(h.calls[0]?.init.redirect).toBe('manual');
  });

  it('decodes multi-chunk bodies without corruption', async () => {
    const encoder = new TextEncoder();
    const fetchImpl: FetchLike = async () => ({
      status: 200,
      headers: headers(),
      body: bodyStream([encoder.encode('<rs'), encoder.encode('s/>')]),
    });

    const result = await fetchFeed('https://example.com/feed.xml', {
      fetchImpl,
      sleepImpl: async () => {},
    });

    expect(result.body).toBe('<rss/>');
  });
});

describe('fetchFeed — retries', () => {
  it('retries a network error then succeeds', async () => {
    const h = harness([new Error('ECONNRESET'), response(200, { body: 'ok' })]);
    const result = await fetchFeed('https://example.com/feed.xml', h);

    expect(result.body).toBe('ok');
    expect(h.calls).toHaveLength(2);
    expect(h.sleeps).toHaveLength(1);
  });

  it('retries a timeout then succeeds', async () => {
    const h = harness([timeoutError(), response(200, { body: 'ok' })]);
    const result = await fetchFeed('https://example.com/feed.xml', h);

    expect(result.body).toBe('ok');
    expect(h.calls).toHaveLength(2);
  });

  it('retries HTTP 429', async () => {
    const h = harness([response(429), response(200, { body: 'ok' })]);
    const result = await fetchFeed('https://example.com/feed.xml', h);

    expect(result.body).toBe('ok');
    expect(h.calls).toHaveLength(2);
  });

  it('retries HTTP 5xx', async () => {
    for (const status of [500, 502, 503, 504]) {
      const h = harness([response(status), response(200, { body: 'ok' })]);
      const result = await fetchFeed('https://example.com/feed.xml', h);

      expect(result.body, `status ${status}`).toBe('ok');
      expect(h.calls).toHaveLength(2);
    }
  });

  it('does not retry an ordinary 4xx', async () => {
    for (const status of [400, 401, 403, 404, 410]) {
      const h = harness([response(status), response(200, { body: 'should not be used' })]);

      await expect(
        fetchFeed('https://example.com/feed.xml', h),
        `status ${status}`,
      ).rejects.toThrow(FeedFetchError);
      expect(h.calls, `status ${status}`).toHaveLength(1);
      expect(h.sleeps, `status ${status}`).toHaveLength(0);
    }
  });

  it('stops after two retries', async () => {
    const h = harness([response(500), response(500), response(500)]);

    await expect(fetchFeed('https://example.com/feed.xml', h)).rejects.toThrow(FeedFetchError);
    expect(h.calls).toHaveLength(3);
    expect(h.sleeps).toHaveLength(2);
  });

  it('reports the final status when retries are exhausted', async () => {
    const h = harness([response(503), response(503), response(503)]);

    await expect(fetchFeed('https://example.com/feed.xml', h)).rejects.toMatchObject({
      code: 'HTTP_ERROR',
      status: 503,
    });
  });

  it('reports NETWORK_ERROR when the network keeps failing', async () => {
    const h = harness([new Error('boom'), new Error('boom'), new Error('boom')]);

    await expect(fetchFeed('https://example.com/feed.xml', h)).rejects.toMatchObject({
      code: 'NETWORK_ERROR',
    });
  });

  it('reports TIMEOUT when every attempt times out', async () => {
    const h = harness([timeoutError(), timeoutError(), timeoutError()]);

    await expect(fetchFeed('https://example.com/feed.xml', h)).rejects.toMatchObject({
      code: 'TIMEOUT',
    });
  });

  it('honors a configured retry limit', async () => {
    const h = harness([response(500), response(500)]);

    await expect(
      fetchFeed('https://example.com/feed.xml', { ...h, maxRetries: 1 }),
    ).rejects.toThrow(FeedFetchError);
    expect(h.calls).toHaveLength(2);
  });
});

describe('fetchFeed — Retry-After', () => {
  it('uses the Retry-After delay instead of backoff', async () => {
    const h = harness([
      response(429, { headerMap: { 'retry-after': '5' } }),
      response(200, { body: 'ok' }),
    ]);
    await fetchFeed('https://example.com/feed.xml', h);

    expect(h.sleeps).toEqual([5000]);
  });

  it('caps Retry-After at 30 seconds', async () => {
    const h = harness([
      response(429, { headerMap: { 'retry-after': '3600' } }),
      response(200, { body: 'ok' }),
    ]);
    await fetchFeed('https://example.com/feed.xml', h);

    expect(h.sleeps).toEqual([MAX_RETRY_AFTER_MS]);
  });

  it('falls back to backoff when Retry-After is absent', async () => {
    const h = harness([response(429), response(200, { body: 'ok' })]);
    await fetchFeed('https://example.com/feed.xml', h);

    expect(h.sleeps).toHaveLength(1);
    expect(h.sleeps[0]).toBeLessThanOrEqual(MAX_RETRY_AFTER_MS);
  });
});

describe('parseRetryAfter', () => {
  it('parses delta-seconds', () => {
    expect(parseRetryAfter('10')).toBe(10_000);
    expect(parseRetryAfter('0')).toBe(0);
  });

  it('caps delta-seconds at 30 seconds', () => {
    expect(parseRetryAfter('120')).toBe(MAX_RETRY_AFTER_MS);
    expect(parseRetryAfter('99999')).toBe(MAX_RETRY_AFTER_MS);
  });

  it('parses an HTTP-date relative to now', () => {
    const now = Date.UTC(2026, 10, 19, 0, 0, 0);

    expect(parseRetryAfter(new Date(now + 5000).toUTCString(), now)).toBe(5000);
  });

  it('returns undefined for missing or unparseable values', () => {
    expect(parseRetryAfter(null)).toBeUndefined();
    expect(parseRetryAfter('')).toBeUndefined();
    expect(parseRetryAfter('not-a-date')).toBeUndefined();
  });

  it('never returns a negative delay', () => {
    const now = Date.UTC(2026, 10, 19, 0, 0, 0);

    expect(parseRetryAfter(new Date(now - 5000).toUTCString(), now)).toBe(0);
  });
});

describe('backoffDelay', () => {
  it('grows exponentially', () => {
    expect(backoffDelay(0, () => 0)).toBe(500);
    expect(backoffDelay(1, () => 0)).toBe(1000);
    expect(backoffDelay(2, () => 0)).toBe(2000);
  });

  it('adds bounded jitter', () => {
    expect(backoffDelay(0, () => 1)).toBe(750);
  });

  it('never exceeds the retry-after ceiling', () => {
    for (const attempt of [0, 1, 2, 3, 10, 40]) {
      expect(backoffDelay(attempt, () => 1)).toBeLessThanOrEqual(MAX_RETRY_AFTER_MS);
    }
  });
});

describe('fetchFeed — redirects', () => {
  it('rejects a 301 without following it', async () => {
    const h = harness([response(301, { headerMap: { location: 'https://evil.example/x' } })]);

    await expect(fetchFeed('https://example.com/feed.xml', h)).rejects.toMatchObject({
      code: 'REDIRECT_NOT_ALLOWED',
    });
  });

  it('rejects 302, 303, 307 and 308', async () => {
    for (const status of [302, 303, 307, 308]) {
      const h = harness([response(status)]);

      await expect(
        fetchFeed('https://example.com/feed.xml', h),
        `status ${status}`,
      ).rejects.toMatchObject({ code: 'REDIRECT_NOT_ALLOWED' });
    }
  });

  it('does not retry a redirect', async () => {
    const h = harness([response(302), response(200, { body: 'should not be used' })]);

    await expect(fetchFeed('https://example.com/feed.xml', h)).rejects.toThrow(FeedFetchError);
    expect(h.calls).toHaveLength(1);
    expect(h.sleeps).toHaveLength(0);
  });

  it('never requests the redirect target', async () => {
    const h = harness([response(301, { headerMap: { location: 'https://evil.example/x' } })]);

    await expect(fetchFeed('https://example.com/feed.xml', h)).rejects.toThrow();
    expect(h.calls.map((call) => call.url)).toEqual(['https://example.com/feed.xml']);
  });
});

describe('fetchFeed — size limits', () => {
  it('rejects early when Content-Length exceeds the limit', async () => {
    const h = harness([
      response(200, { headerMap: { 'content-length': String(MAX_RESPONSE_BYTES + 1) } }),
    ]);

    await expect(fetchFeed('https://example.com/feed.xml', h)).rejects.toMatchObject({
      code: 'RESPONSE_TOO_LARGE',
    });
    expect(h.calls).toHaveLength(1);
  });

  it('accepts a body exactly at the limit', async () => {
    const encoder = new TextEncoder();
    const fetchImpl: FetchLike = async () => ({
      status: 200,
      headers: headers(),
      body: bodyStream([encoder.encode('a'.repeat(MAX_RESPONSE_BYTES))]),
    });

    const result = await fetchFeed('https://example.com/feed.xml', { fetchImpl });

    expect(result.body).toHaveLength(MAX_RESPONSE_BYTES);
  });

  it('enforces the limit while streaming when Content-Length lies', async () => {
    const encoder = new TextEncoder();
    const chunk = encoder.encode('a'.repeat(1024 * 1024));
    const fetchImpl: FetchLike = async () => ({
      status: 200,
      // Declares a small body; the streamed bytes are authoritative.
      headers: headers({ 'content-length': '10' }),
      body: bodyStream([chunk, chunk, chunk]),
    });

    await expect(fetchFeed('https://example.com/feed.xml', { fetchImpl })).rejects.toMatchObject({
      code: 'RESPONSE_TOO_LARGE',
    });
  });

  it('enforces the limit when no Content-Length is present', async () => {
    const encoder = new TextEncoder();
    const fetchImpl: FetchLike = async () => ({
      status: 200,
      headers: headers(),
      body: bodyStream([encoder.encode('b'.repeat(MAX_RESPONSE_BYTES + 1))]),
    });

    await expect(fetchFeed('https://example.com/feed.xml', { fetchImpl })).rejects.toMatchObject({
      code: 'RESPONSE_TOO_LARGE',
    });
  });

  it('does not retry an oversized response', async () => {
    const h = harness([
      response(200, { headerMap: { 'content-length': String(MAX_RESPONSE_BYTES + 1) } }),
      response(200, { body: 'should not be used' }),
    ]);

    await expect(fetchFeed('https://example.com/feed.xml', h)).rejects.toThrow(FeedFetchError);
    expect(h.calls).toHaveLength(1);
  });

  it('honors a custom byte limit', async () => {
    const encoder = new TextEncoder();
    const fetchImpl: FetchLike = async () => ({
      status: 200,
      headers: headers(),
      body: bodyStream([encoder.encode('12345')]),
    });

    await expect(
      fetchFeed('https://example.com/feed.xml', { fetchImpl, maxBytes: 4 }),
    ).rejects.toMatchObject({ code: 'RESPONSE_TOO_LARGE' });
  });
});

describe('fetchFeed — timeout configuration', () => {
  it('passes an abort signal to fetch', async () => {
    const h = harness([response(200, { body: 'x' })]);
    await fetchFeed('https://example.com/feed.xml', h);

    expect(h.calls[0]?.init.signal).toBeInstanceOf(AbortSignal);
  });

  it('defaults to a bounded timeout', () => {
    expect(DEFAULT_TIMEOUT_MS).toBeGreaterThan(0);
    expect(DEFAULT_TIMEOUT_MS).toBeLessThanOrEqual(30_000);
  });

  it('does not log the response body', async () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const h = harness([response(500, { body: 'secret-body' }), response(500), response(500)]);

    await expect(fetchFeed('https://example.com/feed.xml', h)).rejects.toThrow();
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});
