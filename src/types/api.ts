export interface ApiErrorBody {
  error: {
    code: string;
    message: string;
  };
}

export interface HealthResponse {
  status: 'ok';
  service: string;
  version: string;
  uptimeSeconds: number;
  timestamp: string;
}

export interface ReadyResponse {
  status: 'ready' | 'not_ready';
  checks: Record<string, unknown>;
  timestamp: string;
}

/**
 * One article's derived record.
 *
 * Every field is a column of `article_derived` as the repository reports it; the
 * response adds nothing the store does not hold.
 */
export interface DerivedArticleResponse {
  articleId: string;
  titleZh: string;
  summaryZh: string;
  /** When this record was last written, ISO 8601. */
  updatedAt: string;
}
