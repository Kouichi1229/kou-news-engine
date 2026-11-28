import { Router } from 'express';

import type { ArticleDerivedRepository } from './repository/article-derived.repository.js';
import {
  createDerivedArticleController,
  createDerivedArticleListController,
} from './derived-article.controller.js';

/**
 * Builds the router for reading derived records.
 *
 * Mounted onto the shared `/api` router, so the public paths are
 * `GET /api/articles/derived` and `GET /api/articles/:articleId/derived`.
 */
export function createDerivedArticleRouter(repository: ArticleDerivedRepository): Router {
  const router: Router = Router();

  // Registered first only for readability: the two paths differ in segment count,
  // so neither can shadow the other.
  router.get('/articles/derived', createDerivedArticleListController(repository));
  router.get('/articles/:articleId/derived', createDerivedArticleController(repository));

  return router;
}
