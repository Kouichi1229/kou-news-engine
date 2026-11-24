import type { Server } from 'node:http';

import type { Express } from 'express';

import { logger } from './core/logger.js';

export interface RunningServer {
  server: Server;
  close: () => Promise<void>;
  /**
   * Closes connections that are idle, i.e. between requests.
   *
   * Stops idle keep-alive sockets from holding the listener open. It does not
   * affect requests in flight, and it is not a cancellation mechanism: a handler
   * that is still running keeps running.
   */
  closeIdleConnections: () => void;
  /**
   * Closes every open connection, including those serving a request.
   *
   * This tears down sockets only. It is not application-level cancellation: a
   * handler that has already started continues to run to completion, so this
   * says nothing about whether in-flight work has finished.
   */
  closeAllConnections: () => void;
}

export function startServer(app: Express, port: number, host: string): Promise<RunningServer> {
  return new Promise((resolve, reject) => {
    const server = app.listen(port, host);

    server.once('error', reject);
    server.once('listening', () => {
      logger.info('Server listening', { host, port });

      // Cached so repeated calls reuse the first attempt. A second
      // `server.close()` would reject with ERR_SERVER_NOT_RUNNING, and retrying
      // after a failure is unsafe once the listener's state is unknown — so a
      // failed close keeps reporting the original error instead of trying again.
      let closePromise: Promise<void> | undefined;
      const close = (): Promise<void> => {
        closePromise ??= new Promise<void>((closeResolve, closeReject) => {
          server.close((err) => {
            if (err) {
              closeReject(err);
              return;
            }
            closeResolve();
          });
        });

        return closePromise;
      };

      const closeIdleConnections = (): void => {
        server.closeIdleConnections();
      };

      const closeAllConnections = (): void => {
        server.closeAllConnections();
      };

      resolve({ server, close, closeIdleConnections, closeAllConnections });
    });
  });
}
