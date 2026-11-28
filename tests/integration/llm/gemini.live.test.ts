import { describe, expect, it } from 'vitest';

import { createProvider } from '../../../src/core/llm/provider.factory.js';
import type { LlmProvider } from '../../../src/core/llm/llm.provider.js';
import type { LlmResponse } from '../../../src/core/llm/llm.types.js';

/**
 * Live check against the real Gemini Interactions API.
 *
 * Opt-in twice over: `GEMINI_LIVE_TEST=1` and a real `GEMINI_API_KEY`. Without
 * both the suite is skipped, so `npm test` never needs a credential and never
 * reaches the network. Only a failure here means the adapter disagrees with the
 * live service; a skip means nothing at all.
 *
 * Run it with:
 *   GEMINI_LIVE_TEST=1 GEMINI_API_KEY=... npx vitest run tests/integration/llm
 */
const apiKey = process.env['GEMINI_API_KEY'] ?? '';
const enabled = process.env['GEMINI_LIVE_TEST'] === '1' && apiKey !== '';

async function liveProvider(): Promise<LlmProvider> {
  return createProvider(
    { provider: 'gemini', model: 'default', timeoutMs: 60_000, apiKey },
    {
      createTransport: async () => {
        const { createGeminiTransport } =
          await import('../../../src/core/llm/providers/gemini.transport.js');
        return createGeminiTransport({ apiKey, timeoutMs: 60_000 });
      },
    },
  );
}

describe.skipIf(!enabled)('Gemini Interactions API — live', () => {
  it('returns model text and usage from POST /v1beta/interactions', async () => {
    const provider = await liveProvider();
    expect(provider.id).toBe('gemini');
    expect(provider.model).toBe('default');

    const response: LlmResponse = await provider.complete({
      prompt: '請只回覆四個字，不要加標點：測試成功',
      systemInstruction: '你是繁體中文助理，只輸出使用者要求的內容。',
      maxOutputTokens: 64,
    });

    expect(response.text).toContain('測試成功');
    expect(response.truncated).toBe(false);
    expect(response.usage.totalTokens).toBeGreaterThan(0);
    expect(response.durationMs).toBeGreaterThan(0);
  }, 90_000);
});
