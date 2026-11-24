import { isIPv4, isIPv6 } from 'node:net';

/**
 * Classifies IP addresses as safe or unsafe to connect to.
 *
 * ## Why this is a deny-list of ranges, not an allow-list of hosts
 *
 * The set of hosts worth extracting is unbounded — any news site on the
 * internet. The set of addresses that must never be reached from this service
 * is small, well defined and stable: loopback, private networks, link-local
 * (which carries cloud metadata endpoints), multicast and reserved space. A
 * deny-list of address ranges is therefore the only tractable shape.
 *
 * ## Two traps this module exists to avoid
 *
 * 1. `new URL('http://[::1]/').hostname` is `'[::1]'` — **with** brackets — and
 *    `net.isIP('[::1]')` returns `0`. A guard that classifies the raw hostname
 *    therefore treats every IPv6 literal as a hostname and lets it through.
 *    `stripIpv6Brackets` is mandatory before classification.
 * 2. `new URL('http://[::ffff:127.0.0.1]/').hostname` is `'[::ffff:7f00:1]'` —
 *    the dotted quad is gone, replaced by hex groups. A guard that only matches
 *    `::ffff:a.b.c.d` misses it. `decodeIpv4Mapped` handles both spellings.
 */

/** Result of classifying one address. */
export interface IpVerdict {
  safe: boolean;
  /** Short machine-readable reason, used in logs and failure messages. */
  reason?: string;
}

const SAFE: IpVerdict = { safe: true };

function deny(reason: string): IpVerdict {
  return { safe: false, reason };
}

/**
 * Removes the brackets `URL` keeps around an IPv6 hostname.
 *
 * Exported because the DNS pinning path needs the same normalisation: a
 * bracketed literal must never reach `dns.lookup`, and must never be handed to
 * `net.isIP` unmodified.
 */
export function stripIpv6Brackets(hostname: string): string {
  if (hostname.startsWith('[') && hostname.endsWith(']')) {
    return hostname.slice(1, -1);
  }
  return hostname;
}

/**
 * Drops an IPv6 zone identifier (`%eth0`, or `%25eth0` when still URL-encoded).
 *
 * A zone identifier selects a local interface, so an address carrying one is by
 * definition link-local or site-local. It is stripped rather than rejected so
 * the remaining address is classified normally — and that classification will
 * deny it. Returning "unsafe" here directly would also be correct, but stripping
 * keeps a single source of truth for range decisions.
 */
export function stripZoneId(address: string): string {
  const percent = address.indexOf('%');
  return percent === -1 ? address : address.slice(0, percent);
}

/**
 * Decodes an IPv4-mapped IPv6 address to its IPv4 form.
 *
 * Accepts both spellings the runtime can produce:
 * - `::ffff:127.0.0.1` (as written in configuration or DNS)
 * - `::ffff:7f00:1` (as `URL` normalises it)
 *
 * Returns `null` for anything that is not IPv4-mapped, so the caller can fall
 * through to plain IPv6 classification.
 */
export function decodeIpv4Mapped(address: string): string | null {
  const lower = address.toLowerCase();

  const dotted = /^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(lower);
  if (dotted?.[1] !== undefined) {
    return dotted[1];
  }

  const hex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(lower);
  if (hex?.[1] !== undefined && hex[2] !== undefined) {
    const high = Number.parseInt(hex[1], 16);
    const low = Number.parseInt(hex[2], 16);
    return [(high >> 8) & 0xff, high & 0xff, (low >> 8) & 0xff, low & 0xff].join('.');
  }

  return null;
}

function ipv4ToInt(address: string): number {
  const parts = address.split('.').map((part) => Number.parseInt(part, 10));
  const [a, b, c, d] = parts;
  return ((a ?? 0) << 24) + ((b ?? 0) << 16) + ((c ?? 0) << 8) + (d ?? 0);
}

function inIpv4Range(value: number, cidr: string): boolean {
  const [base, bitsRaw] = cidr.split('/');
  const bits = Number.parseInt(bitsRaw ?? '32', 10);
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return (value & mask) >>> 0 === (ipv4ToInt(base ?? '0.0.0.0') & mask) >>> 0;
}

/**
 * IPv4 ranges that must never be reached.
 *
 * `169.254.0.0/16` is the important one: every major cloud exposes instance
 * metadata there, so reaching it turns an article fetch into a credential leak.
 */
const UNSAFE_IPV4: ReadonlyArray<readonly [string, string]> = [
  ['0.0.0.0/8', 'this-network'],
  ['10.0.0.0/8', 'private'],
  ['100.64.0.0/10', 'cgnat'],
  ['127.0.0.0/8', 'loopback'],
  ['169.254.0.0/16', 'link-local'],
  ['172.16.0.0/12', 'private'],
  ['192.0.0.0/24', 'protocol-assignment'],
  ['192.0.2.0/24', 'documentation'],
  ['192.168.0.0/16', 'private'],
  ['198.18.0.0/15', 'benchmarking'],
  ['198.51.100.0/24', 'documentation'],
  ['203.0.113.0/24', 'documentation'],
  ['224.0.0.0/4', 'multicast'],
  ['240.0.0.0/4', 'reserved'],
];

function classifyIpv4(address: string): IpVerdict {
  if (!isIPv4(address)) {
    return deny('malformed-ipv4');
  }
  if (address === '255.255.255.255') {
    return deny('broadcast');
  }
  const value = ipv4ToInt(address);
  for (const [cidr, reason] of UNSAFE_IPV4) {
    if (inIpv4Range(value, cidr)) {
      return deny(reason);
    }
  }
  return SAFE;
}

/**
 * IPv6 prefixes that must never be reached.
 *
 * Only the well-known ranges are listed. IPv6 space is vast and mostly
 * unallocated, but global unicast (`2000::/3`) is the only range a real news
 * site can occupy, so anything outside it is denied by default below.
 */
function classifyIpv6(address: string): IpVerdict {
  const lower = address.toLowerCase();

  if (lower === '::' || lower === '::0') {
    return deny('unspecified');
  }
  if (lower === '::1') {
    return deny('loopback');
  }

  // IPv4-mapped: classify the embedded address with the IPv4 rules.
  const mapped = decodeIpv4Mapped(lower);
  if (mapped !== null) {
    return classifyIpv4(mapped);
  }

  const firstGroup = Number.parseInt(lower.split(':')[0] ?? '0', 16);

  // fe80::/10 link-local
  if ((firstGroup & 0xffc0) === 0xfe80) {
    return deny('link-local');
  }
  // fec0::/10 site-local (deprecated but still routable on some networks)
  if ((firstGroup & 0xffc0) === 0xfec0) {
    return deny('site-local');
  }
  // fc00::/7 unique-local
  if ((firstGroup & 0xfe00) === 0xfc00) {
    return deny('unique-local');
  }
  // ff00::/8 multicast
  if ((firstGroup & 0xff00) === 0xff00) {
    return deny('multicast');
  }
  // 2001:db8::/32 documentation
  if (
    firstGroup === 0x2001 &&
    (Number.parseInt(lower.split(':')[1] ?? '0', 16) & 0xffff) === 0x0db8
  ) {
    return deny('documentation');
  }
  // 64:ff9b::/96 NAT64 — embeds an IPv4 address that would bypass IPv4 rules.
  if (lower.startsWith('64:ff9b:')) {
    return deny('nat64');
  }
  // Only global unicast 2000::/3 is reachable.
  if ((firstGroup & 0xe000) !== 0x2000) {
    return deny('non-global-unicast');
  }

  return SAFE;
}

/**
 * Classifies one address.
 *
 * Brackets are stripped first, so the caller may pass a value straight from
 * `URL.hostname` or from a DNS answer without pre-processing.
 *
 * A zone identifier is rejected outright rather than stripped. Stripping it and
 * classifying the remainder would allow `2606:4700::1111%eth0` — a public
 * address with a meaningless zone — and a zone has no legitimate use in an
 * article URL in the first place. Denying is both stricter and easier to reason
 * about than "the zone never changes the verdict".
 */
export function classifyIp(rawAddress: string): IpVerdict {
  const trimmed = rawAddress.trim();

  if (trimmed.includes('%')) {
    return deny('zone-identifier');
  }

  const withoutBrackets = stripIpv6Brackets(trimmed);

  if (isIPv4(withoutBrackets)) {
    return classifyIpv4(withoutBrackets);
  }
  if (isIPv6(withoutBrackets)) {
    return classifyIpv6(withoutBrackets);
  }
  return deny('not-an-ip');
}

/**
 * Classifies every address, denying the whole set if any one is unsafe.
 *
 * Checking only the first address would let a DNS answer of
 * `[public, 127.0.0.1]` through, because Node connects to the first entry. The
 * decision must therefore be made over the entire answer before any address is
 * handed to the socket.
 */
export function classifyAll(rawAddresses: readonly string[]): IpVerdict {
  if (rawAddresses.length === 0) {
    return deny('no-addresses');
  }
  for (const address of rawAddresses) {
    const verdict = classifyIp(address);
    if (!verdict.safe) {
      return deny(`${verdict.reason ?? 'unsafe'}:${address}`);
    }
  }
  return SAFE;
}

/** True when the string is an IP literal rather than a hostname. */
export function isIpLiteral(rawHostname: string): boolean {
  const stripped = stripZoneId(stripIpv6Brackets(rawHostname.trim()));
  return isIPv4(stripped) || isIPv6(stripped);
}

/** Family of an IP literal, for building a `dns.LookupAddress`. */
export function ipFamily(rawAddress: string): 4 | 6 {
  const stripped = stripZoneId(stripIpv6Brackets(rawAddress.trim()));
  return isIPv6(stripped) ? 6 : 4;
}
