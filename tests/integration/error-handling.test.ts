import request from 'supertest';
import { describe, expect, it } from 'vitest';

import { buildAppWithFailingRoute, buildTestApp } from '../helpers/test-app.js';

describe('error handling', () => {
  it('returns 400 with BAD_REQUEST for malformed JSON bodies', async () => {
    const response = await request(buildTestApp())
      .post('/api/health')
      .set('Content-Type', 'application/json')
      .send('{ "invalid": ');

    expect(response.status).toBe(400);
    expect(response.body).toEqual({
      error: { code: 'BAD_REQUEST', message: 'Invalid JSON request body' },
    });
  });

  it('does not expose parser details in the malformed JSON response', async () => {
    const response = await request(buildTestApp())
      .post('/api/health')
      .set('Content-Type', 'application/json')
      .send('{ "invalid": ');

    const serialized = JSON.stringify(response.body);
    expect(serialized).not.toMatch(/position|line|column|SyntaxError|at /i);
  });

  it('keeps the 404 envelope for unknown routes', async () => {
    const response = await request(buildTestApp()).get('/api/does-not-exist');

    expect(response.status).toBe(404);
    expect(response.body).toEqual({
      error: { code: 'NOT_FOUND', message: 'Route not found' },
    });
  });

  it('returns 500 with a generic envelope for unexpected errors', async () => {
    const response = await request(buildAppWithFailingRoute()).get('/boom');

    expect(response.status).toBe(500);
    expect(response.body).toEqual({
      error: { code: 'INTERNAL_ERROR', message: 'Internal server error' },
    });
  });
});
