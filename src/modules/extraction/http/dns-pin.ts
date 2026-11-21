import { lookup as dnsLookup } from 'node:dns';

import { UnsafeUrlError } from '../extraction.errors.js';

import { classifyAll, ipFamily, isIpLiteral, stripIpv6Brackets, stripZoneId } from './ip-guard.js';
import type { LookupFunction } from './lookup.types.js';

/** DNS resolution seam, so tests can answer without touching the resolver. */
export type ResolveFunction = (
  hostname: string,
  options: { all: true },
  callback: (
    err: NodeJS.ErrnoException | null,
    addresses: Array<{ address: string; family: number }>,
  ) => void,
) => void;

const defaultResolve: ResolveFunction = (hostname, options, callback) => {
  dnsLookup(hostname, options, (err, addresses) => {
    callback(err, addresses);
  });
};

/** An address chosen for the socket, with the family `lookup` must report. */
export interface PinnedAddress {
  address: string;
  family: 4 | 6;
}

/**
 * The result of validating one URL's destination.
 *
 * `hostname` is what the `Host` header and TLS SNI must use. `pinned` is what
 * the socket must connect to. Keeping them separate is the whole point: the
 * connection is pinned, the identity is not.
 */
export interface PinnedTarget {
  /** Original hostname, without IPv6 brackets. Used for Host and SNI. */
  hostname: string;
  /** The single validated address the socket may use. */
  pinned: PinnedAddress;
  /** Every address the resolver returned, already validated. */
  allAddresses: readonly PinnedAddress[];
}

/**
 * Resolves a hostname and validates every address it maps to.
 *
 * ## Why the whole answer is checked
 *
 * Node connects to the **first** entry of the array a `lookup` callback returns.
 * A resolver answering `[8.8.8.8, 127.0.0.1]` would therefore connect to the
 * public address today — but the ordering is the resolver's choice, not a
 * guarantee, and a hostile or compromised resolver controls it. Rejecting the
 * entire answer when any member is unsafe removes the dependency on ordering.
 *
 * ## Why an IP literal skips DNS
 *
 * There is nothing to resolve, and resolving anyway would be a second chance for
 * an attacker to substitute an address. The literal is classified directly.
 *
 * @throws UnsafeUrlError when any resolved address is unsafe, or the answer is empty.
 */
export async function resolveAndValidate(
  rawHostname: string,
  resolve: ResolveFunction = defaultResolve,
  allowPrivateAddresses = false,
): Promise<PinnedTarget> {
  const hostname = stripZoneId(stripIpv6Brackets(rawHostname.trim()));

  if (hostname === '') {
    throw new UnsafeUrlError('INVALID_URL', 'URL has an empty hostname');
  }

  if (isIpLiteral(hostname)) {
    const verdict = classifyAll([hostname]);
    if (!verdict.safe && !allowPrivateAddresses) {
      throw new UnsafeUrlError(
        'SSRF_BLOCKED',
        `Refusing to connect to ${hostname}: ${verdict.reason ?? 'unsafe'}`,
      );
    }
    const pinned: PinnedAddress = { address: hostname, family: ipFamily(hostname) };
    return { hostname, pinned, allAddresses: [pinned] };
  }

  const addresses = await new Promise<PinnedAddress[]>((resolvePromise, rejectPromise) => {
    resolve(hostname, { all: true }, (err, result) => {
      if (err) {
        rejectPromise(new UnsafeUrlError('DNS_FAILURE', `DNS lookup failed for ${hostname}`));
        return;
      }
      resolvePromise(
        result.map((entry) => ({ address: entry.address, family: entry.family === 6 ? 6 : 4 })),
      );
    });
  });

  const verdict = classifyAll(addresses.map((entry) => entry.address));
  if (!verdict.safe && !allowPrivateAddresses) {
    throw new UnsafeUrlError(
      'SSRF_BLOCKED',
      `Refusing to connect to ${hostname}: ${verdict.reason ?? 'unsafe'}`,
    );
  }

  const first = addresses[0];
  if (first === undefined) {
    throw new UnsafeUrlError('DNS_FAILURE', `DNS returned no addresses for ${hostname}`);
  }

  return { hostname, pinned: first, allAddresses: addresses };
}

/**
 * Builds the `lookup` callback handed to `http.request`/`https.request`.
 *
 * The returned function ignores its `hostname` argument and answers from the
 * closure. That is deliberate: it must never call `dns.lookup`, because a second
 * resolution is exactly the window a DNS-rebinding attack needs. The address was
 * validated once, immediately before the request, and this closure is the only
 * thing the socket can learn.
 *
 * The `all` flag is honoured because Node 24 passes `all: true`; answering with
 * a bare string in that case fails with `ERR_INVALID_IP_ADDRESS`.
 */
export function createPinnedLookup(pinned: PinnedAddress): LookupFunction {
  return (_hostname, options, callback) => {
    if (options.all === true) {
      callback(null, [{ address: pinned.address, family: pinned.family }]);
      return;
    }
    callback(null, pinned.address, pinned.family);
  };
}
