import type { Request, RequestHandler, Response } from 'express';

import type {
  ApiErrorBody,
  DerivedArticleListResponse,
  DerivedArticleResponse,
} from '../../types/api.js';
import type {
  ArticleDerivedDraft,
  ArticleDerivedRepository,
} from './repository/article-derived.repository.js';

function toResponse(draft: ArticleDerivedDraft): DerivedArticleResponse {
  return {
    articleId: draft.articleId,
    titleZh: draft.titleZh,
    summaryZh: draft.summaryZh,
    updatedAt: draft.at,
  };
}

/**
 * How many records the list endpoint returns at most.
 *
 * A fixed ceiling rather than a query parameter: this endpoint answers "what has
 * been derived recently", and a caller asking for everything is how one request
 * turns into an unbounded scan. Paging is a separate decision, not a knob added
 * here.
 */
export const DERIVED_ARTICLE_LIST_LIMIT = 50;

/**
 * Serves the most recently updated derived records.
 *
 * An empty database is a 200 with an empty list, not a 404: the collection exists
 * and is simply empty, which is a different answer from "this article has no
 * record".
 */
export function createDerivedArticleListController(
  repository: ArticleDerivedRepository,
): RequestHandler {
  return (_req: Request, res: Response, next): void => {
    repository.listRecent(DERIVED_ARTICLE_LIST_LIMIT).then(
      (drafts) => {
        const body: DerivedArticleListResponse = { articles: drafts.map(toResponse) };
        res.status(200).json(body);
      },
      (error: unknown) => {
        next(error);
      },
    );
  };
}

/**
 * Serves one article's derived record, or a 404 when there is none.
 *
 * A factory rather than a module-level handler: the repository belongs to the app
 * being built, and a shared handler would tie every app in the process to one
 * database.
 *
 * "No record" is a normal answer here, not an error: an article that has not been
 * derived yet, or whose derivation failed, simply has no row. Answering 404 keeps
 * that distinguishable from "the route does not exist" by body, and from "the
 * server failed" by status.
 */
export function createDerivedArticleController(
  repository: ArticleDerivedRepository,
): RequestHandler {
  return (req: Request, res: Response, next): void => {
    // Express 5 types a route parameter as `string | string[]`; this route has one
    // segment, so anything else is a request the router cannot have matched.
    const raw = req.params['articleId'];
    const articleId = typeof raw === 'string' ? raw : '';

    repository.findByArticleId(articleId).then(
      (draft) => {
        if (draft === undefined) {
          const body: ApiErrorBody = {
            error: {
              code: 'NOT_FOUND',
              message: `No derived article for ${articleId}`,
            },
          };
          res.status(404).json(body);
          return;
        }
        res.status(200).json(toResponse(draft));
      },
      (error: unknown) => {
        next(error);
      },
    );
  };
}
