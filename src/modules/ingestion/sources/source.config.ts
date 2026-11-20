import { loadSources, type FeedSource } from './source.schema.js';

/**
 * Curated feed registry.
 *
 * Every URL below was verified to return HTTP 200 with a parseable RSS 2.0 or
 * Atom document. Sources that are blocked or unusable are omitted rather than
 * disabled: TechCrunch returns HTTP 403 to non-browser clients, and Hacker News
 * is broad rather than AI-specific.
 *
 * `kind` is explicit because a feed's format cannot be inferred from its URL —
 * The Verge serves Atom from a path that looks like RSS.
 */
const sources: readonly FeedSource[] = loadSources([
  {
    id: 'openai-news',
    name: 'OpenAI News',
    url: 'https://openai.com/news/rss.xml',
    homepage: 'https://openai.com/news',
    kind: 'rss',
    enabled: true,
    defaultLanguage: 'en',
    tags: ['ai', 'lab'],
    reliability: 'high',
  },
  {
    id: 'google-ai-blog',
    name: 'Google AI Blog',
    url: 'https://blog.google/technology/ai/rss/',
    homepage: 'https://blog.google/technology/ai/',
    kind: 'rss',
    enabled: true,
    defaultLanguage: 'en',
    tags: ['ai', 'lab'],
    reliability: 'high',
  },
  {
    id: 'arxiv-cs-ai',
    name: 'arXiv cs.AI',
    url: 'https://export.arxiv.org/rss/cs.AI',
    homepage: 'https://arxiv.org/list/cs.AI/recent',
    kind: 'rss',
    enabled: true,
    defaultLanguage: 'en',
    tags: ['ai', 'research'],
    reliability: 'high',
  },
  {
    id: 'mit-technology-review-ai',
    name: 'MIT Technology Review (AI)',
    url: 'https://www.technologyreview.com/topic/artificial-intelligence/feed',
    homepage: 'https://www.technologyreview.com/topic/artificial-intelligence/',
    kind: 'rss',
    enabled: true,
    defaultLanguage: 'en',
    tags: ['ai', 'analysis'],
    reliability: 'high',
  },
  {
    id: 'ars-technica',
    name: 'Ars Technica',
    url: 'https://feeds.arstechnica.com/arstechnica/technology-lab',
    homepage: 'https://arstechnica.com/',
    kind: 'rss',
    enabled: true,
    defaultLanguage: 'en',
    tags: ['ai', 'technology'],
    reliability: 'medium',
  },
  {
    id: 'the-verge-ai',
    name: 'The Verge (AI)',
    url: 'https://www.theverge.com/rss/ai-artificial-intelligence/index.xml',
    homepage: 'https://www.theverge.com/ai-artificial-intelligence',
    kind: 'atom',
    enabled: true,
    defaultLanguage: 'en',
    tags: ['ai', 'news'],
    reliability: 'medium',
  },
]);

export const feedSources: readonly FeedSource[] = sources;

export function enabledSources(): readonly FeedSource[] {
  return feedSources.filter((source) => source.enabled);
}
