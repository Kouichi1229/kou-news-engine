import { describe, expect, it } from 'vitest';

import { createTelegramProvider } from '../../../src/modules/notification/telegram.provider.js';

/**
 * Opt-in: the real Telegram Bot API.
 *
 * Skipped unless `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID` are both present, so
 * the default suite never contacts Telegram and never needs the credential. When
 * it does run it posts one message to the configured chat — that is the point of
 * the test, and the reason it is opt-in rather than part of `npm test` with a
 * fake.
 *
 * Run it with:
 *   TELEGRAM_BOT_TOKEN=... TELEGRAM_CHAT_ID=... npx vitest run tests/integration/notification
 */
const botToken = process.env['TELEGRAM_BOT_TOKEN'];
const chatId = process.env['TELEGRAM_CHAT_ID'];
const configured =
  typeof botToken === 'string' &&
  botToken.trim() !== '' &&
  typeof chatId === 'string' &&
  chatId.trim() !== '';

describe.skipIf(!configured)('Telegram Bot API — real send', () => {
  it('sends one message and returns its message id', async () => {
    const provider = createTelegramProvider({
      botToken,
      chatId,
      timeoutMs: 15_000,
    });

    const result = await provider.send({
      articleId: 'integration-test',
      titleZh: '整合測試訊息',
      summaryZh: `由自動化測試送出的單筆訊息，時間 ${new Date().toISOString()}。`,
      at: new Date().toISOString(),
      sourceUrl: 'https://example.com/integration-test',
    });

    expect(Number.isInteger(result.messageId)).toBe(true);
    expect(result.messageId).toBeGreaterThan(0);
  }, 20_000);

  it('surfaces a rejection for an unusable chat id', async () => {
    const provider = createTelegramProvider({
      botToken,
      chatId: '0',
      timeoutMs: 15_000,
    });

    await expect(
      provider.send({
        articleId: 'integration-test',
        titleZh: '整合測試訊息',
        summaryZh: '這一則應該被 Telegram 拒絕。',
        at: new Date().toISOString(),
        sourceUrl: 'https://example.com/integration-test',
      }),
    ).rejects.toMatchObject({ name: 'TelegramSendError' });
  }, 20_000);
});

// Documents the default: an environment without the credential runs nothing here.
describe.skipIf(configured)('Telegram Bot API — real send (no credential)', () => {
  it('is skipped without TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID', () => {
    expect(configured).toBe(false);
  });
});
