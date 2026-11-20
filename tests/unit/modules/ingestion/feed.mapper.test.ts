import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import {
  canonicalizeUrl,
  decodeXmlEntities,
  mapFeedToRecords,
  normalizeTags,
  resolveEntryUrl,
  stripHtml,
} from '../../../../src/modules/ingestion/feed/feed.mapper.js';
import { parseFeed } from '../../../../src/modules/ingestion/feed/feed.parser.js';
import type { FeedSource } from '../../../../src/modules/ingestion/sources/source.schema.js';

const FEED_URL = 'https://example.com/blog/feed.xml';

const source: FeedSource = {
  id: 'test-feed',
  name: 'Test Feed',
  url: FEED_URL,
  homepage: 'https://example.com/',
  kind: 'auto',
  enabled: true,
  defaultLanguage: 'en',
  tags: ['ai'],
  reliability: 'high',
};

function fixture(name: string): string {
  return readFileSync(new URL(`../../../fixtures/feeds/${name}`, import.meta.url), 'utf8');
}

function mapFixture(name: string) {
  return mapFeedToRecords(parseFeed(fixture(name), 'auto'), source);
}

describe('resolveEntryUrl', () => {
  it('keeps an absolute http URL unchanged', () => {
    expect(resolveEntryUrl('https://example.com/posts/a', FEED_URL)).toBe(
      'https://example.com/posts/a',
    );
  });

  it('resolves a root-relative link against the feed URL', () => {
    expect(resolveEntryUrl('/posts/a', FEED_URL)).toBe('https://example.com/posts/a');
  });

  it('resolves a path-relative link against the feed directory', () => {
    expect(resolveEntryUrl('posts/a', FEED_URL)).toBe('https://example.com/blog/posts/a');
  });

  it('resolves a protocol-relative link', () => {
    expect(resolveEntryUrl('//cdn.example.com/posts/a', FEED_URL)).toBe(
      'https://cdn.example.com/posts/a',
    );
  });

  it('rejects unsupported schemes', () => {
    for (const link of [
      'javascript:alert(1)',
      'data:text/html,hello',
      'mailto:a@example.com',
      'ftp://example.com/a',
    ]) {
      expect(resolveEntryUrl(link, FEED_URL), link).toBeUndefined();
    }
  });

  it('rejects missing, empty and unresolvable links', () => {
    expect(resolveEntryUrl(undefined, FEED_URL)).toBeUndefined();
    expect(resolveEntryUrl('', FEED_URL)).toBeUndefined();
    expect(resolveEntryUrl('   ', FEED_URL)).toBeUndefined();
    expect(resolveEntryUrl('http://', FEED_URL)).toBeUndefined();
  });
});

describe('canonicalizeUrl', () => {
  it('removes utm_* parameters', () => {
    expect(canonicalizeUrl('https://example.com/a?utm_source=x&utm_medium=y&id=1')).toBe(
      'https://example.com/a?id=1',
    );
  });

  it('removes fbclid and gclid', () => {
    expect(canonicalizeUrl('https://example.com/a?fbclid=1&gclid=2&id=3')).toBe(
      'https://example.com/a?id=3',
    );
  });

  it('removes the fragment', () => {
    expect(canonicalizeUrl('https://example.com/a#section')).toBe('https://example.com/a');
  });

  it('lowercases the hostname', () => {
    expect(canonicalizeUrl('https://Example.COM/a')).toBe('https://example.com/a');
  });

  it('drops the default port', () => {
    expect(canonicalizeUrl('https://example.com:443/a')).toBe('https://example.com/a');
    expect(canonicalizeUrl('http://example.com:80/a')).toBe('http://example.com/a');
  });

  it('preserves generic source and ref parameters', () => {
    expect(canonicalizeUrl('https://example.com/a?source=rss&ref=home')).toBe(
      'https://example.com/a?source=rss&ref=home',
    );
  });

  it('does not strip a trailing slash', () => {
    expect(canonicalizeUrl('https://example.com/a/')).toBe('https://example.com/a/');
    expect(canonicalizeUrl('https://example.com/a/')).not.toBe(
      canonicalizeUrl('https://example.com/a'),
    );
  });

  it('is idempotent', () => {
    const once = canonicalizeUrl('https://Example.com/a?utm_source=x#f');

    expect(canonicalizeUrl(once)).toBe(once);
  });
});

describe('decodeXmlEntities — named entities', () => {
  it('decodes each of the five predefined entities', () => {
    expect(decodeXmlEntities('&amp;')).toBe('&');
    expect(decodeXmlEntities('&lt;')).toBe('<');
    expect(decodeXmlEntities('&gt;')).toBe('>');
    expect(decodeXmlEntities('&quot;')).toBe('"');
    expect(decodeXmlEntities('&apos;')).toBe("'");
  });

  it('decodes the five predefined entities together', () => {
    expect(decodeXmlEntities('&amp;&lt;&gt;&quot;&apos;')).toBe('&<>"\'');
  });

  it('treats entity names as case-sensitive', () => {
    expect(decodeXmlEntities('&AMP;')).toBe('&AMP;');
    expect(decodeXmlEntities('&Amp;')).toBe('&Amp;');
    expect(decodeXmlEntities('&LT;')).toBe('&LT;');
    expect(decodeXmlEntities('&Quot;')).toBe('&Quot;');
  });

  it('does not treat &nbsp; as an XML predefined entity', () => {
    expect(decodeXmlEntities('&nbsp;')).toBe('&nbsp;');
    expect(decodeXmlEntities('a&nbsp;b')).toBe('a&nbsp;b');
  });

  it('leaves unknown entities untouched', () => {
    expect(decodeXmlEntities('&payload;')).toBe('&payload;');
    expect(decodeXmlEntities('&copy;')).toBe('&copy;');
    expect(decodeXmlEntities('&hellip;')).toBe('&hellip;');
  });

  it('does not expand DOCTYPE-style nested entities', () => {
    expect(decodeXmlEntities('&nested;')).toBe('&nested;');
  });

  it('leaves a bare ampersand alone', () => {
    expect(decodeXmlEntities('a & b')).toBe('a & b');
  });
});

describe('decodeXmlEntities — numeric character references', () => {
  it('decodes valid decimal references', () => {
    expect(decodeXmlEntities('&#65;')).toBe('A');
    expect(decodeXmlEntities('caf&#233;')).toBe('café');
  });

  it('decodes valid hexadecimal references', () => {
    expect(decodeXmlEntities('&#x41;')).toBe('A');
    expect(decodeXmlEntities('&#xE9;')).toBe('é');
    expect(decodeXmlEntities('&#X41;')).toBe('A');
  });

  it('decodes astral-plane code points', () => {
    expect(decodeXmlEntities('&#x1F600;')).toBe('\u{1F600}');
    expect(decodeXmlEntities('&#128512;')).toBe('\u{1F600}');
  });

  it('accepts the legal whitespace controls', () => {
    expect(decodeXmlEntities('&#9;')).toBe('\t');
    expect(decodeXmlEntities('&#10;')).toBe('\n');
    expect(decodeXmlEntities('&#13;')).toBe('\r');
    expect(decodeXmlEntities('&#x9;')).toBe('\t');
    expect(decodeXmlEntities('&#xA;')).toBe('\n');
    expect(decodeXmlEntities('&#xD;')).toBe('\r');
  });

  it('accepts the boundaries of the legal ranges', () => {
    expect(decodeXmlEntities('&#x20;')).toBe(' ');
    expect(decodeXmlEntities('&#xD7FF;')).toBe('\u{D7FF}');
    expect(decodeXmlEntities('&#xE000;')).toBe('\u{E000}');
    expect(decodeXmlEntities('&#xFFFD;')).toBe('\u{FFFD}');
    expect(decodeXmlEntities('&#x10000;')).toBe('\u{10000}');
    expect(decodeXmlEntities('&#x10FFFF;')).toBe('\u{10FFFF}');
  });

  it('leaves zero unchanged', () => {
    expect(decodeXmlEntities('&#0;')).toBe('&#0;');
    expect(decodeXmlEntities('&#x0;')).toBe('&#x0;');
  });

  it('leaves invalid control characters unchanged', () => {
    for (const reference of ['&#1;', '&#8;', '&#11;', '&#12;', '&#31;', '&#x1F;']) {
      expect(decodeXmlEntities(reference), reference).toBe(reference);
    }
  });

  it('leaves surrogate code points unchanged', () => {
    expect(decodeXmlEntities('&#xD800;')).toBe('&#xD800;');
    expect(decodeXmlEntities('&#xDBFF;')).toBe('&#xDBFF;');
    expect(decodeXmlEntities('&#xDC00;')).toBe('&#xDC00;');
    expect(decodeXmlEntities('&#xDFFF;')).toBe('&#xDFFF;');
  });

  it('leaves non-characters at the top of the BMP unchanged', () => {
    expect(decodeXmlEntities('&#xFFFE;')).toBe('&#xFFFE;');
    expect(decodeXmlEntities('&#xFFFF;')).toBe('&#xFFFF;');
  });

  it('leaves values above 0x10FFFF unchanged', () => {
    expect(decodeXmlEntities('&#x110000;')).toBe('&#x110000;');
    expect(decodeXmlEntities('&#1114112;')).toBe('&#1114112;');
    expect(decodeXmlEntities('&#xFFFFFFFF;')).toBe('&#xFFFFFFFF;');
  });

  it('never emits a lone surrogate for an invalid reference', () => {
    const output = decodeXmlEntities('&#xD800;');

    expect(output).toBe('&#xD800;');
    for (const unit of output) {
      expect(unit.codePointAt(0)).not.toBe(0xd800);
    }
  });

  it('never emits a lone surrogate for any invalid reference', () => {
    // Well-formed UTF-16 never contains an unpaired surrogate.
    const hasLoneSurrogate = (value: string): boolean =>
      /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(value);

    for (const reference of ['&#xD800;', '&#xDFFF;', '&#55296;', '&#0;', '&#xFFFE;']) {
      const output = decodeXmlEntities(reference);

      expect(hasLoneSurrogate(output), reference).toBe(false);
    }
  });
});

describe('stripHtml', () => {
  it('removes tags and collapses whitespace', () => {
    expect(stripHtml('<p>Hello   <b>world</b></p>')).toBe('Hello world');
  });

  it('decodes entities before stripping tags', () => {
    expect(stripHtml('&lt;p&gt;Entity markup&lt;/p&gt;')).toBe('Entity markup');
  });

  it('drops script and style content', () => {
    expect(stripHtml('<script>alert(1)</script>Visible')).toBe('Visible');
    expect(stripHtml('<style>a{}</style>Visible')).toBe('Visible');
  });

  it('returns an empty string for markup-only input', () => {
    expect(stripHtml('<p></p>')).toBe('');
  });
});

describe('normalizeTags', () => {
  it('sorts ascending by UTF-16 code unit', () => {
    expect(normalizeTags(['Research', 'AI'])).toEqual(['AI', 'Research']);
  });

  it('uses code-unit ordering, not locale collation', () => {
    // Code-unit order places 'z' before 'ä'; localeCompare would reverse them.
    expect(normalizeTags(['ä', 'z'])).toEqual(['z', 'ä']);
  });

  it('preserves duplicates', () => {
    expect(normalizeTags(['AI', 'AI', 'Research'])).toEqual(['AI', 'AI', 'Research']);
  });

  it('does not mutate the input', () => {
    const input = ['b', 'a'];
    normalizeTags(input);

    expect(input).toEqual(['b', 'a']);
  });
});

describe('mapFeedToRecords — URLs', () => {
  it('preserves the original URL and resolves it', () => {
    const [record] = mapFixture('rss-sample.xml').records;

    expect(record?.url).toBe('https://example.com/posts/first');
    expect(record?.resolvedUrl).toBe('https://example.com/posts/first');
  });

  it('derives canonicalUrl from the resolved URL', () => {
    const record = mapFixture('rss-sample.xml').records[1];

    expect(record?.url).toBe(
      'https://example.com/posts/second?utm_source=rss&utm_medium=feed&id=2',
    );
    expect(record?.canonicalUrl).toBe('https://example.com/posts/second?id=2');
  });

  it('resolves relative, root-relative and protocol-relative links', () => {
    const { records } = mapFixture('relative-links.xml');

    expect(records[0]?.resolvedUrl).toBe('https://example.com/posts/absolute');
    expect(records[1]?.resolvedUrl).toBe('https://example.com/posts/root-relative');
    expect(records[1]?.url).toBe('/posts/root-relative');
    expect(records[2]?.resolvedUrl).toBe('https://example.com/blog/posts/path-relative');
    expect(records[3]?.resolvedUrl).toBe('https://cdn.example.com/posts/protocol-relative');
  });

  it('skips entries with unsupported schemes and empty or missing links', () => {
    const { records, skippedCount } = mapFixture('relative-links.xml');

    expect(records).toHaveLength(4);
    expect(skippedCount).toBe(5);
  });

  it('skips individual entries without failing the whole feed', () => {
    const { records } = mapFixture('relative-links.xml');

    // Valid entries on both sides of the invalid ones survive.
    expect(records.map((record) => record.url)).not.toContain('javascript:alert(1)');
    expect(records.every((record) => record.resolvedUrl.startsWith('https://'))).toBe(true);
  });

  it('never produces a record from a non-http URL', () => {
    const { records } = mapFixture('relative-links.xml');

    for (const record of records) {
      expect(['http:', 'https:']).toContain(new URL(record.resolvedUrl).protocol);
    }
  });
});

describe('mapFeedToRecords — dates', () => {
  it('parses a valid publication date to ISO UTC', () => {
    const [record] = mapFixture('rss-sample.xml').records;

    expect(record?.publishedAt).toBe('2026-11-19T10:00:00.000Z');
    expect(record?.publishedAtIsEstimated).toBe(false);
  });

  it('preserves the raw date string', () => {
    const [record] = mapFixture('rss-sample.xml').records;

    expect(record?.publishedAtRaw).toBe('Wed, 19 Nov 2026 10:00:00 GMT');
  });

  it('sets publishedAt to null when the date is missing', () => {
    const record = mapFixture('rss-sample.xml').records[2];

    expect(record?.publishedAt).toBeNull();
    expect(record?.publishedAtIsEstimated).toBe(true);
  });

  it('never substitutes a run timestamp for a missing date', () => {
    const record = mapFixture('rss-sample.xml').records[2];

    expect(record?.publishedAt).toBeNull();
  });

  it('does not invent a date for an unparseable value', () => {
    const xml =
      '<rss version="2.0"><channel><item><title>T</title><link>https://e.com/1</link><pubDate>not-a-date</pubDate></item></channel></rss>';
    const { records } = mapFeedToRecords(parseFeed(xml, 'auto'), source);

    expect(records[0]?.publishedAt).toBeNull();
    expect(records[0]?.publishedAtIsEstimated).toBe(true);
    expect(records[0]?.publishedAtRaw).toBe('not-a-date');
  });
});

describe('mapFeedToRecords — summaries', () => {
  it('keeps summaryRaw and summaryText distinct', () => {
    const [record] = mapFixture('rss-sample.xml').records;

    expect(record?.summaryRaw).toBe('<p>First summary with &amp; entity</p>');
    expect(record?.summaryText).toBe('First summary with & entity');
  });

  it('strips HTML from summaryText without leaving markup', () => {
    const [record] = mapFixture('rss-sample.xml').records;

    expect(record?.summaryText).not.toMatch(/<[^>]*>/);
  });

  it('omits both summary fields when the feed supplies none', () => {
    const xml =
      '<rss version="2.0"><channel><item><title>T</title><link>https://e.com/1</link></item></channel></rss>';
    const { records } = mapFeedToRecords(parseFeed(xml, 'auto'), source);

    expect(records[0]?.summaryRaw).toBeUndefined();
    expect(records[0]?.summaryText).toBeUndefined();
  });
});

describe('mapFeedToRecords — tags', () => {
  it('normalizes tags into code-unit order', () => {
    const [record] = mapFixture('rss-sample.xml').records;

    expect(record?.tags).toEqual(['AI', 'Research']);
  });

  it('produces the same tags regardless of feed order', () => {
    const forward =
      '<rss version="2.0"><channel><item><title>T</title><link>https://e.com/1</link><category>AI</category><category>Research</category></item></channel></rss>';
    const reverse =
      '<rss version="2.0"><channel><item><title>T</title><link>https://e.com/1</link><category>Research</category><category>AI</category></item></channel></rss>';

    const a = mapFeedToRecords(parseFeed(forward, 'auto'), source).records[0];
    const b = mapFeedToRecords(parseFeed(reverse, 'auto'), source).records[0];

    expect(a?.tags).toEqual(b?.tags);
  });

  it('preserves duplicate tags', () => {
    const xml =
      '<rss version="2.0"><channel><item><title>T</title><link>https://e.com/1</link><category>AI</category><category>AI</category></item></channel></rss>';
    const { records } = mapFeedToRecords(parseFeed(xml, 'auto'), source);

    expect(records[0]?.tags).toEqual(['AI', 'AI']);
  });

  it('omits tags when no categories are supplied', () => {
    const record = mapFixture('rss-sample.xml').records[2];

    expect(record?.tags).toBeUndefined();
  });

  it('does not produce an empty tags array', () => {
    const { records } = mapFixture('rss-sample.xml');

    expect(records.every((record) => record.tags === undefined || record.tags.length > 0)).toBe(
      true,
    );
  });
});

describe('mapFeedToRecords — metadata and determinism', () => {
  it('carries sourceId, guid, author, language and image URL', () => {
    const [record] = mapFixture('rss-sample.xml').records;

    expect(record?.sourceId).toBe('test-feed');
    expect(record?.guid).toBe('post-1');
    expect(record?.author).toBe('Alice');
    expect(record?.language).toBe('en');
    expect(record?.imageUrl).toBe('https://example.com/images/first.png');
  });

  it('falls back to the source default language', () => {
    const xml =
      '<rss version="2.0"><channel><item><title>T</title><link>https://e.com/1</link></item></channel></rss>';
    const { records } = mapFeedToRecords(parseFeed(xml, 'auto'), source);

    expect(records[0]?.language).toBe('en');
  });

  it('does not include fetchedAt on a record', () => {
    const [record] = mapFixture('rss-sample.xml').records;

    expect(record).not.toHaveProperty('fetchedAt');
  });

  it('maps the same feed to identical records twice', () => {
    const first = mapFixture('rss-sample.xml');
    const second = mapFixture('rss-sample.xml');

    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
  });

  it('maps Atom entries with resolved links and metadata', () => {
    const atomSource: FeedSource = { ...source, url: 'https://example.org/feed.xml' };
    const { records } = mapFeedToRecords(parseFeed(fixture('atom-sample.xml'), 'auto'), atomSource);

    expect(records).toHaveLength(2);
    expect(records[0]?.url).toBe('https://example.org/entries/one');
    expect(records[0]?.guid).toBe('tag:example.org,2026:entry-1');
    expect(records[0]?.tags).toEqual(['AI', 'Research']);
    expect(records[1]?.resolvedUrl).toBe('https://example.org/entries/two');
    expect(records[1]?.url).toBe('/entries/two');
  });
});
