import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { afterEach, describe, expect, it } from 'vitest';

import {
  ExtractionFailureError,
  ResponseTooLargeError,
  UnsafeUrlError,
} from '../../../../src/modules/extraction/extraction.errors.js';
import type { ResolveFunction } from '../../../../src/modules/extraction/http/dns-pin.js';
import { safeFetch, validateUrl } from '../../../../src/modules/extraction/http/safe-fetch.js';

const servers: Server[] = [];

async function serve(handler: Parameters<typeof createServer>[1]): Promise<{
  port: number;
  url: string;
}> {
  const server = createServer(handler);
  servers.push(server);
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address() as AddressInfo;
  return { port: address.port, url: `http://127.0.0.1:${address.port}` };
}

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(() => {
            resolve();
          });
        }),
    ),
  );
});

/** Pretends every hostname resolves to the given address. */
function resolverFor(address: string, family = 4): ResolveFunction {
  return (_hostname, _options, callback) => {
    callback(null, [{ address, family }]);
  };
}

describe('validateUrl', () => {
  it('accepts an ordinary https URL', () => {
    expect(validateUrl('https://example.com/a').hostname).toBe('example.com');
  });

  it('defaults the port by scheme', () => {
    expect(validateUrl('https://example.com/a').port).toBe(443);
    expect(validateUrl('http://example.com/a').port).toBe(80);
  });

  it('rejects non-http schemes', () => {
    expect(() => validateUrl('file:///etc/passwd')).toThrow(UnsafeUrlError);
    expect(() => validateUrl('javascript:alert(1)')).toThrow(UnsafeUrlError);
  });

  it('rejects embedded credentials', () => {
    expect(() => validateUrl('https://user:pass@example.com/a')).toThrow(UnsafeUrlError);
  });

  it('rejects a port outside the allowlist', () => {
    expect(() => validateUrl('http://example.com:22/a')).toThrow(UnsafeUrlError);
    expect(() => validateUrl('http://example.com:6379/a')).toThrow(UnsafeUrlError);
    expect(() => validateUrl('http://example.com:8080/a')).toThrow(UnsafeUrlError);
  });

  it('rejects an unparseable URL', () => {
    expect(() => validateUrl('not a url')).toThrow(UnsafeUrlError);
  });

  it('strips IPv6 brackets from the hostname', () => {
    expect(validateUrl('http://[::1]/').hostname).toBe('::1');
  });

  it('rejects an HTTPS to HTTP downgrade on redirect', () => {
    expect(() => validateUrl('http://example.com/b', new URL('https://example.com/a'))).toThrow(
      UnsafeUrlError,
    );
  });

  it('allows an HTTP to HTTPS upgrade on redirect', () => {
    expect(validateUrl('https://example.com/b', new URL('http://example.com/a')).port).toBe(443);
  });

  it('omits the default port from the Host header', () => {
    expect(validateUrl('https://example.com/a').hostHeader).toBe('example.com');
  });
});

describe('safeFetch — the guard blocks private destinations', () => {
  it('refuses a loopback IP literal even with a live server listening', async () => {
    const { url } = await serve((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('<html><body>unreachable</body></html>');
    });
    await expect(
      safeFetch(`${url}/a`, { allowedPorts: [Number(new URL(url).port)] }),
    ).rejects.toBeInstanceOf(UnsafeUrlError);
  });

  it('refuses a hostname that resolves to loopback', async () => {
    await expect(
      safeFetch('http://public.example.com/a', { resolve: resolverFor('127.0.0.1') }),
    ).rejects.toBeInstanceOf(UnsafeUrlError);
  });

  it('refuses the cloud metadata address', async () => {
    await expect(
      safeFetch('http://metadata.example.com/a', { resolve: resolverFor('169.254.169.254') }),
    ).rejects.toBeInstanceOf(UnsafeUrlError);
  });

  it('refuses a mixed answer where only one address is private', async () => {
    const mixed: ResolveFunction = (_hostname, _options, callback) => {
      callback(null, [
        { address: '93.184.216.34', family: 4 },
        { address: '10.0.0.5', family: 4 },
      ]);
    };
    await expect(safeFetch('http://example.com/a', { resolve: mixed })).rejects.toBeInstanceOf(
      UnsafeUrlError,
    );
  });
});

describe('safeFetch — pinning controls the socket', () => {
  it('connects to the pinned address rather than resolving the hostname again', async () => {
    // `pinned.invalid` does not exist in DNS. This request can only reach the
    // server if the pinned lookup supplied the address, which is the property
    // under test. `allowPrivateAddresses` is on because the test server must
    // bind to loopback; see the guard tests above for the denying default.
    const { port } = await serve((req, res) => {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(`<html><body><p>host=${String(req.headers.host)}</p></body></html>`);
    });

    const result = await safeFetch(`http://pinned.invalid:${String(port)}/a`, {
      resolve: resolverFor('127.0.0.1'),
      allowedPorts: [port],
      allowPrivateAddresses: true,
    });

    expect(result.body.text).toContain('host=pinned.invalid');
    expect(result.status).toBe(200);
  });

  it('sends the requested Host header while connecting to the pinned address', async () => {
    let observedHost: string | undefined;
    const { port } = await serve((req, res) => {
      observedHost = req.headers.host;
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('<html><body><p>ok</p></body></html>');
    });

    await safeFetch(`http://article.example.com:${String(port)}/path`, {
      resolve: resolverFor('127.0.0.1'),
      allowedPorts: [port],
      allowPrivateAddresses: true,
    });

    // The Host header carries the name, not the address: virtual hosting and
    // TLS SNI must still see the site the user asked for.
    expect(observedHost).toBe(`article.example.com:${String(port)}`);
  });
});

describe('safeFetch — successful retrieval', () => {
  async function fetchFrom(
    handler: Parameters<typeof createServer>[1],
    options: { path?: string } = {},
  ): Promise<Awaited<ReturnType<typeof safeFetch>>> {
    const { port } = await serve(handler);
    return safeFetch(`http://content.example.com:${String(port)}${options.path ?? '/a'}`, {
      resolve: resolverFor('127.0.0.1'),
      allowedPorts: [port],
      allowPrivateAddresses: true,
    });
  }

  it('returns the decoded body, final URL and status', async () => {
    const result = await fetchFrom((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end('<html><body><p>內容</p></body></html>');
    });
    expect(result.body.text).toContain('內容');
    expect(result.status).toBe(200);
    expect(result.finalUrl).toContain('content.example.com');
  });

  it('decodes a GBK body using the response charset', async () => {
    const iconv = (await import('iconv-lite')).default;
    const text = '简体中文新闻内容';
    const result = await fetchFrom((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html; charset=gbk' });
      res.end(iconv.encode(text, 'gbk'));
    });
    expect(result.body.text).toContain(text);
  });

  it('rejects a non-HTML content type', async () => {
    await expect(
      fetchFrom((_req, res) => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{}');
      }),
    ).rejects.toBeInstanceOf(ExtractionFailureError);
  });

  it('rejects a 404', async () => {
    const error = await fetchFrom((_req, res) => {
      res.writeHead(404, { 'content-type': 'text/html' });
      res.end('<html><body>gone</body></html>');
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ExtractionFailureError);
    expect((error as ExtractionFailureError).code).toBe('HTTP_404');
    expect((error as ExtractionFailureError).httpStatus).toBe(404);
  });

  it('rejects a 403', async () => {
    const error = await fetchFrom((_req, res) => {
      res.writeHead(403, { 'content-type': 'text/html' });
      res.end('forbidden');
    }).catch((caught: unknown) => caught);
    expect((error as ExtractionFailureError).code).toBe('HTTP_403');
  });

  it('rejects a body above the byte cap', async () => {
    const { port } = await serve((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('x'.repeat(5000));
    });

    const error = await safeFetch(`http://content.example.com:${String(port)}/a`, {
      resolve: resolverFor('127.0.0.1'),
      allowedPorts: [port],
      allowPrivateAddresses: true,
      maxBytes: 100,
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ResponseTooLargeError);
    expect((error as ResponseTooLargeError).code).toBe('RESPONSE_TOO_LARGE');
  });
});

describe('safeFetch — redirects', () => {
  it('follows a redirect to another allowlisted location', async () => {
    const { port } = await serve((req, res) => {
      if (req.url === '/start') {
        res.writeHead(302, { location: '/final' });
        res.end();
        return;
      }
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('<html><body><p>arrived</p></body></html>');
    });

    const result = await safeFetch(`http://content.example.com:${String(port)}/start`, {
      resolve: resolverFor('127.0.0.1'),
      allowedPorts: [port],
      allowPrivateAddresses: true,
    });

    expect(result.body.text).toContain('arrived');
    expect(result.finalUrl).toContain('/final');
  });

  it('rejects a redirect that exceeds the hop limit', async () => {
    const { port } = await serve((req, res) => {
      res.writeHead(302, { location: `/loop${String(Date.now())}` });
      res.end();
    });

    await expect(
      safeFetch(`http://content.example.com:${String(port)}/start`, {
        resolve: resolverFor('127.0.0.1'),
        allowedPorts: [port],
        allowPrivateAddresses: true,
        maxRedirects: 2,
      }),
    ).rejects.toBeInstanceOf(UnsafeUrlError);
  });

  it('rejects a redirect with no Location header', async () => {
    const { port } = await serve((_req, res) => {
      res.writeHead(302);
      res.end();
    });

    await expect(
      safeFetch(`http://content.example.com:${String(port)}/start`, {
        resolve: resolverFor('127.0.0.1'),
        allowedPorts: [port],
        allowPrivateAddresses: true,
      }),
    ).rejects.toBeInstanceOf(UnsafeUrlError);
  });

  it('rejects a redirect to a port outside the allowlist', async () => {
    const { port } = await serve((_req, res) => {
      res.writeHead(302, { location: 'http://content.example.com:22/ssh' });
      res.end();
    });

    await expect(
      safeFetch(`http://content.example.com:${String(port)}/start`, {
        resolve: resolverFor('127.0.0.1'),
        allowedPorts: [port],
        allowPrivateAddresses: true,
      }),
    ).rejects.toBeInstanceOf(UnsafeUrlError);
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

  it('denies loopback by default, proving the test seam is off unless set', async () => {
    const { port } = await serve((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('<html><body>no</body></html>');
    });

    // `allowPrivateAddresses` is deliberately omitted.
    await expect(
      safeFetch(`http://content.example.com:${String(port)}/a`, {
        resolve: resolverFor('127.0.0.1'),
        allowedPorts: [port],
      }),
    ).rejects.toBeInstanceOf(UnsafeUrlError);
  });
});
