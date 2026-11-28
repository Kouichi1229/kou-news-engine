import { Router } from 'express';

import { createDerivedArticleRouter } from '../modules/derivation/derived-article.routes.js';
import type { ArticleDerivedRepository } from '../modules/derivation/repository/article-derived.repository.js';
import { createHealthRouter } from '../modules/health/health.routes.js';
import type { ReadinessProbe } from '../modules/health/readiness.js';

export interface ApiRouterOptions {
  /** Readiness dependencies exposed by `/api/ready`. Empty when none are wired. */
  readinessProbes?: readonly ReadinessProbe[];
  /**
   * Reads derived records for `/api/articles/:articleId/derived`.
   *
   * Absent means the route is not mounted at all, which keeps `createApp()` free
   * of a database it was never given — an unwired app answers 404 rather than a
   * 500 it cannot explain.
   */
  derivedArticles?: ArticleDerivedRepository;
}

/** Builds the `/api` router with the dependencies of one app instance. */
export function createApiRouter(options: ApiRouterOptions = {}): Router {
  const router: Router = Router();

  router.use(createHealthRouter(options.readinessProbes ?? []));
  if (options.derivedArticles !== undefined) {
    router.use(createDerivedArticleRouter(options.derivedArticles));
  }

  return router;
}
