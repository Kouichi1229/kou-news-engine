import type { Article, ArticleSourceReference } from '../../../types/article.js';
import type { ArticleRepository } from './article.repository.js';
import { normalizeSourceReferences, sourceIdentityKey, toGuidKey } from './provenance-identity.js';

/**
 * Article fields excluding provenance, which is stored separately.
 *
 * Keeping `sources` out of the stored article is what makes append-only possible:
 * a later save overwrites these fields without touching provenance history.
 */
type ArticleFields = Omit<Article, 'sources'>;

/**
 * One provenance row, mirroring the columns the SQLite repository keeps.
 *
 * `firstSeenAt` is deliberately absent: it is a SQLite-only column with no
 * counterpart in `ArticleSourceReference`, so it cannot be observed through the
 * repository interface and simulating it would invent state nobody can read.
 */
interface StoredSource {
  sourceId: string;
  canonicalUrl: string;
  /** `undefined` when the feed supplied no GUID; distinct from an empty string. */
  guid: string | undefined;
  /** Encoded identity component, kept for parity with the SQLite column. */
  guidKey: string;
  /** Precomputed `sourceIdentityKey`, so lookups never re-derive it. */
  identityKey: string;
  /** Mutable: refreshed on every save that names this identity. */
  url: string;
  /** Mutable: refreshed on every save that names this identity. */
  resolvedUrl: string;
  /** Stable position assigned on first insert; never rewritten or recycled. */
  sourceOrder: number;
  /** At most one row per article; owned by the save path, not by upsert. */
  isPrimary: boolean;
}

interface StoredArticle {
  article: ArticleFields;
  sources: StoredSource[];
  /** Next free position; monotonically increasing, never rewound. */
  nextSourceOrder: number;
}

/**
 * In-memory article store.
 *
 * Behaviour mirrors `SqliteArticleRepository` for everything observable through
 * `ArticleRepository`, so tests and local runs cannot diverge from production:
 *
 * - Provenance is append-only. A save naming fewer sources never deletes rows.
 * - Identity is `(sourceId, canonicalUrl, guidKey)`, so the same URL carrying
 *   two GUIDs is two rows while the same tuple collapses to one.
 * - `url` and `resolvedUrl` are the only mutable columns.
 * - `sourceOrder` is assigned once and never reused, even after deletion.
 * - Reads return the primary source first, then ascending `sourceOrder`.
 *
 * Articles are cloned in and out, so neither the caller nor a reader can mutate
 * stored state through a shared reference.
 */
export class InMemoryArticleRepository implements ArticleRepository {
  private readonly articles = new Map<string, StoredArticle>();

  async save(article: Article): Promise<void> {
    this.writeArticle(article);
  }

  async saveMany(articles: readonly Article[]): Promise<void> {
    for (const article of articles) {
      this.writeArticle(article);
    }
  }

  async findById(id: string): Promise<Article | undefined> {
    const stored = this.articles.get(id);
    return stored === undefined ? undefined : toArticle(stored);
  }

  async findAll(): Promise<Article[]> {
    return [...this.articles.values()].map((stored) => toArticle(stored));
  }

  async has(id: string): Promise<boolean> {
    return this.articles.has(id);
  }

  async delete(id: string): Promise<void> {
    // Provenance lives inside the entry, so this cascades the way the foreign key
    // does in SQLite.
    this.articles.delete(id);
  }

  async clear(): Promise<void> {
    this.articles.clear();
  }

  async count(): Promise<number> {
    return this.articles.size;
  }

  /**
   * Writes one article and merges its provenance.
   *
   * The new state is built entirely in locals and committed at the end, so a
   * failure anywhere — an uncloneable value or the primary guard — leaves the
   * stored entry exactly as it was. That mirrors the SQLite write, which runs in
   * a single transaction.
   */
  private writeArticle(article: Article): void {
    const fields = toArticleFields(article);
    const normalized = normalizeSourceReferences(article.sources);

    const previous = this.articles.get(article.id);
    // Copy-on-write: the stored rows are shared until the commit below, so the
    // mutable-field updates cannot leak into a save that later throws.
    const sources = (previous?.sources ?? []).map(copyStoredSource);
    let nextSourceOrder = previous?.nextSourceOrder ?? 1;

    for (const source of normalized) {
      const identityKey = sourceIdentityKey(source);
      const existing = sources.find((candidate) => candidate.identityKey === identityKey);

      if (existing === undefined) {
        sources.push({
          sourceId: source.sourceId,
          canonicalUrl: source.canonicalUrl,
          guid: source.guid,
          guidKey: toGuidKey(source.guid),
          identityKey,
          url: source.url,
          resolvedUrl: source.resolvedUrl,
          sourceOrder: nextSourceOrder,
          isPrimary: false,
        });
        nextSourceOrder += 1;
        continue;
      }

      // Identity and history stay put; only the mutable columns follow the input.
      existing.url = source.url;
      existing.resolvedUrl = source.resolvedUrl;
    }

    // An empty `sources` list must not strip provenance or the primary: the
    // append-only rule protects both.
    const primary = normalized[0];
    if (primary !== undefined) {
      const primaryKey = sourceIdentityKey(primary);
      const target = sources.find((candidate) => candidate.identityKey === primaryKey);
      // Checked before the flag is cleared, mirroring the SQLite guard: clearing
      // first and then missing would leave the article with no primary at all.
      if (target === undefined) {
        throw new Error('Primary provenance identity does not exist');
      }

      for (const candidate of sources) {
        candidate.isPrimary = false;
      }
      target.isPrimary = true;
    }

    if (previous === undefined) {
      this.articles.set(article.id, { article: fields, sources, nextSourceOrder });
      return;
    }

    // Mutating the existing entry leaves its Map position untouched, which is
    // what keeps `findAll` in first-insertion order.
    previous.article = fields;
    previous.sources = sources;
    previous.nextSourceOrder = nextSourceOrder;
  }
}

/** Shallow copy of one stored row; every field is a primitive. */
function copyStoredSource(source: StoredSource): StoredSource {
  return { ...source };
}

/** Strips provenance and deep-copies the remaining fields. */
function toArticleFields(article: Article): ArticleFields {
  const { sources: _sources, ...rest } = article;
  return structuredClone(rest);
}

/** Builds a fresh domain article from stored state. */
function toArticle(stored: StoredArticle): Article {
  const ordered = [...stored.sources].sort(compareSources);
  return {
    ...structuredClone(stored.article),
    sources: ordered.map(toSourceReference),
  };
}

/** Primary first, then ascending `sourceOrder` — the SQLite read ordering. */
function compareSources(left: StoredSource, right: StoredSource): number {
  if (left.isPrimary !== right.isPrimary) {
    return left.isPrimary ? -1 : 1;
  }
  return left.sourceOrder - right.sourceOrder;
}

/** Exposes only the fields the domain type declares, preserving absent `guid`. */
function toSourceReference(source: StoredSource): ArticleSourceReference {
  const reference: ArticleSourceReference = {
    sourceId: source.sourceId,
    url: source.url,
    resolvedUrl: source.resolvedUrl,
    canonicalUrl: source.canonicalUrl,
  };
  if (source.guid !== undefined) {
    reference.guid = source.guid;
  }
  return reference;
}
