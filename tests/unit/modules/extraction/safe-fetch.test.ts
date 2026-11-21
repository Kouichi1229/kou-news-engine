import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  ExtractionFailureError,
  ResponseTooLargeError,
  UnsafeUrlError,
} from '../../../../src/modules/extraction/extraction.errors.js';
import type { ResolveFunction } from '../../../../src/modules/extraction/http/dns-pin.js';
import { safeFetch, validateUrl } from '../../../../src/modules/extraction/http/safe-fetch.js';
import { enqueueResponse, recordedRequests, resetFakeHttp } from '../../../helpers/fake-http.js';

/**
 * The HTTP connection is faked so the success path can run without a socket.
 *
 * `safeFetch`'s guard cannot be satisfied by a test server: it denies every
 * address a test can bind to and admits only ports 80/443. The guard itself runs
 * for real on every hop below — only the socket is replaced — so these tests
 * exercise the production code path rather than a relaxed copy of it.
 */
vi.mock('node:http', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:http')>();
  const { fakeRequest } = await import('../../../helpers/fake-http.js');
  return { ...actual, request: fakeRequest };
});

vi.mock('node:https', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:https')>();
  const { fakeRequest } = await import('../../../helpers/fake-http.js');
  return { ...actual, request: fakeRequest };
});

const PUBLIC_IP = '93.184.216.34';

/** Answers every hostname with one public address, so the guard admits it. */
function publicResolver(address = PUBLIC_IP, family = 4): ResolveFunction {
  return (_hostname, _options, callback) => {
    callback(null, [{ address, family }]);
  };
}

beforeEach(() => {
  resetFakeHttp();
});

afterEach(() => {
  resetFakeHttp();
  vi.restoreAllMocks();
});

describe('validateUrl', () => {
  it('accepts an ordinary https URL', () => {
    expect(validateUrl('https://example.com/a').hostname).toBe('example.com');
  });

  it('defaults the port by scheme', () => {
    expect(validateUrl('https://example.com/a').port).toBe(443);
    expect(validateUrl('http://example.com/a').port).toBe(80);
  });

  it('rejects a non-http scheme', () => {
    expect(() => validateUrl('ftp://example.com/a')).toThrow(UnsafeUrlError);
  });

  it('rejects embedded credentials', () => {
    expect(() => validateUrl('https://user:pass@example.com/a')).toThrow(UnsafeUrlError);
  });

  it('rejects a port outside the allowlist', () => {
    const error = (() => {
      try {
        validateUrl('http://example.com:22/a');
        return null;
      } catch (caught) {
        return caught;
      }
    })();
    expect(error).toBeInstanceOf(UnsafeUrlError);
    expect((error as UnsafeUrlError).code).toBe('BAD_PORT');
  });

  it('refuses an https-to-http redirect', () => {
    const error = (() => {
      try {
        validateUrl('http://example.com/a', new URL('https://example.com/a'));
        return null;
      } catch (caught) {
        return caught;
      }
    })();
    expect((error as UnsafeUrlError).code).toBe('HTTPS_DOWNGRADE');
  });

  it('omits the default port from the Host header', () => {
    expect(validateUrl('https://example.com/a').hostHeader).toBe('example.com');
  });

  it('rejects a non-default port, since only 80 and 443 are allowed', () => {
    expect(() => validateUrl('http://example.com:8080/a')).toThrow(UnsafeUrlError);
  });
});

describe('safeFetch — the guard blocks private destinations', () => {
  it('refuses a loopback IP literal', async () => {
    await expect(safeFetch('http://127.0.0.1/a')).rejects.toBeInstanceOf(UnsafeUrlError);
  });

  it('refuses a hostname that resolves to loopback', async () => {
    await expect(
      safeFetch('http://public.example.com/a', { resolve: publicResolver('127.0.0.1') }),
    ).rejects.toBeInstanceOf(UnsafeUrlError);
  });

  it('refuses the cloud metadata address', async () => {
    await expect(
      safeFetch('http://metadata.example.com/a', { resolve: publicResolver('169.254.169.254') }),
    ).rejects.toBeInstanceOf(UnsafeUrlError);
  });

  it('refuses a mixed answer where only one address is private', async () => {
    const mixed: ResolveFunction = (_hostname, _options, callback) => {
      callback(null, [
        { address: PUBLIC_IP, family: 4 },
        { address: '10.0.0.5', family: 4 },
      ]);
    };
    await expect(safeFetch('http://example.com/a', { resolve: mixed })).rejects.toBeInstanceOf(
      UnsafeUrlError,
    );
  });

  it('refuses an IPv6 loopback literal', async () => {
    await expect(safeFetch('http://[::1]/a')).rejects.toBeInstanceOf(UnsafeUrlError);
  });

  it('never opens a connection when the guard refuses', async () => {
    await expect(
      safeFetch('http://public.example.com/a', { resolve: publicResolver('127.0.0.1') }),
    ).rejects.toBeInstanceOf(UnsafeUrlError);
    expect(recordedRequests()).toHaveLength(0);
  });

  it('refuses a port outside the allowlist before connecting', async () => {
    const error = await safeFetch('http://example.com:22/a', {
      resolve: publicResolver(),
    }).catch((caught: unknown) => caught);
    expect((error as UnsafeUrlError).code).toBe('BAD_PORT');
    expect(recordedRequests()).toHaveLength(0);
  });
});

describe('safeFetch — the pinned address reaches the socket', () => {
  it('hands the resolved address to the transport as a pinned lookup', async () => {
    enqueueResponse({ headers: { 'content-type': 'text/html' }, body: [Buffer.from('<p>ok</p>')] });

    await safeFetch('http://article.example.com/a', { resolve: publicResolver() });

    const [sent] = recordedRequests();
    expect(sent?.host).toBe('article.example.com');
    expect(sent?.port).toBe(80);
    // The Host header carries the name, not the address, so virtual hosting and
    // TLS SNI still see the site that was requested.
    expect(sent?.headers?.Host).toBe('article.example.com');

    // The lookup handed over is the pinning one: asking it for the address must
    // yield the validated address, never a second DNS answer.
    const lookup = sent?.lookup as (
      hostname: string,
      options: { all: true },
      cb: (err: null, addresses: Array<{ address: string; family: number }>) => void,
    ) => void;
    const resolved = await new Promise<Array<{ address: string; family: number }>>((resolve) => {
      lookup('article.example.com', { all: true }, (_err, addresses) => {
        resolve(addresses);
      });
    });
    expect(resolved).toEqual([{ address: PUBLIC_IP, family: 4 }]);
  });

  it('pins SNI and certificate verification to the requested hostname over https', async () => {
    enqueueResponse({ headers: { 'content-type': 'text/html' }, body: [Buffer.from('<p>ok</p>')] });

    await safeFetch('https://article.example.com/a', { resolve: publicResolver() });

    const [sent] = recordedRequests();
    expect(sent?.port).toBe(443);
    // The socket is pinned to the validated address, but the name stays the
    // identity used for SNI and certificate checks.
    expect(sent?.servername).toBe('article.example.com');
    expect(sent?.rejectUnauthorized).toBe(true);
  });
});

describe('safeFetch — successful retrieval', () => {
  function enqueueHtml(html: string, contentType = 'text/html; charset=utf-8'): void {
    enqueueResponse({ headers: { 'content-type': contentType }, body: [Buffer.from(html)] });
  }

  it('returns the decoded body, final URL and status', async () => {
    enqueueHtml('<html><body><p>內容</p></body></html>');

    const result = await safeFetch('http://content.example.com/a', { resolve: publicResolver() });

    expect(result.body.text).toContain('內容');
    expect(result.body.source).toBe('content-type');
    expect(result.status).toBe(200);
    expect(result.finalUrl).toBe('http://content.example.com/a');
  });

  it('decodes a GBK body using the response charset', async () => {
    const iconv = (await import('iconv-lite')).default;
    const text = '简体中文新闻内容';
    enqueueResponse({
      headers: { 'content-type': 'text/html; charset=gbk' },
      body: [iconv.encode(text, 'gbk')],
    });

    const result = await safeFetch('http://content.example.com/a', { resolve: publicResolver() });
    expect(result.body.text).toContain(text);
    expect(result.body.charset).toBe('gbk');
  });

  it('rejects a non-HTML content type', async () => {
    enqueueResponse({ headers: { 'content-type': 'application/json' }, body: [Buffer.from('{}')] });

    const error = await safeFetch('http://content.example.com/a', {
      resolve: publicResolver(),
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ExtractionFailureError);
    expect((error as ExtractionFailureError).code).toBe('UNSUPPORTED_CONTENT_TYPE');
  });

  it('rejects a 404 with its status code', async () => {
    enqueueResponse({
      status: 404,
      headers: { 'content-type': 'text/html' },
      body: [Buffer.from('gone')],
    });

    const error = await safeFetch('http://content.example.com/a', {
      resolve: publicResolver(),
    }).catch((caught: unknown) => caught);

    expect((error as ExtractionFailureError).code).toBe('HTTP_404');
    expect((error as ExtractionFailureError).httpStatus).toBe(404);
  });

  it('rejects a 403 with its status code', async () => {
    enqueueResponse({
      status: 403,
      headers: { 'content-type': 'text/html' },
      body: [Buffer.from('forbidden')],
    });

    const error = await safeFetch('http://content.example.com/a', {
      resolve: publicResolver(),
    }).catch((caught: unknown) => caught);
    expect((error as ExtractionFailureError).code).toBe('HTTP_403');
  });

  it('rejects a body above the byte cap', async () => {
    enqueueResponse({
      headers: { 'content-type': 'text/html' },
      body: [Buffer.from('x'.repeat(5000))],
    });

    const error = await safeFetch('http://content.example.com/a', {
      resolve: publicResolver(),
      maxBytes: 100,
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ResponseTooLargeError);
    expect((error as ResponseTooLargeError).code).toBe('RESPONSE_TOO_LARGE');
  });

  it('rejects a body that exceeds the cap across several chunks', async () => {
    enqueueResponse({
      headers: { 'content-type': 'text/html' },
      body: [Buffer.from('x'.repeat(60)), Buffer.from('x'.repeat(60))],
    });

    await expect(
      safeFetch('http://content.example.com/a', { resolve: publicResolver(), maxBytes: 100 }),
    ).rejects.toBeInstanceOf(ResponseTooLargeError);
  });

  it('reports a timeout as TIMEOUT', async () => {
    enqueueResponse({ hang: true });

    const error = await safeFetch('http://content.example.com/a', {
      resolve: publicResolver(),
      timeoutMs: 10,
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ExtractionFailureError);
    expect((error as ExtractionFailureError).code).toBe('TIMEOUT');
  });
});

describe('safeFetch — redirects', () => {
  it('follows a redirect to another allowlisted location', async () => {
    enqueueResponse({ status: 302, headers: { location: '/final' } });
    enqueueResponse({
      headers: { 'content-type': 'text/html' },
      body: [Buffer.from('<p>arrived</p>')],
    });

    const result = await safeFetch('http://content.example.com/start', {
      resolve: publicResolver(),
    });

    expect(result.body.text).toContain('arrived');
    expect(result.finalUrl).toBe('http://content.example.com/final');
    expect(recordedRequests()).toHaveLength(2);
  });

  it('revalidates the address on the redirect hop', async () => {
    enqueueResponse({ status: 302, headers: { location: 'http://elsewhere.example.com/final' } });
    enqueueResponse({ headers: { 'content-type': 'text/html' }, body: [Buffer.from('<p>ok</p>')] });

    await safeFetch('http://content.example.com/start', { resolve: publicResolver() });

    const [, second] = recordedRequests();
    expect(second?.host).toBe('elsewhere.example.com');
  });

  it('rejects a redirect that resolves to a private address', async () => {
    enqueueResponse({ status: 302, headers: { location: 'http://internal.example.com/final' } });

    let call = 0;
    const resolver: ResolveFunction = (_hostname, _options, callback) => {
      call += 1;
      // The first hop is public; the redirect target is not.
      callback(null, [{ address: call === 1 ? PUBLIC_IP : '127.0.0.1', family: 4 }]);
    };

    await expect(
      safeFetch('http://content.example.com/start', { resolve: resolver }),
    ).rejects.toBeInstanceOf(UnsafeUrlError);
    // The refusal happened before the second connection was attempted.
    expect(recordedRequests()).toHaveLength(1);
  });

  it('rejects a redirect to a port outside the allowlist', async () => {
    enqueueResponse({ status: 302, headers: { location: 'http://content.example.com:22/ssh' } });

    const error = await safeFetch('http://content.example.com/start', {
      resolve: publicResolver(),
    }).catch((caught: unknown) => caught);

    expect((error as UnsafeUrlError).code).toBe('BAD_PORT');
    expect(recordedRequests()).toHaveLength(1);
  });

  it('rejects a redirect that exceeds the hop limit', async () => {
    for (let i = 0; i < 4; i += 1) {
      enqueueResponse({ status: 302, headers: { location: `/loop${String(i)}` } });
    }

    const error = await safeFetch('http://content.example.com/start', {
      resolve: publicResolver(),
      maxRedirects: 2,
    }).catch((caught: unknown) => caught);

    expect((error as UnsafeUrlError).code).toBe('TOO_MANY_REDIRECTS');
  });

  it('rejects a redirect with no Location header', async () => {
    enqueueResponse({ status: 302 });

    const error = await safeFetch('http://content.example.com/start', {
      resolve: publicResolver(),
    }).catch((caught: unknown) => caught);

    expect((error as UnsafeUrlError).code).toBe('INVALID_REDIRECT');
  });

  it('rejects a redirect to a non-http scheme', async () => {
    enqueueResponse({ status: 302, headers: { location: 'file:///etc/passwd' } });

    const error = await safeFetch('http://content.example.com/start', {
      resolve: publicResolver(),
    }).catch((caught: unknown) => caught);

    expect((error as UnsafeUrlError).code).toBe('UNSUPPORTED_SCHEME');
  });
});

describe('safeFetch — guard precedence', () => {
  it('surfaces a guard failure as UnsafeUrlError carrying SSRF_BLOCKED', async () => {
    const error = await safeFetch('http://127.0.0.1/a').catch((caught: unknown) => caught);
    // UnsafeUrlError deliberately extends ExtractionFailureError, so the service
    // can record every extraction error through one path; the code is what
    // distinguishes an SSRF refusal from a network fault.
    expect(error).toBeInstanceOf(UnsafeUrlError);
    expect((error as UnsafeUrlError).code).toBe('SSRF_BLOCKED');
    expect((error as UnsafeUrlError).httpStatus).toBeNull();
  });

  it('denies loopback on the redirect hop even when the first hop was public', async () => {
    enqueueResponse({ status: 302, headers: { location: 'http://127.0.0.1/final' } });

    const error = await safeFetch('http://content.example.com/start', {
      resolve: publicResolver(),
    }).catch((caught: unknown) => caught);

    expect((error as UnsafeUrlError).code).toBe('SSRF_BLOCKED');
  });
});
