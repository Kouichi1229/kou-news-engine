/**
 * The single HTTP egress point for the Gemini adapter.
 *
 * This is the only module in the LLM layer permitted to open a socket
 * (Section 9.5.3.2). It implements the transport seam declared below, using
 * Node's built-in `node:https` — no SDK, no `undici`, no proxy support.
 *
 * Two properties are structural rather than conventional:
 *
 * - The module is inert at import. No socket is opened, no credential is read,
 *   and no client is constructed until `createGeminiTransport()` is called.
 * - The destination is not caller-controlled. `send()` takes a URL so the seam
 *   stays transport-agnostic, but it refuses anything whose origin is not the
 *   fixed Gemini origin before a socket exists (Section 11.1.6).
 */

import type { ClientRequest, IncomingMessage } from 'node:http';
import { request as httpsRequest } from 'node:https';

import { LlmError, LlmTimeoutError } from '../llm.errors.js';

/**
 * The one permitted destination. A module constant, never a parameter.
 *
 * The adapter passes a full URL through the seam; this constant is what makes
 * that URL trustworthy. A future adapter bug cannot turn the transport into an
 * open proxy because a foreign origin is refused before any I/O.
 */
export const GEMINI_ORIGIN = 'https://generativelanguage.googleapis.com';

/** The adopted endpoint path (Section 11.6.4). */
export const GEMINI_INTERACTIONS_PATH = '/v1/interactions';

/** Success body ceiling (Section 11.6.8). Provisional until validated. */
export const MAX_SUCCESS_BODY_BYTES = 1024 * 1024;

/** Error body ceiling (Section 11.6.8). Provisional until validated. */
export const MAX_ERROR_BODY_BYTES = 64 * 1024;

/** The transport contract. Unchanged by M4.0.1 and by M4.1 (Section 11.6.7). */
export interface GeminiTransport {
  send(
    url: string,
    init: {
      readonly body: string;
      readonly headers: Record<string, string>;
      readonly signal: AbortSignal;
    },
  ): Promise<{ readonly status: number; readonly body: string }>;
}

/**
 * Construction input for the production transport.
 *
 * `apiKey` is passed in rather than read from `process.env` here. Section 7.2
 * requires environment access to stay in `env.ts`, and Section 11.1.4 requires
 * the key to live only inside the transport's send boundary. Injecting it
 * satisfies both, and lets tests use a placeholder key without ever touching
 * the real environment.
 */
export interface GeminiTransportConfig {
  readonly apiKey: string;
  /** Deadline for one call. Composed with the caller's signal. */
  readonly timeoutMs?: number;
}

/**
 * Reads a response body with a hard byte ceiling, never buffering unbounded.
 *
 * The count is checked before each chunk is retained, so peak held bytes stay
 * at or below the ceiling rather than at ceiling plus a chunk. A declared
 * `Content-Length` is consulted only as a cheap early exit: the header is a
 * claim, and the streamed total is the guarantee.
 */
function readBodyWithLimit(response: IncomingMessage, maxBytes: number): Promise<string> {
  return new Promise((resolvePromise, rejectPromise) => {
    const declared = response.headers['content-length'];
    if (typeof declared === 'string') {
      const parsed = Number.parseInt(declared, 10);
      if (Number.isFinite(parsed) && parsed > maxBytes) {
        response.destroy();
        rejectPromise(
          new LlmError('invalid_response', 'Response exceeded the size ceiling', {
            providerId: 'gemini',
          }),
        );
        return;
      }
    }

    const chunks: Buffer[] = [];
    let total = 0;
    let settled = false;

    const fail = (): void => {
      if (settled) return;
      settled = true;
      response.destroy();
      rejectPromise(
        new LlmError('invalid_response', 'Response exceeded the size ceiling', {
          providerId: 'gemini',
        }),
      );
    };

    response.on('data', (chunk: Buffer | string) => {
      if (settled) return;
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      // Check before retaining: this is what keeps the buffer bounded.
      if (total + buffer.byteLength > maxBytes) {
        fail();
        return;
      }
      total += buffer.byteLength;
      chunks.push(buffer);
    });

    response.on('error', (error: Error) => {
      if (settled) return;
      settled = true;
      rejectPromise(
        new LlmError('invalid_response', 'Response stream failed', {
          providerId: 'gemini',
          cause: error,
        }),
      );
    });

    response.on('end', () => {
      if (settled) return;
      settled = true;
      resolvePromise(Buffer.concat(chunks).toString('utf8'));
    });
  });
}

/**
 * Builds the production transport. Opens nothing until a call is made.
 *
 * There is deliberately no option for a proxy, a custom agent, a dispatcher,
 * a redirect policy or a caller-supplied host. Those absences are the security
 * property, not an oversight (Section 11.6.9).
 */
export function createGeminiTransport(config: GeminiTransportConfig): GeminiTransport {
  const { apiKey } = config;

  return {
    async send(url, init) {
      // Origin assertion before any I/O. A mismatch is a programming error in
      // the caller, not a vendor response, so it never reaches the network.
      let parsed: URL;
      try {
        parsed = new URL(url);
      } catch {
        throw new LlmError('invalid_response', 'Transport received an unparseable URL', {
          providerId: 'gemini',
        });
      }
      if (parsed.origin !== GEMINI_ORIGIN) {
        throw new LlmError('invalid_response', 'Transport refused a non-Gemini origin', {
          providerId: 'gemini',
        });
      }

      const timeoutSignal =
        config.timeoutMs === undefined ? undefined : AbortSignal.timeout(config.timeoutMs);
      const signal =
        timeoutSignal === undefined ? init.signal : AbortSignal.any([init.signal, timeoutSignal]);

      return new Promise<{ status: number; body: string }>((resolvePromise, rejectPromise) => {
        let settled = false;

        const finish = (fn: () => void): void => {
          if (settled) return;
          settled = true;
          fn();
        };

        const failWith = (error: Error): void => {
          finish(() => rejectPromise(error));
        };

        const request: ClientRequest = httpsRequest(
          {
            protocol: parsed.protocol,
            hostname: parsed.hostname,
            port: parsed.port === '' ? 443 : Number(parsed.port),
            path: `${parsed.pathname}${parsed.search}`,
            method: 'POST',
            headers: {
              ...init.headers,
              // The key is added here and nowhere else. It is never placed in
              // a message, a log line, or a propagated body (Section 11.1.4).
              'x-goog-api-key': apiKey,
              'content-length': Buffer.byteLength(init.body),
            },
            signal,
          },
          (response: IncomingMessage) => {
            const status = response.statusCode ?? 0;

            // Redirects are never followed. Following one would let a 3xx
            // move the request to a host the origin check already refused.
            if (status >= 300 && status < 400) {
              response.resume();
              response.destroy();
              failWith(
                new LlmError('invalid_response', 'Redirects are not followed', {
                  providerId: 'gemini',
                  statusCode: status,
                }),
              );
              return;
            }

            const ceiling =
              status >= 200 && status < 300 ? MAX_SUCCESS_BODY_BYTES : MAX_ERROR_BODY_BYTES;

            readBodyWithLimit(response, ceiling).then(
              (text) => finish(() => resolvePromise({ status, body: text })),
              (error: unknown) =>
                finish(() =>
                  rejectPromise(
                    error instanceof Error
                      ? error
                      : new LlmError('invalid_response', 'Response read failed', {
                          providerId: 'gemini',
                        }),
                  ),
                ),
            );
          },
        );

        request.on('error', (error: Error) => {
          // Classify by which signal fired, so a local deadline is reported as
          // a timeout rather than as an opaque abort.
          if (timeoutSignal !== undefined && timeoutSignal.aborted) {
            failWith(
              new LlmTimeoutError('Gemini request timed out', {
                providerId: 'gemini',
                cause: error,
              }),
            );
            return;
          }
          if (init.signal.aborted) {
            failWith(
              new LlmError('timeout', 'Gemini request was aborted', {
                providerId: 'gemini',
                cause: error,
              }),
            );
            return;
          }
          failWith(
            new LlmError('unavailable', 'Gemini request failed', {
              providerId: 'gemini',
              cause: error,
            }),
          );
        });

        request.end(init.body);
      });
    },
  };
}
