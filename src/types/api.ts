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

/**
 * The derived-record list.
 *
 * A named field rather than a bare array so a later addition has somewhere to go
 * without changing the type of the response body.
 */
export interface DerivedArticleListResponse {
  articles: DerivedArticleResponse[];
}
