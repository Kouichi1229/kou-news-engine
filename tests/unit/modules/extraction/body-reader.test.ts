import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { afterEach, describe, expect, it } from 'vitest';

import { readBodyWithLimit } from '../../../../src/modules/extraction/http/body-reader.js';
import { ResponseTooLargeError } from '../../../../src/modules/extraction/extraction.errors.js';

const servers: Server[] = [];

/** Starts a loopback server; never reaches the network. */
async function serve(
  handler: Parameters<typeof createServer>[1],
): Promise<{ port: number; url: string }> {
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

describe('readBodyWithLimit', () => {
  it('reads a body smaller than the limit', async () => {
    const { url } = await serve((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('hello');
    });
    const response = await new Promise<import('node:http').IncomingMessage>((resolve) => {
      void import('node:http').then(({ get }) => {
        get(url, resolve);
      });
    });
    const bytes = await readBodyWithLimit(response, 1024);
    expect(Buffer.from(bytes).toString()).toBe('hello');
  });

  it('rejects a body that exceeds the limit while streaming', async () => {
    const { url } = await serve((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('x'.repeat(4096));
    });
    const response = await new Promise<import('node:http').IncomingMessage>((resolve) => {
      void import('node:http').then(({ get }) => {
        get(url, resolve);
      });
    });
    await expect(readBodyWithLimit(response, 100)).rejects.toBeInstanceOf(ResponseTooLargeError);
  });

  it('rejects on a declared Content-Length above the limit without reading the body', async () => {
    const { url } = await serve((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain', 'content-length': '999999' });
      res.write('start');
    });
    const response = await new Promise<import('node:http').IncomingMessage>((resolve) => {
      void import('node:http').then(({ get }) => {
        get(url, resolve);
      });
    });
    await expect(readBodyWithLimit(response, 100)).rejects.toBeInstanceOf(ResponseTooLargeError);
  });

  it('accepts a body exactly at the limit', async () => {
    const body = 'y'.repeat(100);
    const { url } = await serve((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end(body);
    });
    const response = await new Promise<import('node:http').IncomingMessage>((resolve) => {
      void import('node:http').then(({ get }) => {
        get(url, resolve);
      });
    });
    const bytes = await readBodyWithLimit(response, 100);
    expect(bytes.byteLength).toBe(100);
  });
});
