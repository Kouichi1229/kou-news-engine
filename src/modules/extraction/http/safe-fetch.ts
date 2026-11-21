import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import type { IncomingMessage } from 'node:http';

import {
  ALLOWED_PORTS,
  MAX_REDIRECTS,
  MAX_RESPONSE_BYTES,
  REQUEST_TIMEOUT_MS,
} from '../extraction.constants.js';
import { ExtractionFailureError, UnsafeUrlError } from '../extraction.errors.js';

import { readBodyWithLimit } from './body-reader.js';
import { decodeBody, isHtmlContentType, type DecodedBody } from './charset.js';
import { createPinnedLookup, resolveAndValidate, type ResolveFunction } from './dns-pin.js';
import type { LookupFunction } from './lookup.types.js';

/** A validated URL, ready to be requested. */
export interface ValidatedUrl {
  url: URL;
  /** Port actually used, after applying the scheme default. */
  port: number;
  /** Hostname without IPv6 brackets. */
  hostname: string;
  /** Value for the `Host` header. */
  hostHeader: string;
}

/**
 * Parses and validates one URL without touching the network.
 *
 * Runs the same checks for the initial URL and for every redirect target, so a
 * redirect cannot reach a destination the first hop would have been refused.
 *
 * The port allowlist is fixed here rather than accepted as an argument: it is
 * what stops an article URL from reaching SSH, Redis or an internal admin port,
 * so no caller may widen it.
 *
 * @throws UnsafeUrlError for anything that fails validation.
 */
export function validateUrl(rawUrl: string, previous?: URL): ValidatedUrl {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new UnsafeUrlError('INVALID_URL', 'URL could not be parsed');
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new UnsafeUrlError('UNSUPPORTED_SCHEME', `Unsupported scheme: ${url.protocol}`);
  }

  if (url.username !== '' || url.password !== '') {
    throw new UnsafeUrlError('URL_HAS_CREDENTIALS', 'URL must not embed credentials');
  }

  if (previous !== undefined && previous.protocol === 'https:' && url.protocol === 'http:') {
    throw new UnsafeUrlError('HTTPS_DOWNGRADE', 'Refusing to follow a redirect from HTTPS to HTTP');
  }

  const port =
    url.port === '' ? (url.protocol === 'https:' ? 443 : 80) : Number.parseInt(url.port, 10);
  if (!ALLOWED_PORTS.includes(port)) {
    throw new UnsafeUrlError('BAD_PORT', `Port ${port} is not allowed`);
  }

  // `URL.hostname` keeps the brackets around IPv6 literals; every consumer here
  // wants the bare address.
  const hostname =
    url.hostname.startsWith('[') && url.hostname.endsWith(']')
      ? url.hostname.slice(1, -1)
      : url.hostname;

  if (hostname === '') {
    throw new UnsafeUrlError('INVALID_URL', 'URL has an empty hostname');
  }

  const isDefaultPort =
    (url.protocol === 'https:' && port === 443) || (url.protocol === 'http:' && port === 80);
  const hostHeader = isDefaultPort ? hostname : `${hostname}:${port}`;

  return { url, port, hostname, hostHeader };
}

/** Everything one successful fetch produced. */
export interface FetchResult {
  body: DecodedBody;
  finalUrl: string;
  status: number;
}

/**
 * Options the production fetch accepts.
 *
 * There is no port override and no switch that relaxes the address guard: those
 * are module constants. A caller cannot disable SSRF protection by passing an
 * option.
 */
export interface SafeFetchOptions {
  maxRedirects?: number;
  timeoutMs?: number;
  maxBytes?: number;
  /** DNS seam for tests. Defaults to `dns.lookup`. */
  resolve?: ResolveFunction;
  /** Injected for deterministic tests of the request layer. */
  userAgent?: string;
}

const DEFAULT_USER_AGENT = 'KouNewsEngine/0.0.0 (+https://github.com/kou-ai/kou-news-engine)';

function requestOnce(
  target: ValidatedUrl,
  lookup: LookupFunction,
  timeoutMs: number,
  userAgent: string,
): Promise<IncomingMessage> {
  return new Promise((resolvePromise, rejectPromise) => {
    const isHttps = target.url.protocol === 'https:';
    const send = isHttps ? httpsRequest : httpRequest;

    const req = send(
      {
        // `host` stays the hostname so the Host header, TLS SNI and certificate
        // verification all use the name the user asked for. `lookup` pins the
        // socket to the address that was validated a moment ago.
        host: target.hostname,
        port: target.port,
        path: `${target.url.pathname}${target.url.search}`,
        method: 'GET',
        headers: {
          Host: target.hostHeader,
          'User-Agent': userAgent,
          Accept: 'text/html,application/xhtml+xml',
          'Accept-Encoding': 'identity',
        },
        lookup,
        ...(isHttps ? { servername: target.hostname, rejectUnauthorized: true } : {}),
      },
      resolvePromise,
    );

    req.setTimeout(timeoutMs, () => {
      req.destroy(
        new ExtractionFailureError('TIMEOUT', `Request exceeded the ${timeoutMs} ms timeout`),
      );
    });

    req.on('error', (error: Error) => {
      rejectPromise(
        error instanceof ExtractionFailureError
          ? error
          : new ExtractionFailureError('NETWORK_ERROR', error.message),
      );
    });

    req.end();
  });
}

function statusToFailureCode(status: number): string {
  if (status === 403) return 'HTTP_403';
  if (status === 404) return 'HTTP_404';
  if (status === 410) return 'HTTP_410';
  return `HTTP_${status}`;
}

/**
 * Fetches an article with full SSRF protection on every hop.
 *
 * Each redirect is handled as a fresh request: the new URL is parsed and
 * validated, its hostname resolved, **every** returned address classified, and
 * only then is a socket pinned. Nothing from the previous hop is reused except
 * the redirect count, so a redirect cannot inherit a trusted destination.
 *
 * Redirects are followed here rather than by the HTTP client, because the
 * client's automatic following would skip validation entirely.
 *
 * The port allowlist and the address guard are module constants, not options.
 * No caller — production or test — can relax either one through this API.
 */
export async function safeFetch(
  rawUrl: string,
  options: SafeFetchOptions = {},
): Promise<FetchResult> {
  const maxRedirects = options.maxRedirects ?? MAX_REDIRECTS;
  const timeoutMs = options.timeoutMs ?? REQUEST_TIMEOUT_MS;
  const maxBytes = options.maxBytes ?? MAX_RESPONSE_BYTES;
  const userAgent = options.userAgent ?? DEFAULT_USER_AGENT;

  let current = validateUrl(rawUrl);
  let redirects = 0;

  for (;;) {
    const target = await resolveAndValidate(current.hostname, options.resolve);
    const lookup = createPinnedLookup(target.pinned);
    const response = await requestOnce(current, lookup, timeoutMs, userAgent);
    const status = response.statusCode ?? 0;

    if (status >= 300 && status < 400) {
      response.resume();
      const location = response.headers.location;
      if (typeof location !== 'string' || location === '') {
        throw new UnsafeUrlError('INVALID_REDIRECT', 'Redirect response had no Location header');
      }
      redirects += 1;
      if (redirects > maxRedirects) {
        throw new UnsafeUrlError('TOO_MANY_REDIRECTS', `Exceeded ${maxRedirects} redirects`);
      }
      let next: URL;
      try {
        next = new URL(location, current.url);
      } catch {
        throw new UnsafeUrlError('INVALID_REDIRECT', 'Redirect Location could not be parsed');
      }
      current = validateUrl(next.toString(), current.url);
      continue;
    }

    if (status < 200 || status >= 300) {
      response.resume();
      throw new ExtractionFailureError(
        statusToFailureCode(status),
        `Unexpected status ${status}`,
        status,
      );
    }

    const contentType = response.headers['content-type'] ?? null;
    if (!isHtmlContentType(contentType)) {
      response.resume();
      throw new ExtractionFailureError(
        'UNSUPPORTED_CONTENT_TYPE',
        `Unsupported content type: ${contentType ?? '(none)'}`,
        status,
      );
    }

    const bytes = await readBodyWithLimit(response, maxBytes);
    return {
      body: decodeBody(bytes, contentType),
      finalUrl: current.url.toString(),
      status,
    };
  }
}
