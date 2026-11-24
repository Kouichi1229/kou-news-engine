import express, { type Express, type Request, type Response } from 'express';

import { createApp } from '../../src/app.js';
import { errorHandler } from '../../src/core/http/error-handler.js';
import { notFoundHandler } from '../../src/core/http/not-found.js';

export function buildTestApp(): Express {
  return createApp();
}

export function buildAppWithFailingRoute(): Express {
  const app = express();
  app.use(express.json());
  app.get('/boom', () => {
    throw new Error('unexpected failure');
  });
  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}

export function buildAppWithEchoRoute(): Express {
  const app = express();
  app.use(express.json());
  app.post('/echo', (req: Request, res: Response) => {
    res.status(200).json({ received: req.body });
  });
  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}
