import { describe, expect, it } from 'vitest';

import { LlmError } from '../../../../src/core/llm/llm.errors.js';
import type { LlmProvider } from '../../../../src/core/llm/llm.provider.js';
import type { LlmRequest, LlmResponse } from '../../../../src/core/llm/llm.types.js';
import { openDatabase } from '../../../../src/core/persistence/sqlite.js';
import { createDerivationHook } from '../../../../src/modules/derivation/derivation.bootstrap.js';

/**
 * The hook's two protections: a fixed pause between real calls, and a rate-limit
 * signal the extraction loop reads before its next claim.
 *
 * Time and sleeping are injected, so the assertions are exact and no test waits
 * four seconds. The provider is scripted, so no network is involved.
 */
// The contract fixes the summary at 100-150 characters, so the fixture is built
// to length rather than typed out.
const SUMMARY_ZH = '這是一段用於測試的中文摘要內容，長度必須符合規格要求。'.repeat(5).slice(0, 120);

const VALID_OUTPUT = JSON.stringify({
  title_zh: '中文標題',
  summary_zh: SUMMARY_ZH,
  category: '科技',
});

function provider(script: ReadonlyArray<() => Promise<LlmResponse>>): LlmProvider {
  let call = 0;
  return {
    id: 'scripted',
    model: { name: 'default', vendorModelId: 'scripted-v1' },
    async complete(_request: LlmRequest): Promise<LlmResponse> {
      const step = script[call] ?? script[script.length - 1];
      call += 1;
      if (step === undefined) {
        throw new Error('script exhausted');
      }
      return step();
    },
  } as LlmProvider;
}

function okResponse(): Promise<LlmResponse> {
  return Promise.resolve({
    text: VALID_OUTPUT,
    model: 'default',
    usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
    truncated: false,
    durationMs: 5,
  });
}

function rateLimitResponse(): Promise<LlmResponse> {
  return Promise.reject(
    new LlmError('rate_limit', 'quota exceeded', { providerId: 'scripted', statusCode: 429 }),
  );
}

function insertArticle(database: ReturnType<typeof openDatabase>, id: string, order: number): void {
  database.query((connection) => {
    connection.all(
      `INSERT INTO articles
         (id, title, url, canonical_url, published_at_is_estimated, fetched_at, inserted_order)
       VALUES (?, ?, ?, ?, 0, '2026-01-01T00:00:00Z', ?)`,
      [id, `Title ${id}`, `https://example.com/${id}`, `https://example.com/${id}`, order],
    );
  });
}

async function hookWith(
  script: ReadonlyArray<() => Promise<LlmResponse>>,
  options: { cooldownMs?: number } = {},
) {
  const database = openDatabase({ path: ':memory:' });
  // The derivation service refuses an id with no `articles` row.
  insertArticle(database, 'a1', 1);
  insertArticle(database, 'a2', 2);
  let now = 1_000_000;
  const sleeps: number[] = [];
  let rateLimits = 0;

  const hook = await createDerivationHook({
    database,
    now: (): number => now,
    log: { info: (): void => undefined, warn: (): void => undefined },
    provider: provider(script),
    cooldownMs: options.cooldownMs ?? 4_000,
    sleep: async (ms: number): Promise<void> => {
      sleeps.push(ms);
      now += ms;
    },
    onRateLimit: (): void => {
      rateLimits += 1;
    },
  });

  return {
    hook,
    sleeps,
    rateLimitCount: (): number => rateLimits,
    advance: (ms: number): void => {
      now += ms;
    },
    close: (): void => database.close(),
  };
}

describe('createDerivationHook — pacing between real calls', () => {
  it('does not wait before the first call', async () => {
    const fixture = await hookWith([okResponse]);
    try {
      await fixture.hook.deriveArticle?.('a1', 'body text');
      expect(fixture.sleeps).toEqual([]);
    } finally {
      fixture.close();
    }
  });

  it('waits the full interval between two back-to-back calls', async () => {
    const fixture = await hookWith([okResponse, okResponse]);
    try {
      await fixture.hook.deriveArticle?.('a1', 'body text');
      await fixture.hook.deriveArticle?.('a2', 'body text');
      expect(fixture.sleeps).toEqual([4_000]);
    } finally {
      fixture.close();
    }
  });

  it('shortens the wait by the time already spent on the previous call', async () => {
    const fixture = await hookWith([okResponse, okResponse]);
    try {
      await fixture.hook.deriveArticle?.('a1', 'body text');
      // Three of the four seconds elapsed inside the previous call.
      fixture.advance(3_000);
      await fixture.hook.deriveArticle?.('a2', 'body text');
      expect(fixture.sleeps).toEqual([1_000]);
    } finally {
      fixture.close();
    }
  });

  it('never waits when the interval has already elapsed', async () => {
    const fixture = await hookWith([okResponse, okResponse]);
    try {
      await fixture.hook.deriveArticle?.('a1', 'body text');
      fixture.advance(10_000);
      await fixture.hook.deriveArticle?.('a2', 'body text');
      expect(fixture.sleeps).toEqual([]);
    } finally {
      fixture.close();
    }
  });
});

describe('createDerivationHook — a 429 stops the run', () => {
  it('signals the rate limit once and rethrows, so the attempt is recorded', async () => {
    const fixture = await hookWith([rateLimitResponse]);
    try {
      await expect(fixture.hook.deriveArticle?.('a1', 'body text')).rejects.toMatchObject({
        kind: 'rate_limit',
        statusCode: 429,
      });
      expect(fixture.rateLimitCount()).toBe(1);
    } finally {
      fixture.close();
    }
  });

  it('does not signal a rate limit for an unrelated failure', async () => {
    const fixture = await hookWith([
      () =>
        Promise.reject(
          new LlmError('authentication', 'bad key', { providerId: 'scripted', statusCode: 401 }),
        ),
    ]);
    try {
      await expect(fixture.hook.deriveArticle?.('a1', 'body text')).rejects.toMatchObject({
        kind: 'authentication',
      });
      expect(fixture.rateLimitCount()).toBe(0);
    } finally {
      fixture.close();
    }
  });
});
