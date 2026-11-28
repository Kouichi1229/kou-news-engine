import { describe, expect, it } from 'vitest';

import { loadEnv } from '../../../src/config/env.js';
import {
  DEFAULT_DATABASE_PATH,
  DEFAULT_HOST,
  DEFAULT_PORT,
  DEFAULT_TIMEZONE,
} from '../../../src/config/constants.js';
import { validEnvSource } from '../../helpers/env.js';

describe('loadEnv', () => {
  it('parses a complete valid source', () => {
    const env = loadEnv(
      validEnvSource({
        NODE_ENV: 'production',
        PORT: '8080',
        HOST: '127.0.0.1',
        LOG_LEVEL: 'warn',
        APP_TIMEZONE: 'Asia/Tokyo',
        DATABASE_PATH: '/var/lib/kou-news/test.db',
      }),
    );

    expect(env).toEqual({
      NODE_ENV: 'production',
      PORT: 8080,
      HOST: '127.0.0.1',
      LOG_LEVEL: 'warn',
      APP_TIMEZONE: 'Asia/Tokyo',
      DATABASE_PATH: '/var/lib/kou-news/test.db',
      SHUTDOWN_TIMEOUT_MS: 8000,
      LLM_PROVIDER: 'fake',
      LLM_MODEL: 'default',
      LLM_TIMEOUT_MS: 30000,
      LLM_MAX_OUTPUT_TOKENS: 2048,
      GEMINI_API_KEY: undefined,
      TELEGRAM_BOT_TOKEN: undefined,
      TELEGRAM_CHAT_ID: undefined,
    });
  });

  it('applies defaults when variables are absent', () => {
    const env = loadEnv({});

    expect(env).toEqual({
      NODE_ENV: 'development',
      PORT: DEFAULT_PORT,
      HOST: DEFAULT_HOST,
      LOG_LEVEL: 'info',
      APP_TIMEZONE: DEFAULT_TIMEZONE,
      DATABASE_PATH: DEFAULT_DATABASE_PATH,
      SHUTDOWN_TIMEOUT_MS: 8000,
      LLM_PROVIDER: 'fake',
      LLM_MODEL: 'default',
      LLM_TIMEOUT_MS: 30000,
      LLM_MAX_OUTPUT_TOKENS: 2048,
      GEMINI_API_KEY: undefined,
      TELEGRAM_BOT_TOKEN: undefined,
      TELEGRAM_CHAT_ID: undefined,
    });
  });

  it('coerces the PORT string into a number', () => {
    const env = loadEnv(validEnvSource({ PORT: '3001' }));

    expect(env.PORT).toBe(3001);
    expect(typeof env.PORT).toBe('number');
  });

  it.each([
    ['non-numeric', 'abc'],
    ['zero', '0'],
    ['negative', '-1'],
    ['above max', '70000'],
    ['non-integer', '3000.5'],
  ])('rejects an invalid PORT (%s)', (_label, port) => {
    expect(() => loadEnv(validEnvSource({ PORT: port }))).toThrowError(
      /Invalid environment configuration/,
    );
  });

  it('rejects an unknown NODE_ENV', () => {
    expect(() => loadEnv(validEnvSource({ NODE_ENV: 'staging' }))).toThrowError(
      /Invalid environment configuration/,
    );
  });

  it('rejects an unknown LOG_LEVEL', () => {
    expect(() => loadEnv(validEnvSource({ LOG_LEVEL: 'verbose' }))).toThrowError(
      /Invalid environment configuration/,
    );
  });

  it('rejects an empty HOST', () => {
    expect(() => loadEnv(validEnvSource({ HOST: '' }))).toThrowError(
      /Invalid environment configuration/,
    );
  });

  it('rejects an empty APP_TIMEZONE', () => {
    expect(() => loadEnv(validEnvSource({ APP_TIMEZONE: '' }))).toThrowError(
      /Invalid environment configuration/,
    );
  });

  it('defaults DATABASE_PATH to the bundled default', () => {
    expect(loadEnv({}).DATABASE_PATH).toBe(DEFAULT_DATABASE_PATH);
  });

  it('rejects an empty DATABASE_PATH', () => {
    expect(() => loadEnv(validEnvSource({ DATABASE_PATH: '' }))).toThrowError(
      /Invalid environment configuration/,
    );
  });

  it('includes the offending field path in the error message', () => {
    expect(() => loadEnv(validEnvSource({ PORT: 'abc' }))).toThrowError(/PORT/);
  });
});
