import type { IncomingMessage } from 'node:http';

import { ResponseTooLargeError } from '../extraction.errors.js';

/**
 * Reads a response body while enforcing a hard byte ceiling.
 *
 * The limit is enforced while streaming rather than after buffering, because a
 * `Content-Length` header is a claim the server controls: a response can declare
 * 1 KiB and then stream indefinitely. The declared length is checked first as a
 * cheap early exit, and the running total is checked on every chunk as the real
 * guarantee.
 *
 * The reader is cancelled as soon as the limit is crossed so the socket is torn
 * down instead of continuing to receive a body that will be discarded.
 */
export async function readBodyWithLimit(
  response: IncomingMessage,
  maxBytes: number,
): Promise<Uint8Array> {
  const declared = response.headers['content-length'];
  if (typeof declared === 'string') {
    const parsed = Number.parseInt(declared, 10);
    if (Number.isFinite(parsed) && parsed > maxBytes) {
      response.destroy();
      throw new ResponseTooLargeError(maxBytes);
    }
  }

  const chunks: Buffer[] = [];
  let total = 0;

  for await (const chunk of response) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
    total += buffer.byteLength;
    if (total > maxBytes) {
      response.destroy();
      throw new ResponseTooLargeError(maxBytes);
    }
    chunks.push(buffer);
  }

  return Buffer.concat(chunks);
}
