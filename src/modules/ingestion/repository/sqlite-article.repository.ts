import type {
  SqliteDatabase,
  SqliteQuery,
  SqliteTransaction,
} from '../../../core/persistence/sqlite.js';
import type { Article, ArticleSourceReference } from '../../../types/article.js';
import type { ArticleRepository } from './article.repository.js';
import { normalizeSourceReferences, sourceIdentityKey, toGuidKey } from './provenance-identity.js';

/**
 * Durable `ArticleRepository` backed by the SQLite persistence layer.
 *
 * Writes go through `database.transaction()`, reads through `database.query()`.
 * `save()` is synchronous inside and wrapped in a promise to satisfy the
 * interface, which keeps each article's write atomic.
 */

const ARTICLE_COLUMNS = `id, title, url, canonical_url, published_at, published_at_is_estimated,
  fetched_at, summary_raw, summary_text, published_at_raw, guid, author, language, tags, image_url`;

const SOURCE_COLUMNS = `article_id, source_id, url, resolved_url, canonical_url, guid_key, guid, first_seen_at, source_order, is_primary`;

/**
 * Inserts an article, or updates it when the id already exists.
 *
 * `inserted_order` is assigned explicitly: the schema's `DEFAULT 0` would give
 * the first such row 0 and collide with the unique index on the second. The
 * subquery runs only on the insert path; on update the column is left out of
 * `DO UPDATE`, so an existing article keeps its original position.
 *
 * A `canonical_url` already held by a *different* id raises a UNIQUE error from
 * the index. That is deliberate: two ids must never silently merge.
 */
const UPSERT_ARTICLE = `
INSERT INTO articles (${ARTICLE_COLUMNS}, inserted_order)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, (SELECT COALESCE(MAX(inserted_order), 0) + 1 FROM articles))
ON CONFLICT (id) DO UPDATE SET
  title                     = excluded.title,
  url                       = excluded.url,
  canonical_url             = excluded.canonical_url,
  published_at              = excluded.published_at,
  published_at_is_estimated = excluded.published_at_is_estimated,
  fetched_at                = excluded.fetched_at,
  summary_raw               = excluded.summary_raw,
  summary_text              = excluded.summary_text,
  published_at_raw          = excluded.published_at_raw,
  guid                      = excluded.guid,
  author                    = excluded.author,
  language                  = excluded.language,
  tags                      = excluded.tags,
  image_url                 = excluded.image_url`;

/**
 * Inserts one provenance row, or refreshes its mutable fields on re-ingestion.
 *
 * The conflict target is the v3 identity `(article_id, source_id, canonical_url,
 * guid_key)`. `guid_key` is what lets two records sharing a URL but carrying
 * different GUIDs coexist; without it the older three-column target would merge
 * them into one row.
 *
 * Only `url` and `resolved_url` are refreshed. Everything else is identity or
 * history:
 *
 * - `guid` / `guid_key` are the identity itself.
 * - `first_seen_at` records when the identity was first observed.
 * - `source_order` is the stable position assigned on first insert; reordering
 *   the input array must not rewrite it.
 * - `is_primary` is owned by `CLEAR_PRIMARY` / `SET_PRIMARY`, so a conflicting
 *   insert cannot demote the current primary.
 *
 * The conflict target is named explicitly rather than using `INSERT OR IGNORE`:
 * `OR IGNORE` also swallows NOT NULL and foreign-key violations, which would
 * drop provenance silently — exactly what this layer must not do.
 */
const UPSERT_SOURCE = `
INSERT INTO article_sources (${SOURCE_COLUMNS})
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
ON CONFLICT (article_id, source_id, canonical_url, guid_key) DO UPDATE SET
  url          = excluded.url,
  resolved_url = excluded.resolved_url`;

const CLEAR_PRIMARY = `UPDATE article_sources SET is_primary = 0 WHERE article_id = ? AND is_primary = 1`;

/**
 * Promotes one provenance row to primary.
 *
 * The four-column identity is required: a URL can carry several GUIDs, so a
 * three-column match would set the flag on every one of them and the partial
 * unique index would reject the second update.
 */
const SET_PRIMARY = `UPDATE article_sources SET is_primary = 1
  WHERE article_id = ? AND source_id = ? AND canonical_url = ? AND guid_key = ?`;

/** Existing provenance identity and its stable position, read once per article. */
const SELECT_SOURCE_ORDERS = `SELECT source_id, canonical_url, guid_key, source_order
  FROM article_sources WHERE article_id = ?`;

/**
 * Confirms a provenance identity exists before the primary flag is moved.
 *
 * The full four-column identity is required: one canonical URL can carry several
 * GUIDs, so a shorter match would report "present" for a row that is not the one
 * being promoted. `CLEAR_PRIMARY` runs after this succeeds, so a miss cannot
 * leave the article without a primary.
 */
const SELECT_PRIMARY_SOURCE = `SELECT 1 AS present FROM article_sources
  WHERE article_id = ? AND source_id = ? AND canonical_url = ? AND guid_key = ?`;

const SELECT_ARTICLE_BY_ID = `SELECT ${ARTICLE_COLUMNS} FROM articles WHERE id = ?`;

const SELECT_ALL_ARTICLES = `SELECT ${ARTICLE_COLUMNS} FROM articles ORDER BY inserted_order`;

/**
 * Provenance is returned primary-first, then in its assigned `source_order`.
 *
 * `source_order` is the position the identity received when it first entered the
 * database, so it is stable across re-ingestion. `rowid` cannot serve here: the
 * surrogate `provenance_id` reflects insertion order, which stops matching the
 * intended order once a later save appends a source that belongs earlier.
 */
const SELECT_SOURCES_BY_ARTICLE = `SELECT ${SOURCE_COLUMNS} FROM article_sources
  WHERE article_id = ? ORDER BY is_primary DESC, source_order`;

const SELECT_ALL_SOURCES = `SELECT ${SOURCE_COLUMNS} FROM article_sources
  ORDER BY article_id, is_primary DESC, source_order`;

/** Reads a nullable TEXT column, mapping SQL NULL to `undefined`. */
function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

/** Reads a NOT NULL TEXT column. */
function requiredString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/** Reads a nullable TEXT column that the domain models as `string | null`. */
function nullableString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

/** Reads a SQLite 0/1 INTEGER as a boolean. */
function toBoolean(value: unknown): boolean {
  return Number(value) === 1;
}

/** Reads an INTEGER column as a number. */
function toNumber(value: unknown): number {
  return Number(value);
}

/**
 * Rebuilds the identity key of a stored provenance row.
 *
 * The row already carries the encoded `guid_key`, so the tuple is assembled
 * directly instead of going through `toGuidKey` again. `JSON.stringify` is used
 * for the same reason as in `sourceIdentityKey`: the fields are arbitrary text,
 * so any delimiter-joined form would be ambiguous. Both sides must agree
 * exactly, otherwise an existing identity would look new and consume an extra
 * `source_order`.
 */
function sourceIdentityKeyFromRow(row: ArticleRow): string {
  return JSON.stringify([
    requiredString(row.source_id),
    requiredString(row.canonical_url),
    requiredString(row.guid_key),
  ]);
}

/**
 * Decodes the JSON-encoded `tags` column.
 *
 * Order and duplicates are preserved by storing the array as JSON. A value that
 * is not a string array means the row was written by something other than this
 * repository; surfacing that beats silently returning a wrong list.
 */
function parseTags(value: unknown): string[] | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const parsed: unknown = JSON.parse(value);
  if (!Array.isArray(parsed) || parsed.some((tag) => typeof tag !== 'string')) {
    throw new Error('Stored article tags are not an array of strings');
  }
  return parsed as string[];
}

interface ArticleRow {
  [key: string]: unknown;
}

/** Maps one `articles` row to the domain type. */
function toArticle(row: ArticleRow, sources: ArticleSourceReference[]): Article {
  const article: Article = {
    id: requiredString(row.id),
    title: requiredString(row.title),
    url: requiredString(row.url),
    canonicalUrl: requiredString(row.canonical_url),
    publishedAt: nullableString(row.published_at),
    publishedAtIsEstimated: toBoolean(row.published_at_is_estimated),
    fetchedAt: requiredString(row.fetched_at),
    sources,
  };

  const summaryRaw = optionalString(row.summary_raw);
  if (summaryRaw !== undefined) article.summaryRaw = summaryRaw;

  const summaryText = optionalString(row.summary_text);
  if (summaryText !== undefined) article.summaryText = summaryText;

  const publishedAtRaw = optionalString(row.published_at_raw);
  if (publishedAtRaw !== undefined) article.publishedAtRaw = publishedAtRaw;

  const guid = optionalString(row.guid);
  if (guid !== undefined) article.guid = guid;

  const author = optionalString(row.author);
  if (author !== undefined) article.author = author;

  const language = optionalString(row.language);
  if (language !== undefined) article.language = language;

  const tags = parseTags(row.tags);
  if (tags !== undefined) article.tags = tags;

  const imageUrl = optionalString(row.image_url);
  if (imageUrl !== undefined) article.imageUrl = imageUrl;

  return article;
}

/** Maps one `article_sources` row to the domain type. */
function toSourceReference(row: ArticleRow): ArticleSourceReference {
  const reference: ArticleSourceReference = {
    sourceId: requiredString(row.source_id),
    url: requiredString(row.url),
    resolvedUrl: requiredString(row.resolved_url),
    canonicalUrl: requiredString(row.canonical_url),
  };

  const guid = optionalString(row.guid);
  if (guid !== undefined) reference.guid = guid;

  return reference;
}

export class SqliteArticleRepository implements ArticleRepository {
  constructor(private readonly database: SqliteDatabase) {}

  async save(article: Article): Promise<void> {
    this.database.transaction((connection) => {
      this.writeArticle(connection, article);
    });
  }

  /**
   * Saves each article in its own transaction.
   *
   * Deliberately not atomic: the interface promises that earlier articles stay
   * saved when a later one fails, so a batch-level transaction would break the
   * contract.
   */
  async saveMany(articles: readonly Article[]): Promise<void> {
    for (const article of articles) {
      this.database.transaction((connection) => {
        this.writeArticle(connection, article);
      });
    }
  }

  async findById(id: string): Promise<Article | undefined> {
    return this.database.query((connection) => {
      const row = connection.get(SELECT_ARTICLE_BY_ID, [id]) as ArticleRow | undefined;
      if (row === undefined) {
        return undefined;
      }
      const sources = connection
        .all(SELECT_SOURCES_BY_ARTICLE, [id])
        .map((source) => toSourceReference(source as ArticleRow));
      return toArticle(row, sources);
    });
  }

  async findAll(): Promise<Article[]> {
    return this.database.query((connection) => {
      const rows = connection.all(SELECT_ALL_ARTICLES) as ArticleRow[];
      const sourcesByArticle = groupSourcesByArticle(connection);
      return rows.map((row) => toArticle(row, sourcesByArticle.get(requiredString(row.id)) ?? []));
    });
  }

  async has(id: string): Promise<boolean> {
    return this.database.query(
      (connection) =>
        connection.get('SELECT 1 AS present FROM articles WHERE id = ?', [id]) !== undefined,
    );
  }

  async delete(id: string): Promise<void> {
    this.database.transaction((connection) => {
      connection.run('DELETE FROM articles WHERE id = ?', [id]);
    });
  }

  async clear(): Promise<void> {
    this.database.transaction((connection) => {
      // `article_sources` cascades from the foreign key, so this leaves nothing
      // orphaned without a second statement.
      connection.run('DELETE FROM articles');
    });
  }

  async count(): Promise<number> {
    return this.database.query((connection) => {
      const row = connection.get('SELECT COUNT(*) AS total FROM articles') as
        { total: unknown } | undefined;
      return row === undefined ? 0 : toNumber(row.total);
    });
  }

  /**
   * Writes one article and its provenance inside the caller's transaction.
   *
   * Provenance is normalised first, then upserted, then the primary flag is moved.
   * Existing rows are never deleted: a later save carrying fewer sources cannot
   * shrink what is already stored, and an identity that is merely omitted keeps
   * its row.
   *
   * `source_order` is assigned per identity, not per array position. An identity
   * already present keeps the order it was first given, so re-ordering the input
   * cannot renumber history; only genuinely new identities take `next++`. This is
   * why the input array position is not used: an article that already holds
   * A(order 1), B(order 2) and is then saved as [NEW, A] must give NEW order 3,
   * not order 1, which is taken.
   */
  private writeArticle(connection: SqliteTransaction, article: Article): void {
    connection.run(UPSERT_ARTICLE, [
      article.id,
      article.title,
      article.url,
      article.canonicalUrl,
      article.publishedAt,
      article.publishedAtIsEstimated ? 1 : 0,
      article.fetchedAt,
      article.summaryRaw ?? null,
      article.summaryText ?? null,
      article.publishedAtRaw ?? null,
      article.guid ?? null,
      article.author ?? null,
      article.language ?? null,
      article.tags === undefined ? null : JSON.stringify(article.tags),
      article.imageUrl ?? null,
    ]);

    // Collapse same-batch duplicates before ordering: two entries sharing one
    // identity must consume a single `source_order`, not two.
    const normalized = normalizeSourceReferences(article.sources);

    const existingOrders = new Map<string, number>();
    let next = 1;
    for (const raw of connection.all(SELECT_SOURCE_ORDERS, [article.id])) {
      const row = raw as ArticleRow;
      const sourceOrder = toNumber(row.source_order);
      existingOrders.set(sourceIdentityKeyFromRow(row), sourceOrder);
      if (sourceOrder >= next) next = sourceOrder + 1;
    }

    for (const source of normalized) {
      const order = existingOrders.get(sourceIdentityKey(source)) ?? next++;
      connection.run(UPSERT_SOURCE, [
        article.id,
        source.sourceId,
        source.url,
        source.resolvedUrl,
        source.canonicalUrl,
        toGuidKey(source.guid),
        source.guid ?? null,
        article.fetchedAt,
        order,
      ]);
    }

    // Only move the flag when the article names a primary. An empty `sources`
    // list must not strip the primary from provenance that is already stored:
    // that would lose information the append-only rule protects.
    const primary = normalized[0];
    if (primary !== undefined) {
      const guidKey = toGuidKey(primary.guid);
      const present = connection.get(SELECT_PRIMARY_SOURCE, [
        article.id,
        primary.sourceId,
        primary.canonicalUrl,
        guidKey,
      ]);
      // Checked before `CLEAR_PRIMARY`: clearing first and then missing would
      // leave the article with no primary at all.
      if (present === undefined) {
        throw new Error('Primary provenance identity does not exist');
      }

      connection.run(CLEAR_PRIMARY, [article.id]);
      connection.run(SET_PRIMARY, [article.id, primary.sourceId, primary.canonicalUrl, guidKey]);
    }
  }
}

/** Loads every provenance row once and buckets it by article id. */
function groupSourcesByArticle(connection: SqliteQuery): Map<string, ArticleSourceReference[]> {
  const grouped = new Map<string, ArticleSourceReference[]>();
  for (const raw of connection.all(SELECT_ALL_SOURCES)) {
    const row = raw as ArticleRow;
    const articleId = requiredString(row.article_id);
    const existing = grouped.get(articleId);
    if (existing === undefined) {
      grouped.set(articleId, [toSourceReference(row)]);
    } else {
      existing.push(toSourceReference(row));
    }
  }
  return grouped;
}
