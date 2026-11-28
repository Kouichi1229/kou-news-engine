import { Router } from 'express';

import type { ArticleDerivedRepository } from './repository/article-derived.repository.js';
import { createDerivedArticleController } from './derived-article.controller.js';

/**
 * Builds the router for reading one article's derived record.
 *
 * Mounted onto the shared `/api` router, so the public path is
 * `GET /api/articles/:articleId/derived`.
 */
export function createDerivedArticleRouter(repository: ArticleDerivedRepository): Router {
  const router: Router = Router();

  router.get('/articles/:articleId/derived', createDerivedArticleController(repository));

  return router;
}
