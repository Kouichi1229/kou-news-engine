import type { SqliteDatabase } from '../../../core/persistence/sqlite.js';

/** One article already announced to Telegram. */
export interface NotificationDelivery {
  readonly articleId: string;
  readonly messageId: number;
  readonly status: 'sent' | 'failed';
  readonly createdAt: string;
}

/**
 * The delivery ledger: which articles have been announced.
 *
 * Two operations, and no third: ask whether an article was already sent, and
 * record that it was. There is no queue, no lease and no transition — a failed
 * send leaves the table untouched, which is what makes it retryable.
 */
export class SqliteNotificationDeliveryRepository {
  private readonly database: SqliteDatabase;

  constructor(database: SqliteDatabase) {
    this.database = database;
  }

  /**
   * The successful delivery for an article, if any.
   *
   * Filtered on `status = 'sent'` rather than on row existence: a row recording a
   * failure must never make the CLI skip a retry.
   */
  async findSuccessful(articleId: string): Promise<NotificationDelivery | undefined> {
    const row = this.database.query((connection) =>
      connection.get(
        `SELECT article_id, message_id, status, created_at
           FROM notification_delivery
          WHERE article_id = ? AND status = 'sent'`,
        [articleId],
      ),
    ) as
      | { article_id: string; message_id: number; status: 'sent' | 'failed'; created_at: string }
      | undefined;

    if (row === undefined) {
      return undefined;
    }

    return {
      articleId: row.article_id,
      messageId: row.message_id,
      status: row.status,
      createdAt: row.created_at,
    };
  }

  /**
   * Records a successful send.
   *
   * An upsert rather than an insert because the same article may be announced
   * again after a manual reset; the newest send is the one worth keeping, and a
   * unique-constraint failure here would turn a successful send into an error.
   */
  async recordSent(input: {
    readonly articleId: string;
    readonly messageId: number;
    readonly createdAt: string;
  }): Promise<void> {
    this.database.query((connection) =>
      connection.all(
        `INSERT INTO notification_delivery (article_id, message_id, status, created_at)
         VALUES (?, ?, 'sent', ?)
         ON CONFLICT (article_id) DO UPDATE
           SET message_id = excluded.message_id,
               status = excluded.status,
               created_at = excluded.created_at`,
        [input.articleId, input.messageId, input.createdAt],
      ),
    );
  }
}
