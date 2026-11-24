import type { LookupAddress, LookupOptions } from 'node:dns';

/**
 * The `lookup` callback Node's `net`/`http`/`https` call before connecting.
 *
 * Re-declared here rather than imported from `node:net` because that module does
 * not export it as a named type; the shape below mirrors
 * `node_modules/@types/node/net.d.ts`. The second parameter is
 * `dns.LookupOptions`, and its `all` flag decides the callback's second
 * argument:
 *
 * - `all: true`  → `LookupAddress[]`
 * - `all: false` → a single `string` plus `family`
 *
 * Node 24 passes `{ hints: 32, all: true }`, so the array form is the one that
 * actually runs in production. Returning a bare string while `all` is true
 * fails at runtime with `ERR_INVALID_IP_ADDRESS`, which is why the pinning
 * implementation branches on the flag instead of always returning one shape.
 */
export type LookupCallback = (
  err: NodeJS.ErrnoException | null,
  address: string | LookupAddress[],
  family?: number,
) => void;

/**
 * Uses Node's own `LookupOptions` rather than a hand-written structural
 * equivalent. The structural version is not assignable to `net.LookupFunction`
 * under `exactOptionalPropertyTypes`, because Node's interface declares each
 * member as `boolean | undefined` while a literal `{ all?: boolean }` does not.
 */
export type LookupFunction = (
  hostname: string,
  options: LookupOptions,
  callback: LookupCallback,
) => void;

export type { LookupAddress };
