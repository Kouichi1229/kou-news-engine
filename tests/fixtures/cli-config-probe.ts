/**
 * Child-process probe for CLI module-loading and network behaviour.
 *
 * Runs in its own Node process so module evaluation is observed from outside the
 * test runner, whose environment is already valid. The environment is supplied by
 * the caller, so an invalid configuration can be reproduced without touching the
 * runner's own process.
 *
 * Usage: node --import tsx cli-config-probe.ts <target> [cli args...]
 *
 * Targets:
 *   library             import `src/cli/ingestion.cli.ts` (no entry point runs)
 *   entry               import `src/cli/ingest.ts`
 *   extract-entry       import `src/cli/extract.ts`
 *   ingest-entry        import `src/cli/ingest.ts`
 *   network-self-check  prove the guard intercepts, using loopback only
 *
 * ## Network guard
 *
 * The guard replaces every API this project can use to leave the process, before
 * the target module is imported, and counts each intercepted call. A call is
 * counted and refused rather than performed, so a zero count is evidence that the
 * code path was never taken.
 *
 * `syncBuiltinESMExports()` is called after patching. Without it, a module that
 * bound `request` from `node:http` by name at evaluation keeps the original
 * function, and the counter stays at zero whether or not a request happened — a
 * false pass. This project's HTTP client does bind by name, so the call is
 * mandatory rather than defensive.
 *
 * The guard is a test double, not a sandbox. It proves the intercepted call sites
 * were not reached; it does not prove the process is incapable of network access.
 * Anything not listed in `NetworkCounts` is not counted.
 */
import dns from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import { syncBuiltinESMExports } from 'node:module';
import net from 'node:net';
import tls from 'node:tls';

/** Every intercepted entry point, counted separately. */
interface NetworkCounts {
  fetch: number;
  httpRequest: number;
  httpGet: number;
  httpsRequest: number;
  httpsGet: number;
  dnsLookup: number;
  dnsPromisesLookup: number;
  netConnect: number;
  tlsConnect: number;
}

const counts: NetworkCounts = {
  fetch: 0,
  httpRequest: 0,
  httpGet: 0,
  httpsRequest: 0,
  httpsGet: 0,
  dnsLookup: 0,
  dnsPromisesLookup: 0,
  netConnect: 0,
  tlsConnect: 0,
};

type CountKey = keyof NetworkCounts;

/** Counts the attempt, then refuses it. */
function deny(key: CountKey, api: string): never {
  counts[key] += 1;
  throw new Error(`NETWORK FORBIDDEN: ${api}`);
}

const originals = {
  fetch: globalThis.fetch,
  httpRequest: http.request,
  httpGet: http.get,
  httpsRequest: https.request,
  httpsGet: https.get,
  dnsLookup: dns.lookup,
  dnsPromisesLookup: dns.promises.lookup,
  netConnect: net.connect,
  netCreateConnection: net.createConnection,
  tlsConnect: tls.connect,
};

function installGuard(): void {
  globalThis.fetch = ((..._args: unknown[]): never =>
    deny('fetch', 'fetch')) as unknown as typeof globalThis.fetch;

  http.request = ((..._args: unknown[]): never =>
    deny('httpRequest', 'http.request')) as unknown as typeof http.request;
  // `get` is patched separately: it calls the module-internal `request`, not the
  // `request` property, so replacing `request` alone leaves `get` usable.
  http.get = ((..._args: unknown[]): never =>
    deny('httpGet', 'http.get')) as unknown as typeof http.get;
  https.request = ((..._args: unknown[]): never =>
    deny('httpsRequest', 'https.request')) as unknown as typeof https.request;
  https.get = ((..._args: unknown[]): never =>
    deny('httpsGet', 'https.get')) as unknown as typeof https.get;

  // DNS is a separate egress path and runs *before* a request is created, so a
  // guard covering only http/https would still let a lookup out.
  dns.lookup = ((..._args: unknown[]): never =>
    deny('dnsLookup', 'dns.lookup')) as unknown as typeof dns.lookup;
  dns.promises.lookup = ((..._args: unknown[]): never =>
    deny('dnsPromisesLookup', 'dns.promises.lookup')) as unknown as typeof dns.promises.lookup;

  net.connect = ((..._args: unknown[]): never =>
    deny('netConnect', 'net.connect')) as unknown as typeof net.connect;
  net.createConnection = ((..._args: unknown[]): never =>
    deny('netConnect', 'net.createConnection')) as unknown as typeof net.createConnection;
  tls.connect = ((..._args: unknown[]): never =>
    deny('tlsConnect', 'tls.connect')) as unknown as typeof tls.connect;

  syncBuiltinESMExports();
}

function restoreGuard(): void {
  globalThis.fetch = originals.fetch;
  http.request = originals.httpRequest;
  http.get = originals.httpGet;
  https.request = originals.httpsRequest;
  https.get = originals.httpsGet;
  dns.lookup = originals.dnsLookup;
  dns.promises.lookup = originals.dnsPromisesLookup;
  net.connect = originals.netConnect;
  net.createConnection = originals.netCreateConnection;
  tls.connect = originals.tlsConnect;

  syncBuiltinESMExports();
}

installGuard();

// Emitted on `exit`, which also runs after the target calls `process.exit`.
// A missing line is a failure in the tests, never an implicit zero.
process.on('exit', () => {
  process.stderr.write(`PROBE_FETCH_CALLS=${String(counts.fetch)}\n`);
  process.stderr.write(`PROBE_NET_COUNTS=${JSON.stringify(counts)}\n`);
});

/**
 * Two modes, chosen by `PROBE_MODE`.
 *
 * `guard` — loaded through `--import` alongside the real CLI entry point. Only the
 *   network guard is installed; the entry point supplied on the command line runs
 *   normally and is the thing being measured. Nothing is dispatched and `argv` is
 *   left untouched.
 *
 * anything else (default) — dispatch mode. The probe itself is the entry point and
 *   `argv[2]` names a module to import. This is the original behaviour, kept so
 *   `config-failure.test.ts` continues to work unchanged.
 */
const guardOnly = process.env['PROBE_MODE'] === 'guard';

const target = guardOnly ? undefined : process.argv[2];
if (!guardOnly) {
  // Forwarded to the entry point, which reads `process.argv.slice(2)`.
  process.argv = [process.argv[0] ?? 'node', process.argv[1] ?? 'probe', ...process.argv.slice(3)];
}

const modules: Record<string, string> = {
  library: '../../src/cli/ingestion.cli.js',
  entry: '../../src/cli/ingest.js',
  'extract-entry': '../../src/cli/extract.js',
  'ingest-entry': '../../src/cli/ingest.js',
};

/**
 * Proves the guard intercepts, without leaving the machine.
 *
 * A guard that never fires and a guard that could never fire look identical from
 * the counters alone. This starts a loopback server, confirms a guarded request
 * through the patched `http.request` is refused and counted, then restores the
 * original and confirms the same request succeeds — so the refusal came from the
 * guard rather than from an unreachable server.
 */
async function selfCheck(): Promise<void> {
  const { createServer } = http;
  const server = createServer((_request, response) => {
    response.end('reachable');
  });

  // Binding the listener itself resolves a name, so the guard is relaxed for the
  // setup and re-armed before the guarded attempt. Otherwise the control would
  // count its own scaffolding as the thing it is trying to detect.
  restoreGuard();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  installGuard();

  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;

  // The setup above may have been counted while the guard was relaxed; start the
  // measurement from a known point.
  for (const key of Object.keys(counts) as CountKey[]) {
    counts[key] = 0;
  }

  let guarded: string;
  try {
    // The patched export, which is what a named ESM import binds to.
    http.request({ host: '127.0.0.1', port, path: '/' });
    guarded = 'reached';
  } catch (error) {
    guarded =
      error instanceof Error && error.message.includes('NETWORK FORBIDDEN')
        ? 'blocked'
        : 'other-error';
  }

  restoreGuard();

  let unguarded: string;
  try {
    await new Promise<void>((resolve, reject) => {
      const request = http.request({ host: '127.0.0.1', port, path: '/' }, (response) => {
        response.resume();
        response.once('end', () => resolve());
      });
      request.once('error', reject);
      request.end();
    });
    unguarded = 'reached';
  } catch {
    unguarded = 'failed';
  }

  await new Promise<void>((resolve) => {
    server.close(() => resolve());
  });

  process.stderr.write(`PROBE_SELFCHECK=${guarded},${unguarded}\n`);
}

if (guardOnly) {
  // The guard is already installed above. The real entry point is about to load,
  // and its exit handler reports the counts.
} else if (target === 'network-self-check') {
  await selfCheck();
} else {
  const specifier = modules[target ?? ''];
  if (specifier === undefined) {
    process.stderr.write(`PROBE_UNKNOWN_TARGET=${String(target)}\n`);
    process.exit(64);
  }

  try {
    await import(specifier);
    process.stderr.write('PROBE_IMPORT_OK\n');
  } catch (error) {
    process.stderr.write(
      `PROBE_IMPORT_FAILED=${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exit(65);
  }
}
