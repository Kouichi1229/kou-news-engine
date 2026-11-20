import request from 'supertest';
import { describe, expect, it } from 'vitest';

import { APP_NAME, APP_VERSION } from '../../src/config/constants.js';
import { buildTestApp } from '../helpers/test-app.js';

describe('GET /api/health', () => {
  it('returns 200 with the documented liveness shape', async () => {
    const response = await request(buildTestApp()).get('/api/health');

    expect(response.status).toBe(200);
    expect(response.headers['content-type']).toMatch(/application\/json/);
    expect(response.body).toMatchObject({
      status: 'ok',
      service: APP_NAME,
      version: APP_VERSION,
    });
    expect(typeof response.body.uptimeSeconds).toBe('number');
    expect(typeof response.body.timestamp).toBe('string');
  });
});

describe('GET /api/ready', () => {
  it('returns 200 with an empty checks object', async () => {
    const response = await request(buildTestApp()).get('/api/ready');

    expect(response.status).toBe(200);
    expect(response.body.status).toBe('ready');
    expect(response.body.checks).toEqual({});
    expect(typeof response.body.timestamp).toBe('string');
  });
});
