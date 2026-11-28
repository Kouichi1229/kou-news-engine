import type { Request, RequestHandler, Response } from 'express';

import type {
  ApiErrorBody,
  DerivedArticleListResponse,
  DerivedArticleResponse,
} from '../../types/api.js';
import { DERIVATION_CATEGORIES, type DerivationCategory } from './derivation.service.js';
import type {
  ArticleDerivedDraft,
  ArticleDerivedRepository,
} from './repository/article-derived.repository.js';

function toResponse(draft: ArticleDerivedDraft): DerivedArticleResponse {
  return {
    articleId: draft.articleId,
    titleZh: draft.titleZh,
    summaryZh: draft.summaryZh,
    category: draft.category,
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
 * Reads the `?category=` filter.
 *
 * Three distinct answers, because the caller must tell them apart:
 *
 * - `undefined` — no filter was asked for, so serve the whole list;
 * - `null` — a filter was asked for and it is not one of the nine labels;
 * - a label — narrow the list to it.
 *
 * A repeated parameter arrives as an array and is rejected with everything else
 * unknown: guessing which of two filters a client meant would answer a question
 * nobody asked. The value is matched exactly, without trimming, so a stray space
 * is a rejected filter rather than a silently different one.
 */
function readCategoryFilter(raw: unknown): DerivationCategory | null | undefined {
  if (raw === undefined) {
    return undefined;
  }
  if (typeof raw !== 'string') {
    return null;
  }
  return (DERIVATION_CATEGORIES as readonly string[]).includes(raw)
    ? (raw as DerivationCategory)
    : null;
}

/**
 * Serves the most recently updated derived records, optionally one category.
 *
 * An empty database is a 200 with an empty list, not a 404: the collection exists
 * and is simply empty, which is a different answer from "this article has no
 * record".
 *
 * An unknown `category` is a 400, not an empty 200: an ignored filter reads to the
 * client as "this category has no articles", which is a claim the server has not
 * checked. The same ceiling and ordering apply either way.
 */
export function createDerivedArticleListController(
  repository: ArticleDerivedRepository,
): RequestHandler {
  return (req: Request, res: Response, next): void => {
    const category = readCategoryFilter(req.query['category']);

    if (category === null) {
      const body: ApiErrorBody = {
        error: {
          code: 'BAD_REQUEST',
          message: `Unknown category. Expected one of: ${DERIVATION_CATEGORIES.join(', ')}`,
        },
      };
      res.status(400).json(body);
      return;
    }

    repository.listRecent(DERIVED_ARTICLE_LIST_LIMIT, category).then(
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
