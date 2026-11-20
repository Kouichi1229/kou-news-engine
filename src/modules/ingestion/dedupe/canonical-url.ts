/** Tracking parameters removed during canonicalization. */
const TRACKING_PARAMS = new Set(['fbclid', 'gclid']);

/**
 * Conservative URL canonicalization used as the deduplication key.
 *
 * Only tracking parameters, the fragment, hostname casing and default ports are
 * normalized. Everything else is preserved, because a false-positive merge
 * destroys information while a missed merge is only cosmetic.
 *
 * Precondition: `absoluteUrl` is an absolute http(s) URL. Protocol validation
 * belongs to `resolveEntryUrl`; this function is a normalizer, not a validator.
 */
export function canonicalizeUrl(absoluteUrl: string): string {
  const url = new URL(absoluteUrl);

  url.hash = '';
  url.hostname = url.hostname.toLowerCase();

  if (
    (url.protocol === 'http:' && url.port === '80') ||
    (url.protocol === 'https:' && url.port === '443')
  ) {
    url.port = '';
  }

  for (const key of [...url.searchParams.keys()]) {
    const lowered = key.toLowerCase();
    if (lowered.startsWith('utm_') || TRACKING_PARAMS.has(lowered)) {
      url.searchParams.delete(key);
    }
  }

  return url.href;
}
