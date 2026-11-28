import type { SqliteDatabase } from '../../../core/persistence/sqlite.js';
import type { DerivationCategory } from '../derivation.service.js';
import type {
  ArticleDerivedDraft,
  ArticleDerivedRepository,
} from './article-derived.repository.js';

/**
 * The `article_derived` table.
 *
 * The upsert is what makes re-derivation safe: the primary key is the article
 * id, so a second attempt refreshes the text and `updated_at` without creating a
 * duplicate and without losing the original `created_at`.
 */
export class SqliteArticleDerivedRepository implements ArticleDerivedRepository {
  private readonly database: SqliteDatabase;

  constructor(database: SqliteDatabase) {
    this.database = database;
  }

  async findArticleTitle(articleId: string): Promise<string | undefined> {
    const row = this.database.query((connection) =>
      connection.get('SELECT title FROM articles WHERE id = ?', [articleId]),
    ) as { title: string } | undefined;
    return row?.title;
  }

  async findByArticleId(articleId: string): Promise<ArticleDerivedDraft | undefined> {
    const row = this.database.query((connection) =>
      connection.get(
        `SELECT article_id, title_zh, summary_zh, category, updated_at
           FROM article_derived
          WHERE article_id = ?`,
        [articleId],
      ),
    ) as
      | {
          article_id: string;
          title_zh: string;
          summary_zh: string;
          category: string | null;
          updated_at: string;
        }
      | undefined;

    if (row === undefined) {
      return undefined;
    }
    return {
      articleId: row.article_id,
      titleZh: row.title_zh,
      summaryZh: row.summary_zh,
      category: row.category as DerivationCategory | null,
      at: row.updated_at,
    };
  }

  async listRecent(limit: number): Promise<readonly ArticleDerivedDraft[]> {
    const rows = this.database.query((connection) =>
      connection.all(
        `SELECT article_id, title_zh, summary_zh, category, updated_at
           FROM article_derived
          ORDER BY updated_at DESC, article_id ASC
          LIMIT ?`,
        [limit],
      ),
    ) as Array<{
      article_id: string;
      title_zh: string;
      summary_zh: string;
      category: string | null;
      updated_at: string;
    }>;

    return rows.map((row) => ({
      articleId: row.article_id,
      titleZh: row.title_zh,
      summaryZh: row.summary_zh,
      category: row.category as DerivationCategory | null,
      at: row.updated_at,
    }));
  }

  async save(draft: ArticleDerivedDraft): Promise<void> {
    this.database.query((connection) => {
      connection.all(
        `INSERT INTO article_derived
           (article_id, title_zh, summary_zh, category, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (article_id) DO UPDATE
           SET title_zh   = excluded.title_zh,
               summary_zh = excluded.summary_zh,
               category   = excluded.category,
               updated_at = excluded.updated_at`,
        [draft.articleId, draft.titleZh, draft.summaryZh, draft.category, draft.at, draft.at],
      );
    });
  }
}
