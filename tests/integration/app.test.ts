import request from 'supertest';
import { describe, expect, it } from 'vitest';

import { buildAppWithEchoRoute, buildTestApp } from '../helpers/test-app.js';

describe('application wiring', () => {
  it('does not advertise the framework via x-powered-by', async () => {
    const response = await request(buildTestApp()).get('/api/health');

    expect(response.headers['x-powered-by']).toBeUndefined();
  });

  it('mounts routes under the /api base path', async () => {
    const mounted = await request(buildTestApp()).get('/api/health');
    const unmounted = await request(buildTestApp()).get('/health');

    expect(mounted.status).toBe(200);
    expect(unmounted.status).toBe(404);
  });

  it('returns 404 with the standard envelope for unknown routes', async () => {
    const response = await request(buildTestApp()).get('/api/unknown');

    expect(response.status).toBe(404);
    expect(response.body).toEqual({
      error: { code: 'NOT_FOUND', message: 'Route not found' },
    });
  });

  it('parses JSON request bodies through express.json()', async () => {
    const response = await request(buildAppWithEchoRoute())
      .post('/echo')
      .set('Content-Type', 'application/json')
      .send({ message: 'hello' });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ received: { message: 'hello' } });
  });
});
