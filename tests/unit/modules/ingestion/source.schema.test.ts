import { describe, expect, it } from 'vitest';

import {
  enabledSources,
  feedSources,
} from '../../../../src/modules/ingestion/sources/source.config.js';
import {
  isHttpUrl,
  loadSources,
  sourceSchema,
} from '../../../../src/modules/ingestion/sources/source.schema.js';

function validSource(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'example-feed',
    name: 'Example Feed',
    url: 'https://example.com/feed.xml',
    homepage: 'https://example.com/',
    kind: 'rss',
    enabled: true,
    defaultLanguage: 'en',
    tags: ['ai'],
    reliability: 'high',
    ...overrides,
  };
}

describe('sourceSchema', () => {
  it('accepts a complete valid source', () => {
    const result = sourceSchema.safeParse(validSource());

    expect(result.success).toBe(true);
    expect(result.data).toEqual(validSource());
  });

  it('accepts each supported feed kind', () => {
    for (const kind of ['rss', 'atom', 'auto']) {
      expect(sourceSchema.safeParse(validSource({ kind })).success).toBe(true);
    }
  });

  it('rejects an unsupported feed kind', () => {
    const result = sourceSchema.safeParse(validSource({ kind: 'json' }));

    expect(result.success).toBe(false);
  });

  it('rejects a missing required field', () => {
    for (const field of [
      'id',
      'name',
      'url',
      'homepage',
      'kind',
      'enabled',
      'defaultLanguage',
      'tags',
      'reliability',
    ]) {
      const input = validSource();
      delete input[field];

      expect(sourceSchema.safeParse(input).success, `missing ${field}`).toBe(false);
    }
  });

  it('rejects invalid source identifiers', () => {
    const invalidIds = [
      '',
      'OpenAI',
      'openai_news',
      'openai--news',
      '-openai',
      'openai-',
      'a'.repeat(65),
      'open ai',
    ];

    for (const id of invalidIds) {
      expect(sourceSchema.safeParse(validSource({ id })).success, `id ${JSON.stringify(id)}`).toBe(
        false,
      );
    }
  });

  it('accepts lowercase kebab-case identifiers', () => {
    for (const id of ['a', 'openai-news', 'arxiv-cs-ai', 'a1-b2']) {
      expect(sourceSchema.safeParse(validSource({ id })).success, `id ${id}`).toBe(true);
    }
  });

  it('rejects malformed URLs', () => {
    for (const url of ['', '   ', 'not a url', '/relative/feed.xml', 'example.com/feed.xml']) {
      expect(
        sourceSchema.safeParse(validSource({ url })).success,
        `url ${JSON.stringify(url)}`,
      ).toBe(false);
      expect(
        sourceSchema.safeParse(validSource({ homepage: url })).success,
        `homepage ${JSON.stringify(url)}`,
      ).toBe(false);
    }
  });

  it('rejects unsupported URL protocols', () => {
    for (const url of [
      'javascript:alert(1)',
      'data:text/html,x',
      'ftp://example.com/feed.xml',
      'mailto:a@b.com',
    ]) {
      expect(sourceSchema.safeParse(validSource({ url })).success, `url ${url}`).toBe(false);
    }
  });

  it('accepts http and https URLs', () => {
    expect(
      sourceSchema.safeParse(validSource({ url: 'http://example.com/feed.xml' })).success,
    ).toBe(true);
    expect(
      sourceSchema.safeParse(validSource({ url: 'https://example.com/feed.xml' })).success,
    ).toBe(true);
  });

  it('rejects an unsupported reliability value', () => {
    expect(sourceSchema.safeParse(validSource({ reliability: 'unknown' })).success).toBe(false);
  });

  it('rejects a non-boolean enabled flag', () => {
    expect(sourceSchema.safeParse(validSource({ enabled: 'yes' })).success).toBe(false);
  });

  it('rejects an empty tag entry', () => {
    expect(sourceSchema.safeParse(validSource({ tags: ['ai', ''] })).success).toBe(false);
  });

  it('accepts an empty tag list', () => {
    expect(sourceSchema.safeParse(validSource({ tags: [] })).success).toBe(true);
  });

  it('rejects malformed configuration shapes', () => {
    for (const input of [null, undefined, 42, 'string', [], {}]) {
      expect(sourceSchema.safeParse(input).success, `input ${JSON.stringify(input)}`).toBe(false);
    }
  });
});

describe('loadSources', () => {
  it('returns the parsed list for valid input', () => {
    const sources = loadSources([validSource(), validSource({ id: 'second-feed' })]);

    expect(sources).toHaveLength(2);
    expect(sources[0]?.id).toBe('example-feed');
    expect(sources[1]?.id).toBe('second-feed');
  });

  it('accepts an empty list', () => {
    expect(loadSources([])).toEqual([]);
  });

  it('rejects duplicate source identifiers', () => {
    expect(() => loadSources([validSource(), validSource()])).toThrow(/duplicate source id/);
  });

  it('rejects a non-array input', () => {
    expect(() => loadSources(validSource())).toThrow();
  });

  it('rejects a list containing an invalid source', () => {
    expect(() => loadSources([validSource({ kind: 'json' })])).toThrow();
  });
});

describe('isHttpUrl', () => {
  it('accepts absolute http(s) URLs', () => {
    expect(isHttpUrl('https://example.com/a')).toBe(true);
    expect(isHttpUrl('http://example.com/a')).toBe(true);
  });

  it('rejects other protocols and malformed values', () => {
    for (const value of [
      'javascript:alert(1)',
      'data:text/html,x',
      'mailto:a@b.com',
      '/relative',
      '',
      'not a url',
    ]) {
      expect(isHttpUrl(value), value).toBe(false);
    }
  });
});

describe('feedSources registry', () => {
  it('validates against the schema', () => {
    expect(() => loadSources([...feedSources])).not.toThrow();
  });

  it('contains exactly the six approved sources', () => {
    expect(feedSources.map((source) => source.id)).toEqual([
      'openai-news',
      'google-ai-blog',
      'arxiv-cs-ai',
      'mit-technology-review-ai',
      'ars-technica',
      'the-verge-ai',
    ]);
  });

  it('excludes Hacker News and TechCrunch', () => {
    const ids = feedSources.map((source) => source.id);
    const urls = feedSources.map((source) => source.url);

    expect(ids).not.toContain('hacker-news');
    expect(ids).not.toContain('techcrunch');
    expect(urls.some((url) => url.includes('ycombinator'))).toBe(false);
    expect(urls.some((url) => url.includes('techcrunch'))).toBe(false);
  });

  it('enables every approved source', () => {
    expect(enabledSources()).toHaveLength(6);
    expect(feedSources.every((source) => source.enabled)).toBe(true);
  });

  it('uses the verified feed URLs', () => {
    const byId = new Map(feedSources.map((source) => [source.id, source]));

    expect(byId.get('openai-news')?.url).toBe('https://openai.com/news/rss.xml');
    expect(byId.get('google-ai-blog')?.url).toBe('https://blog.google/technology/ai/rss/');
    expect(byId.get('arxiv-cs-ai')?.url).toBe('https://export.arxiv.org/rss/cs.AI');
    expect(byId.get('mit-technology-review-ai')?.url).toBe(
      'https://www.technologyreview.com/topic/artificial-intelligence/feed',
    );
    expect(byId.get('ars-technica')?.url).toBe(
      'https://feeds.arstechnica.com/arstechnica/technology-lab',
    );
    expect(byId.get('the-verge-ai')?.url).toBe(
      'https://www.theverge.com/rss/ai-artificial-intelligence/index.xml',
    );
  });

  it('marks The Verge as Atom and the rest as RSS', () => {
    const byId = new Map(feedSources.map((source) => [source.id, source]));

    expect(byId.get('the-verge-ai')?.kind).toBe('atom');
    for (const id of [
      'openai-news',
      'google-ai-blog',
      'arxiv-cs-ai',
      'mit-technology-review-ai',
      'ars-technica',
    ]) {
      expect(byId.get(id)?.kind, id).toBe('rss');
    }
  });

  it('has unique ids', () => {
    const ids = feedSources.map((source) => source.id);

    expect(new Set(ids).size).toBe(ids.length);
  });
});
