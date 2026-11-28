import type { Request, RequestHandler, Response } from 'express';

import type { ApiErrorBody, DerivedArticleResponse } from '../../types/api.js';
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
