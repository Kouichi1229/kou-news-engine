import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { FeedParseError, parseFeed } from '../../../../src/modules/ingestion/feed/feed.parser.js';

function fixture(name: string): string {
  return readFileSync(new URL(`../../../fixtures/feeds/${name}`, import.meta.url), 'utf8');
}

describe('parseFeed — RSS 2.0', () => {
  it('parses a valid RSS document', () => {
    const feed = parseFeed(fixture('rss-sample.xml'), 'rss');

    expect(feed.format).toBe('rss');
    expect(feed.language).toBe('en');
    expect(feed.entries).toHaveLength(3);
  });

  it('extracts RSS entry fields', () => {
    const [first] = parseFeed(fixture('rss-sample.xml'), 'rss').entries;

    expect(first?.title).toBe('First Post');
    expect(first?.link).toBe('https://example.com/posts/first');
    expect(first?.guid).toBe('post-1');
    expect(first?.publishedRaw).toBe('Wed, 19 Nov 2026 10:00:00 GMT');
    expect(first?.author).toBe('Alice');
    expect(first?.imageUrl).toBe('https://example.com/images/first.png');
  });

  it('keeps categories in feed order so the mapper can normalize them', () => {
    const [first] = parseFeed(fixture('rss-sample.xml'), 'rss').entries;

    expect(first?.categories).toEqual(['Research', 'AI']);
  });

  it('leaves entities literal when processEntities is disabled', () => {
    const [first] = parseFeed(fixture('rss-sample.xml'), 'rss').entries;

    expect(first?.summary).toBe('&lt;p&gt;First summary with &amp;amp; entity&lt;/p&gt;');
  });

  it('omits fields the feed does not supply', () => {
    const third = parseFeed(fixture('rss-sample.xml'), 'rss').entries[2];

    expect(third?.title).toBe('Third Post Without Date');
    expect(third?.publishedRaw).toBeUndefined();
    expect(third?.author).toBeUndefined();
    expect(third?.categories).toBeUndefined();
  });

  it('handles an empty feed', () => {
    const xml = '<rss version="2.0"><channel><title>Empty</title></channel></rss>';
    const feed = parseFeed(xml, 'rss');

    expect(feed.entries).toEqual([]);
  });

  it('normalizes a single entry into an array', () => {
    const xml =
      '<rss version="2.0"><channel><item><title>Only</title><link>https://e.com/1</link></item></channel></rss>';

    expect(parseFeed(xml, 'rss').entries).toHaveLength(1);
  });
});

describe('parseFeed — Atom', () => {
  it('parses a valid Atom document', () => {
    const feed = parseFeed(fixture('atom-sample.xml'), 'atom');

    expect(feed.format).toBe('atom');
    expect(feed.language).toBe('en');
    expect(feed.entries).toHaveLength(2);
  });

  it('extracts the alternate link href', () => {
    const [first] = parseFeed(fixture('atom-sample.xml'), 'atom').entries;

    expect(first?.link).toBe('https://example.org/entries/one');
  });

  it('uses the enclosure link as the image URL', () => {
    const [first] = parseFeed(fixture('atom-sample.xml'), 'atom').entries;

    expect(first?.imageUrl).toBe('https://example.org/images/one.png');
  });

  it('maps the Atom id to guid and the author name to author', () => {
    const [first] = parseFeed(fixture('atom-sample.xml'), 'atom').entries;

    expect(first?.guid).toBe('tag:example.org,2026:entry-1');
    expect(first?.author).toBe('Bob');
  });

  it('prefers published over updated', () => {
    const [first] = parseFeed(fixture('atom-sample.xml'), 'atom').entries;

    expect(first?.publishedRaw).toBe('2026-11-19T10:00:00Z');
  });

  it('falls back to updated when published is absent', () => {
    const second = parseFeed(fixture('atom-sample.xml'), 'atom').entries[1];

    expect(second?.publishedRaw).toBe('2026-11-20T08:00:00Z');
  });

  it('reads category term attributes', () => {
    const [first] = parseFeed(fixture('atom-sample.xml'), 'atom').entries;

    expect(first?.categories).toEqual(['Research', 'AI']);
  });

  it('keeps a relative href verbatim for the mapper to resolve', () => {
    const second = parseFeed(fixture('atom-sample.xml'), 'atom').entries[1];

    expect(second?.link).toBe('/entries/two');
  });

  it('ignores xml:base', () => {
    const feed = parseFeed(fixture('atom-sample.xml'), 'atom');

    expect(feed.entries[1]?.link).toBe('/entries/two');
  });
});

describe('parseFeed — auto detection', () => {
  it('detects RSS from the document root', () => {
    expect(parseFeed(fixture('rss-sample.xml'), 'auto').format).toBe('rss');
  });

  it('detects Atom from the document root', () => {
    expect(parseFeed(fixture('atom-sample.xml'), 'auto').format).toBe('atom');
  });

  it('does not use the URL to detect format', () => {
    // An RSS document with an Atom-looking filename still parses as RSS.
    const feed = parseFeed(fixture('rss-sample.xml'), 'auto');

    expect(feed.format).toBe('rss');
  });

  it('rejects a document whose root is neither rss nor feed', () => {
    const xml = '<html><body><p>Not a feed</p></body></html>';

    expect(() => parseFeed(xml, 'auto')).toThrow(FeedParseError);
    expect(() => parseFeed(xml, 'auto')).toThrow(/neither <rss> nor <feed>/);
  });
});

describe('parseFeed — kind mismatch', () => {
  it('rejects an RSS document declared as atom', () => {
    expect(() => parseFeed(fixture('rss-sample.xml'), 'atom')).toThrow(/indicates rss/);
  });

  it('rejects an Atom document declared as rss', () => {
    expect(() => parseFeed(fixture('atom-sample.xml'), 'rss')).toThrow(/indicates atom/);
  });

  it('reports the FORMAT_MISMATCH code', () => {
    try {
      parseFeed(fixture('rss-sample.xml'), 'atom');
      expect.unreachable('should have thrown');
    } catch (error) {
      expect((error as FeedParseError).code).toBe('FORMAT_MISMATCH');
    }
  });
});

describe('parseFeed — Atom namespaces', () => {
  const DEFAULT_NS_ATOM = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom" xml:lang="en">
  <title>Default NS Feed</title>
  <entry>
    <id>tag:example.org,2026:ns-1</id>
    <title>Default Entry</title>
    <link rel="alternate" href="https://example.org/entries/ns-1"/>
    <link rel="enclosure" href="https://example.org/images/ns-1.png"/>
    <published>2026-11-19T10:00:00Z</published>
    <updated>2026-11-19T11:00:00Z</updated>
    <summary>Default summary</summary>
    <author><name>Carol</name></author>
    <category term="Research"/>
    <category term="AI"/>
  </entry>
</feed>`;

  const PREFIXED_ATOM = `<?xml version="1.0" encoding="UTF-8"?>
<atom:feed xmlns:atom="http://www.w3.org/2005/Atom" xml:lang="en">
  <atom:title>Prefixed Feed</atom:title>
  <atom:entry>
    <atom:id>tag:example.org,2026:ns-1</atom:id>
    <atom:title>Default Entry</atom:title>
    <atom:link rel="alternate" href="https://example.org/entries/ns-1"/>
    <atom:link rel="enclosure" href="https://example.org/images/ns-1.png"/>
    <atom:published>2026-11-19T10:00:00Z</atom:published>
    <atom:updated>2026-11-19T11:00:00Z</atom:updated>
    <atom:summary>Default summary</atom:summary>
    <atom:author><atom:name>Carol</atom:name></atom:author>
    <atom:category term="Research"/>
    <atom:category term="AI"/>
  </atom:entry>
</atom:feed>`;

  it('parses a default-namespace Atom feed', () => {
    const feed = parseFeed(DEFAULT_NS_ATOM, 'auto');

    expect(feed.format).toBe('atom');
    expect(feed.language).toBe('en');
    expect(feed.entries).toHaveLength(1);
  });

  it('parses a prefixed Atom feed', () => {
    const feed = parseFeed(PREFIXED_ATOM, 'auto');

    expect(feed.format).toBe('atom');
    expect(feed.language).toBe('en');
    expect(feed.entries).toHaveLength(1);
  });

  it('parses prefixed entries, links, ids, categories, summaries and dates', () => {
    const [entry] = parseFeed(PREFIXED_ATOM, 'auto').entries;

    expect(entry?.title).toBe('Default Entry');
    expect(entry?.link).toBe('https://example.org/entries/ns-1');
    expect(entry?.imageUrl).toBe('https://example.org/images/ns-1.png');
    expect(entry?.guid).toBe('tag:example.org,2026:ns-1');
    expect(entry?.summary).toBe('Default summary');
    expect(entry?.publishedRaw).toBe('2026-11-19T10:00:00Z');
    expect(entry?.author).toBe('Carol');
    expect(entry?.categories).toEqual(['Research', 'AI']);
  });

  it('produces identical results for both namespace forms', () => {
    const fromDefault = parseFeed(DEFAULT_NS_ATOM, 'auto');
    const fromPrefixed = parseFeed(PREFIXED_ATOM, 'auto');

    expect(fromPrefixed).toEqual(fromDefault);
  });

  it('detects both supported forms under auto', () => {
    expect(parseFeed(DEFAULT_NS_ATOM, 'auto').format).toBe('atom');
    expect(parseFeed(PREFIXED_ATOM, 'auto').format).toBe('atom');
  });

  it('accepts either form when atom is declared explicitly', () => {
    expect(parseFeed(DEFAULT_NS_ATOM, 'atom').format).toBe('atom');
    expect(parseFeed(PREFIXED_ATOM, 'atom').format).toBe('atom');
  });

  it('rejects a feed root bound to a non-Atom namespace', () => {
    const xml = '<feed xmlns="http://example.com/not-atom"><entry><title>T</title></entry></feed>';

    expect(() => parseFeed(xml, 'auto')).toThrow(FeedParseError);
  });

  it('reports UNKNOWN_FORMAT for a wrong namespace', () => {
    const xml = '<feed xmlns="http://example.com/not-atom"><entry><title>T</title></entry></feed>';

    try {
      parseFeed(xml, 'auto');
      expect.unreachable('should have thrown');
    } catch (error) {
      expect((error as FeedParseError).code).toBe('UNKNOWN_FORMAT');
      expect((error as FeedParseError).message).toMatch(/not the Atom namespace/);
    }
  });

  it('rejects a prefixed feed bound to a non-Atom namespace', () => {
    const xml = '<atom:feed xmlns:atom="http://example.com/not-atom"><atom:entry/></atom:feed>';

    expect(() => parseFeed(xml, 'auto')).toThrow(/not the Atom namespace/);
  });

  it('rejects an Atom-looking document that is actually RSS', () => {
    expect(() => parseFeed(fixture('rss-sample.xml'), 'atom')).toThrow(/indicates rss/);
  });

  it('reports FORMAT_MISMATCH for explicit atom kind on RSS', () => {
    try {
      parseFeed(fixture('rss-sample.xml'), 'atom');
      expect.unreachable('should have thrown');
    } catch (error) {
      expect((error as FeedParseError).code).toBe('FORMAT_MISMATCH');
    }
  });

  it('reports FORMAT_MISMATCH for explicit rss kind on Atom', () => {
    try {
      parseFeed(DEFAULT_NS_ATOM, 'rss');
      expect.unreachable('should have thrown');
    } catch (error) {
      expect((error as FeedParseError).code).toBe('FORMAT_MISMATCH');
    }
  });

  it('still parses RSS without a namespace', () => {
    const feed = parseFeed(fixture('rss-sample.xml'), 'auto');

    expect(feed.format).toBe('rss');
    expect(feed.entries).toHaveLength(3);
  });

  it('tolerates a namespace-less feed root as Atom', () => {
    const xml = '<feed><entry><title>T</title><id>e1</id></entry></feed>';
    const feed = parseFeed(xml, 'auto');

    expect(feed.format).toBe('atom');
    expect(feed.entries[0]?.title).toBe('T');
  });

  it('ignores a processing instruction before the root element', () => {
    const feed = parseFeed(DEFAULT_NS_ATOM, 'auto');

    expect(feed.format).toBe('atom');
  });

  it('does not mistake an unrelated root for Atom', () => {
    const xml = '<channel><title>Not a feed root</title></channel>';

    expect(() => parseFeed(xml, 'auto')).toThrow(FeedParseError);
  });
});

describe('parseFeed — malformed and unsafe input', () => {
  it('rejects malformed XML', () => {
    expect(() => parseFeed(fixture('malformed.xml'), 'auto')).toThrow(FeedParseError);
  });

  it('reports the INVALID_XML code with position details', () => {
    try {
      parseFeed(fixture('malformed.xml'), 'auto');
      expect.unreachable('should have thrown');
    } catch (error) {
      expect((error as FeedParseError).code).toBe('INVALID_XML');
      expect((error as FeedParseError).message).toMatch(/line \d+/);
    }
  });

  it('rejects a document declaring a DOCTYPE', () => {
    expect(() => parseFeed(fixture('doctype.xml'), 'auto')).toThrow(FeedParseError);
  });

  it('reports the DOCTYPE_NOT_ALLOWED code', () => {
    try {
      parseFeed(fixture('doctype.xml'), 'auto');
      expect.unreachable('should have thrown');
    } catch (error) {
      expect((error as FeedParseError).code).toBe('DOCTYPE_NOT_ALLOWED');
    }
  });

  it('rejects a DOCTYPE regardless of case', () => {
    const xml = '<?xml version="1.0"?><!doctype rss><rss><channel/></rss>';

    expect(() => parseFeed(xml, 'auto')).toThrow(/DOCTYPE/);
  });

  it('rejects an empty document', () => {
    expect(() => parseFeed('', 'auto')).toThrow(FeedParseError);
  });

  it('never expands entities declared in a DOCTYPE', () => {
    // The DOCTYPE ban makes entity expansion unreachable; the payload must not appear.
    try {
      parseFeed(fixture('doctype.xml'), 'auto');
      expect.unreachable('should have thrown');
    } catch (error) {
      expect((error as FeedParseError).message).not.toMatch(/expanded-entity-value/);
    }
  });
});

describe('parseFeed — namespace correctness', () => {
  const ATOM = 'http://www.w3.org/2005/Atom';
  const FOREIGN = 'http://example.com/foo';
  const DC = 'http://purl.org/dc/elements/1.1/';
  const MEDIA = 'http://search.yahoo.com/mrss/';

  const atomFeed = (body: string, rootAttributes = `xmlns:atom="${ATOM}" xmlns:foo="${FOREIGN}"`) =>
    `<atom:feed ${rootAttributes}>${body}</atom:feed>`;

  describe('A. foreign elements must not stand in for Atom core elements', () => {
    it('ignores a foreign title placed before the Atom title', () => {
      const xml = atomFeed(
        '<atom:entry><foo:title>FOREIGN</foo:title><atom:title>REAL</atom:title></atom:entry>',
      );

      expect(parseFeed(xml, 'auto').entries[0]?.title).toBe('REAL');
    });

    it('ignores a foreign title placed after the Atom title', () => {
      const xml = atomFeed(
        '<atom:entry><atom:title>REAL</atom:title><foo:title>FOREIGN</foo:title></atom:entry>',
      );

      expect(parseFeed(xml, 'auto').entries[0]?.title).toBe('REAL');
    });

    it('ignores a foreign entry placed before the Atom entry', () => {
      const xml = atomFeed(
        '<foo:entry><atom:title>FOREIGN</atom:title></foo:entry>' +
          '<atom:entry><atom:title>REAL</atom:title></atom:entry>',
      );
      const feed = parseFeed(xml, 'auto');

      expect(feed.entries).toHaveLength(1);
      expect(feed.entries[0]?.title).toBe('REAL');
    });

    it('ignores a foreign entry placed after the Atom entry', () => {
      const xml = atomFeed(
        '<atom:entry><atom:title>REAL</atom:title></atom:entry>' +
          '<foo:entry><atom:title>FOREIGN</atom:title></foo:entry>',
      );
      const feed = parseFeed(xml, 'auto');

      expect(feed.entries).toHaveLength(1);
      expect(feed.entries[0]?.title).toBe('REAL');
    });

    it('ignores a foreign link', () => {
      const xml = atomFeed(
        '<atom:entry><atom:title>T</atom:title>' +
          '<foo:link rel="alternate" href="https://evil.example/foreign"/>' +
          '<atom:link rel="alternate" href="https://good.example/real"/></atom:entry>',
      );

      expect(parseFeed(xml, 'auto').entries[0]?.link).toBe('https://good.example/real');
    });

    it('ignores a foreign id', () => {
      const xml = atomFeed(
        '<atom:entry><atom:title>T</atom:title>' +
          '<foo:id>foreign-id</foo:id><atom:id>real-id</atom:id></atom:entry>',
      );

      expect(parseFeed(xml, 'auto').entries[0]?.guid).toBe('real-id');
    });

    it('ignores a foreign category', () => {
      const xml = atomFeed(
        '<atom:entry><atom:title>T</atom:title>' +
          '<foo:category term="Foreign"/><atom:category term="Real"/></atom:entry>',
      );

      expect(parseFeed(xml, 'auto').entries[0]?.categories).toEqual(['Real']);
    });

    it('ignores a foreign author and its name', () => {
      const xml = atomFeed(
        '<atom:entry><atom:title>T</atom:title>' +
          '<foo:author><foo:name>Foreign</foo:name></foo:author>' +
          '<atom:author><atom:name>Real</atom:name></atom:author></atom:entry>',
      );

      expect(parseFeed(xml, 'auto').entries[0]?.author).toBe('Real');
    });

    it('ignores foreign summary and published elements', () => {
      const xml = atomFeed(
        '<atom:entry><atom:title>T</atom:title>' +
          '<foo:summary>Foreign summary</foo:summary>' +
          '<foo:published>2020-01-01T00:00:00Z</foo:published>' +
          '<atom:summary>Real summary</atom:summary>' +
          '<atom:published>2026-11-19T10:00:00Z</atom:published></atom:entry>',
      );
      const entry = parseFeed(xml, 'auto').entries[0];

      expect(entry?.summary).toBe('Real summary');
      expect(entry?.publishedRaw).toBe('2026-11-19T10:00:00Z');
    });
  });

  describe('B. namespace scope: inheritance, shadowing and rebinding', () => {
    it('inherits a declaration from an ancestor', () => {
      const xml =
        `<atom:feed xmlns:atom="${ATOM}">` +
        '<atom:entry><atom:title>Inherited</atom:title></atom:entry></atom:feed>';

      expect(parseFeed(xml, 'auto').entries[0]?.title).toBe('Inherited');
    });

    it('accepts a prefix rebound to the Atom namespace on a descendant', () => {
      const xml =
        `<atom:feed xmlns:atom="${ATOM}" xmlns:x="${FOREIGN}">` +
        `<atom:entry xmlns:x="${ATOM}"><x:title>Rebound</x:title></atom:entry></atom:feed>`;

      expect(parseFeed(xml, 'auto').entries[0]?.title).toBe('Rebound');
    });

    it('lets a descendant shadow a prefix away from the Atom namespace', () => {
      const xml =
        `<atom:feed xmlns:atom="${ATOM}">` +
        `<atom:entry><atom:title xmlns:atom="${FOREIGN}">FOREIGN</atom:title>` +
        '<atom:title>REAL</atom:title></atom:entry></atom:feed>';

      expect(parseFeed(xml, 'auto').entries[0]?.title).toBe('REAL');
    });

    it('does not let one entry rebinding pollute a sibling entry', () => {
      const xml =
        `<atom:feed xmlns:atom="${ATOM}" xmlns:x="${FOREIGN}">` +
        `<atom:entry xmlns:x="${ATOM}"><x:title>FIRST</x:title></atom:entry>` +
        '<atom:entry><x:title>SECOND</x:title><atom:title>SECOND-ATOM</atom:title></atom:entry>' +
        '</atom:feed>';
      const feed = parseFeed(xml, 'auto');

      expect(feed.entries[0]?.title).toBe('FIRST');
      // `x` is foreign again in the second entry, so only the Atom title counts.
      expect(feed.entries[1]?.title).toBe('SECOND-ATOM');
    });

    it('treats an undeclared prefix as matching no namespace', () => {
      const xml = `<atom:feed xmlns:atom="${ATOM}"><atom:entry><undeclared:title>X</undeclared:title></atom:entry></atom:feed>`;

      expect(parseFeed(xml, 'auto').entries[0]?.title).toBeUndefined();
    });

    it('rejects a root using an undeclared prefix', () => {
      const xml = '<nope:feed><nope:entry/></nope:feed>';

      expect(() => parseFeed(xml, 'auto')).toThrow(/undeclared namespace prefix/);
    });
  });

  describe('C. xml:lang resolution', () => {
    it('prefers xml:lang when a foreign lang attribute comes first', () => {
      const xml =
        `<feed xmlns="${ATOM}" xmlns:foo="${FOREIGN}" foo:lang="zz" xml:lang="en">` +
        '<entry><title>T</title></entry></feed>';

      expect(parseFeed(xml, 'auto').language).toBe('en');
    });

    it('prefers xml:lang when a foreign lang attribute comes last', () => {
      const xml =
        `<feed xmlns="${ATOM}" xmlns:foo="${FOREIGN}" xml:lang="en" foo:lang="zz">` +
        '<entry><title>T</title></entry></feed>';

      expect(parseFeed(xml, 'auto').language).toBe('en');
    });

    it('ignores a foreign lang attribute when xml:lang is absent', () => {
      const xml =
        `<feed xmlns="${ATOM}" xmlns:foo="${FOREIGN}" foo:lang="zz">` +
        '<entry><title>T</title></entry></feed>';

      expect(parseFeed(xml, 'auto').language).toBeUndefined();
    });

    it('does not apply the default namespace to an unprefixed lang attribute', () => {
      const xml = `<feed xmlns="${ATOM}" lang="de"><entry><title>T</title></entry></feed>`;

      expect(parseFeed(xml, 'auto').language).toBeUndefined();
    });

    it('preserves the existing behaviour for feeds without xml:lang', () => {
      const xml = `<feed xmlns="${ATOM}"><entry><title>T</title></entry></feed>`;

      expect(parseFeed(xml, 'auto').language).toBeUndefined();
    });
  });

  describe('D. RSS core and extension namespaces', () => {
    const rssFeed = (body: string, attributes: string) =>
      `<rss version="2.0" ${attributes}><channel>${body}</channel></rss>`;

    it('ignores a foreign creator placed before the Dublin Core creator', () => {
      const xml = rssFeed(
        '<item><title>T</title><link>https://e.example/1</link>' +
          '<foo:creator>FOREIGN</foo:creator><dc:creator>REAL</dc:creator></item>',
        `xmlns:dc="${DC}" xmlns:foo="${FOREIGN}"`,
      );

      expect(parseFeed(xml, 'auto').entries[0]?.author).toBe('REAL');
    });

    it('ignores a foreign creator placed after the Dublin Core creator', () => {
      const xml = rssFeed(
        '<item><title>T</title><link>https://e.example/1</link>' +
          '<dc:creator>REAL</dc:creator><foo:creator>FOREIGN</foo:creator></item>',
        `xmlns:dc="${DC}" xmlns:foo="${FOREIGN}"`,
      );

      expect(parseFeed(xml, 'auto').entries[0]?.author).toBe('REAL');
    });

    it('ignores a foreign content placed before Media RSS content', () => {
      const xml = rssFeed(
        '<item><title>T</title><link>https://e.example/1</link>' +
          '<foo:content url="https://evil.example/foreign.png"/>' +
          '<media:content url="https://good.example/real.png"/></item>',
        `xmlns:media="${MEDIA}" xmlns:foo="${FOREIGN}"`,
      );

      expect(parseFeed(xml, 'auto').entries[0]?.imageUrl).toBe('https://good.example/real.png');
    });

    it('ignores a foreign content placed after Media RSS content', () => {
      const xml = rssFeed(
        '<item><title>T</title><link>https://e.example/1</link>' +
          '<media:content url="https://good.example/real.png"/>' +
          '<foo:content url="https://evil.example/foreign.png"/></item>',
        `xmlns:media="${MEDIA}" xmlns:foo="${FOREIGN}"`,
      );

      expect(parseFeed(xml, 'auto').entries[0]?.imageUrl).toBe('https://good.example/real.png');
    });

    it('accepts an alternative prefix bound to the Dublin Core URI', () => {
      const xml = rssFeed(
        '<item><title>T</title><link>https://e.example/1</link>' +
          '<dc2:creator>ViaAlternativePrefix</dc2:creator></item>',
        `xmlns:dc2="${DC}"`,
      );

      expect(parseFeed(xml, 'auto').entries[0]?.author).toBe('ViaAlternativePrefix');
    });

    it('accepts an alternative prefix bound to the Media RSS URI', () => {
      const xml = rssFeed(
        '<item><title>T</title><link>https://e.example/1</link>' +
          '<m:content url="https://good.example/real.png"/></item>',
        `xmlns:m="${MEDIA}"`,
      );

      expect(parseFeed(xml, 'auto').entries[0]?.imageUrl).toBe('https://good.example/real.png');
    });

    it('rejects the dc prefix when it is bound to an unrelated namespace', () => {
      const xml = rssFeed(
        '<item><title>T</title><link>https://e.example/1</link>' +
          '<dc:creator>Wrong</dc:creator></item>',
        `xmlns:dc="${FOREIGN}"`,
      );

      expect(parseFeed(xml, 'auto').entries[0]?.author).toBeUndefined();
    });

    it('rejects the media prefix when it is bound to an unrelated namespace', () => {
      const xml = rssFeed(
        '<item><title>T</title><link>https://e.example/1</link>' +
          '<media:content url="https://evil.example/foreign.png"/></item>',
        `xmlns:media="${FOREIGN}"`,
      );

      expect(parseFeed(xml, 'auto').entries[0]?.imageUrl).toBeUndefined();
    });

    it('ignores a foreign title, link and description in an RSS item', () => {
      const xml = rssFeed(
        '<item><foo:title>FOREIGN</foo:title><foo:link>https://evil.example/</foo:link>' +
          '<foo:description>FOREIGN</foo:description>' +
          '<title>REAL</title><link>https://e.example/1</link>' +
          '<description>Real summary</description></item>',
        `xmlns:foo="${FOREIGN}"`,
      );
      const entry = parseFeed(xml, 'auto').entries[0];

      expect(entry?.title).toBe('REAL');
      expect(entry?.link).toBe('https://e.example/1');
      expect(entry?.summary).toBe('Real summary');
    });
  });

  describe('E. regression: existing shapes still parse identically', () => {
    it('parses the RSS fixture exactly as before', () => {
      const feed = parseFeed(fixture('rss-sample.xml'), 'auto');

      expect(feed.format).toBe('rss');
      expect(feed.language).toBe('en');
      expect(feed.entries).toHaveLength(3);
      expect(feed.entries[0]).toEqual({
        title: 'First Post',
        link: 'https://example.com/posts/first',
        guid: 'post-1',
        summary: '&lt;p&gt;First summary with &amp;amp; entity&lt;/p&gt;',
        publishedRaw: 'Wed, 19 Nov 2026 10:00:00 GMT',
        author: 'Alice',
        categories: ['Research', 'AI'],
        imageUrl: 'https://example.com/images/first.png',
      });
    });

    it('parses the Atom fixture exactly as before', () => {
      const feed = parseFeed(fixture('atom-sample.xml'), 'auto');

      expect(feed.format).toBe('atom');
      expect(feed.language).toBe('en');
      expect(feed.entries).toHaveLength(2);
      expect(feed.entries[0]).toEqual({
        title: 'Atom Entry One',
        link: 'https://example.org/entries/one',
        guid: 'tag:example.org,2026:entry-1',
        summary: 'Atom summary one',
        publishedRaw: '2026-11-19T10:00:00Z',
        author: 'Bob',
        categories: ['Research', 'AI'],
        imageUrl: 'https://example.org/images/one.png',
      });
    });

    it('parses the relative-links fixture exactly as before', () => {
      const feed = parseFeed(fixture('relative-links.xml'), 'auto');

      expect(feed.format).toBe('rss');
      expect(feed.entries).toHaveLength(9);
    });

    it('still accepts a namespace-less feed as Atom', () => {
      const xml = '<feed><entry><title>T</title><id>e1</id></entry></feed>';
      const feed = parseFeed(xml, 'auto');

      expect(feed.format).toBe('atom');
      expect(feed.entries[0]?.title).toBe('T');
      expect(feed.entries[0]?.guid).toBe('e1');
    });

    it('keeps default and prefixed Atom producing identical output', () => {
      const defaultNs = `<feed xmlns="${ATOM}">
        <title>F</title>
        <entry>
          <title>T</title>
          <id>e1</id>
          <link rel="alternate" href="https://e.example/1"/>
        </entry>
      </feed>`;

      const prefixed = `<atom:feed xmlns:atom="${ATOM}">
        <atom:title>F</atom:title>
        <atom:entry>
          <atom:title>T</atom:title>
          <atom:id>e1</atom:id>
          <atom:link rel="alternate" href="https://e.example/1"/>
        </atom:entry>
      </atom:feed>`;

      expect(parseFeed(prefixed, 'auto')).toEqual(parseFeed(defaultNs, 'auto'));
    });
  });

  describe('F. RSS root must not be namespaced', () => {
    it('parses an RSS root with no namespace', () => {
      const xml =
        '<rss version="2.0"><channel><item><title>T</title>' +
        '<link>https://e.example/1</link></item></channel></rss>';
      const feed = parseFeed(xml, 'auto');

      expect(feed.format).toBe('rss');
      expect(feed.entries).toHaveLength(1);
      expect(feed.entries[0]?.title).toBe('T');
    });

    it('rejects an RSS root bound to a foreign default namespace', () => {
      const xml = `<rss xmlns="${FOREIGN}"><channel><item><title>T</title></item></channel></rss>`;

      expect(() => parseFeed(xml, 'auto')).toThrow(FeedParseError);
    });

    it('reports UNKNOWN_FORMAT for a namespaced RSS root', () => {
      const xml = `<rss xmlns="${FOREIGN}"><channel><item><title>T</title></item></channel></rss>`;

      try {
        parseFeed(xml, 'auto');
        expect.unreachable('should have thrown');
      } catch (error) {
        expect((error as FeedParseError).code).toBe('UNKNOWN_FORMAT');
        expect((error as FeedParseError).message).toMatch(/RSS must not be namespaced/);
      }
    });

    it('rejects a prefixed RSS root bound to a foreign namespace', () => {
      const xml = `<f:rss xmlns:f="${FOREIGN}"><f:channel><f:item><f:title>T</f:title></f:item></f:channel></f:rss>`;

      try {
        parseFeed(xml, 'auto');
        expect.unreachable('should have thrown');
      } catch (error) {
        expect((error as FeedParseError).code).toBe('UNKNOWN_FORMAT');
        expect((error as FeedParseError).message).toMatch(/RSS must not be namespaced/);
      }
    });

    it('rejects an RSS root using an undeclared prefix', () => {
      const xml = '<x:rss><x:channel/></x:rss>';

      try {
        parseFeed(xml, 'auto');
        expect.unreachable('should have thrown');
      } catch (error) {
        expect((error as FeedParseError).code).toBe('UNKNOWN_FORMAT');
        expect((error as FeedParseError).message).toMatch(/undeclared namespace prefix/);
      }
    });

    it('never returns an empty entry list for a namespaced RSS root', () => {
      const xml = `<rss xmlns="${FOREIGN}"><channel><item><title>T</title></item></channel></rss>`;

      // The previous behaviour accepted this root and silently yielded no entries.
      expect(() => parseFeed(xml, 'auto')).toThrow(FeedParseError);
    });

    it('still accepts an RSS root that only declares prefixed namespaces', () => {
      const xml =
        `<rss version="2.0" xmlns:atom="${ATOM}" xmlns:dc="${DC}">` +
        '<channel><item><title>T</title><link>https://e.example/1</link>' +
        '<dc:creator>A</dc:creator></item></channel></rss>';
      const feed = parseFeed(xml, 'auto');

      expect(feed.format).toBe('rss');
      expect(feed.entries[0]?.author).toBe('A');
    });

    it('parses only non-foreign items when an item declares a foreign namespace', () => {
      const xml = `<rss>
  <channel>
    <item>
      <title>Normal Item</title>
    </item>
    <item xmlns="http://example.com/foreign">
      <title>Foreign Item</title>
    </item>
    <item xmlns="">
      <title>Undeclared Item</title>
    </item>
  </channel>
</rss>`;
      const feed = parseFeed(xml, 'auto');

      expect(feed.format).toBe('rss');
      expect(feed.entries.map((entry) => entry.title)).toEqual(['Normal Item', 'Undeclared Item']);
    });

    it('keeps Atom namespace detection unchanged', () => {
      const defaultNs = `<feed xmlns="${ATOM}"><entry><title>T</title></entry></feed>`;
      const prefixed = `<atom:feed xmlns:atom="${ATOM}"><atom:entry><atom:title>T</atom:title></atom:entry></atom:feed>`;

      expect(parseFeed(defaultNs, 'auto').format).toBe('atom');
      expect(parseFeed(prefixed, 'auto').format).toBe('atom');
      expect(() => parseFeed(`<feed xmlns="${FOREIGN}"><entry/></feed>`, 'auto')).toThrow(
        /not the Atom namespace/,
      );
    });

    it('keeps the namespace-less Atom feed compatible', () => {
      const feed = parseFeed('<feed><entry><title>T</title><id>e1</id></entry></feed>', 'auto');

      expect(feed.format).toBe('atom');
      expect(feed.entries[0]?.title).toBe('T');
      expect(feed.entries[0]?.guid).toBe('e1');
    });
  });
});
