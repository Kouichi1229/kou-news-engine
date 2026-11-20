import { describe, expect, it } from 'vitest';

import { canonicalizeUrl } from '../../../../../src/modules/ingestion/dedupe/canonical-url.js';

describe('canonicalizeUrl', () => {
  it('removes utm_* parameters', () => {
    expect(canonicalizeUrl('https://example.com/a?utm_source=x&utm_medium=y&id=1')).toBe(
      'https://example.com/a?id=1',
    );
  });

  it('removes a utm_ parameter that has an empty value', () => {
    expect(canonicalizeUrl('https://example.com/a?utm_=x&id=1')).toBe('https://example.com/a?id=1');
  });

  it('removes fbclid and gclid', () => {
    expect(canonicalizeUrl('https://example.com/a?fbclid=1&gclid=2&id=3')).toBe(
      'https://example.com/a?id=3',
    );
  });

  it('matches tracking parameters case-insensitively', () => {
    expect(canonicalizeUrl('https://example.com/a?UTM_Source=x&FBCLID=2&id=3')).toBe(
      'https://example.com/a?id=3',
    );
  });

  it('does not remove a parameter that merely ends with a tracking name', () => {
    expect(canonicalizeUrl('https://example.com/a?xutm_source=1')).toBe(
      'https://example.com/a?xutm_source=1',
    );
  });

  it('removes the fragment', () => {
    expect(canonicalizeUrl('https://example.com/a#section')).toBe('https://example.com/a');
  });

  it('lowercases the hostname but not the path', () => {
    expect(canonicalizeUrl('https://Example.COM/Path')).toBe('https://example.com/Path');
  });

  it('drops the default https port', () => {
    expect(canonicalizeUrl('https://example.com:443/a')).toBe('https://example.com/a');
  });

  it('drops the default http port', () => {
    expect(canonicalizeUrl('http://example.com:80/a')).toBe('http://example.com/a');
  });

  it('keeps a non-default port', () => {
    expect(canonicalizeUrl('https://example.com:8443/a')).toBe('https://example.com:8443/a');
  });

  it('preserves a trailing slash', () => {
    expect(canonicalizeUrl('https://example.com/a/')).toBe('https://example.com/a/');
  });

  it('keeps a trailing slash distinct from no trailing slash', () => {
    expect(canonicalizeUrl('https://example.com/a/')).not.toBe(
      canonicalizeUrl('https://example.com/a'),
    );
  });

  it('preserves repeated slashes inside the path', () => {
    expect(canonicalizeUrl('https://example.com/a//b')).toBe('https://example.com/a//b');
  });

  it('preserves a repeated slash after the host', () => {
    expect(canonicalizeUrl('https://example.com//a')).toBe('https://example.com//a');
  });

  it('preserves generic source and ref parameters', () => {
    expect(canonicalizeUrl('https://example.com/a?source=rss&ref=home')).toBe(
      'https://example.com/a?source=rss&ref=home',
    );
  });

  it('preserves the order of the parameters it keeps', () => {
    expect(canonicalizeUrl('https://example.com/a?b=2&a=1')).toBe('https://example.com/a?b=2&a=1');
  });

  it('is idempotent', () => {
    const once = canonicalizeUrl('https://Example.com/a?utm_source=x#f');

    expect(canonicalizeUrl(once)).toBe(once);
  });

  it('normalizes the scheme case', () => {
    expect(canonicalizeUrl('HTTPS://Example.com/a')).toBe('https://example.com/a');
  });

  it('preserves an already-encoded space', () => {
    expect(canonicalizeUrl('https://example.com/a%20b')).toBe('https://example.com/a%20b');
  });

  it('percent-encodes a non-ASCII path', () => {
    expect(canonicalizeUrl('https://example.com/ä')).toBe('https://example.com/%C3%A4');
  });

  it('normalizes an empty path to a slash', () => {
    expect(canonicalizeUrl('https://example.com')).toBe('https://example.com/');
  });

  it('throws for input that is not a URL', () => {
    expect(() => canonicalizeUrl('not a url')).toThrow(TypeError);
    expect(() => canonicalizeUrl('')).toThrow(TypeError);
  });

  it('does not validate the protocol: that is resolveEntryUrl responsibility', () => {
    // Documented precondition. Protocol rejection happens upstream in the mapper.
    expect(canonicalizeUrl('ftp://example.com/a')).toBe('ftp://example.com/a');
  });
});
