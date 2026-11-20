import { describe, expect, it } from 'vitest';

import { AppError, NotFoundError } from '../../../src/core/errors.js';

describe('AppError', () => {
  it('applies default values', () => {
    const error = new AppError('something failed');

    expect(error).toBeInstanceOf(Error);
    expect(error.message).toBe('something failed');
    expect(error.statusCode).toBe(500);
    expect(error.code).toBe('INTERNAL_ERROR');
    expect(error.expose).toBe(false);
  });

  it('honors provided options', () => {
    const error = new AppError('bad input', {
      statusCode: 422,
      code: 'VALIDATION_ERROR',
      expose: true,
    });

    expect(error.statusCode).toBe(422);
    expect(error.code).toBe('VALIDATION_ERROR');
    expect(error.expose).toBe(true);
  });

  it('propagates the cause when supplied', () => {
    const cause = new Error('root cause');
    const error = new AppError('wrapped', { cause });

    expect(error.cause).toBe(cause);
  });

  it('leaves cause undefined when not supplied', () => {
    const error = new AppError('no cause');

    expect(error.cause).toBeUndefined();
  });

  it('sets name to the concrete subclass name', () => {
    expect(new AppError('x').name).toBe('AppError');
    expect(new NotFoundError().name).toBe('NotFoundError');
  });
});

describe('NotFoundError', () => {
  it('uses the 404 / NOT_FOUND / exposed defaults', () => {
    const error = new NotFoundError();

    expect(error.statusCode).toBe(404);
    expect(error.code).toBe('NOT_FOUND');
    expect(error.expose).toBe(true);
    expect(error.message).toBe('Route not found');
  });

  it('accepts a custom message', () => {
    const error = new NotFoundError('Article not found');

    expect(error.message).toBe('Article not found');
  });
});
