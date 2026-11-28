import { describe, expect, it } from 'vitest';

import { formatTelegramMessage } from '../../../../src/modules/notification/telegram.formatter.js';
import {
  createTelegramProvider,
  TELEGRAM_API_ORIGIN,
  TelegramSendError,
  type TelegramTransport,
} from '../../../../src/modules/notification/telegram.provider.js';

/**
 * The provider against a fake transport.
 *
 * The transport is the only seam, so a fake is enough to cover every path the
 * provider decides: what it sends, what it accepts, and what it refuses. No
 * socket is opened and the real credential is never needed.
 */
const TOKEN = 'test-token-123';
const CHAT_ID = '-1001234567890';
const SOURCE_URL = 'https://example.com/news/story-42';

const ARTICLE = {
  articleId: 'a1',
  titleZh: '繁體中文標題',
  summaryZh: '這是一段繁體中文短摘要。',
  at: '2026-02-01T00:00:00.000Z',
  sourceUrl: SOURCE_URL,
};

interface SentRequest {
  url: string;
  body: string;
  headers: Record<string, string>;
}

function fakeTransport(result: { status: number; body: string } | Error): {
  calls: SentRequest[];
  transport: TelegramTransport;
} {
  const calls: SentRequest[] = [];
  return {
    calls,
    transport: {
      async send(url, init) {
        calls.push({ url, body: init.body, headers: init.headers });
        if (result instanceof Error) {
          throw result;
        }
        return result;
      },
    },
  };
}

function provider(
  overrides: { botToken?: string | undefined; chatId?: string | undefined },
  transport: TelegramTransport,
) {
  return createTelegramProvider(
    {
      botToken: 'botToken' in overrides ? overrides.botToken : TOKEN,
      chatId: 'chatId' in overrides ? overrides.chatId : CHAT_ID,
    },
    transport,
  );
}

describe('createTelegramProvider — a successful send', () => {
  it('posts to the documented endpoint and returns the message id', async () => {
    const { calls, transport } = fakeTransport({
      status: 200,
      body: JSON.stringify({ ok: true, result: { message_id: 321 } }),
    });

    const result = await provider({}, transport).send(ARTICLE);

    expect(result).toEqual({ messageId: 321 });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(`${TELEGRAM_API_ORIGIN}/bot${TOKEN}/sendMessage`);
    expect(calls[0]?.headers['content-type']).toBe('application/json');
  });

  it('sends the formatted message, not a second rendering of it', async () => {
    const { calls, transport } = fakeTransport({
      status: 200,
      body: JSON.stringify({ ok: true, result: { message_id: 1 } }),
    });

    await provider({}, transport).send(ARTICLE);

    expect(JSON.parse(calls[0]?.body ?? '{}')).toEqual({
      chat_id: CHAT_ID,
      text: formatTelegramMessage(ARTICLE),
    });
  });
});

describe('createTelegramProvider — failures', () => {
  it('reports api_rejected when Telegram answers ok=false', async () => {
    const { transport } = fakeTransport({
      status: 200,
      body: JSON.stringify({ ok: false, description: 'chat not found' }),
    });

    await expect(provider({}, transport).send(ARTICLE)).rejects.toMatchObject({
      name: 'TelegramSendError',
      reason: 'api_rejected',
      message: 'Telegram refused the message: chat not found',
    });
  });

  it('reports http_status for a non-2xx answer', async () => {
    const { transport } = fakeTransport({ status: 502, body: 'bad gateway' });

    await expect(provider({}, transport).send(ARTICLE)).rejects.toMatchObject({
      reason: 'http_status',
      message: 'Telegram answered HTTP 502',
    });
  });

  it('reports network when the transport throws', async () => {
    const { transport } = fakeTransport(new Error('ECONNREFUSED'));

    await expect(provider({}, transport).send(ARTICLE)).rejects.toMatchObject({
      reason: 'network',
    });
  });

  it('reports timeout when the call is aborted', async () => {
    const { transport } = fakeTransport(new DOMException('aborted', 'AbortError'));

    await expect(provider({}, transport).send(ARTICLE)).rejects.toMatchObject({
      reason: 'timeout',
    });
  });

  it('reports invalid_response for a body that is not JSON', async () => {
    const { transport } = fakeTransport({ status: 200, body: '<html>oops</html>' });

    await expect(provider({}, transport).send(ARTICLE)).rejects.toMatchObject({
      reason: 'invalid_response',
    });
  });

  it('reports invalid_response when ok is true but no message id is present', async () => {
    const { transport } = fakeTransport({
      status: 200,
      body: JSON.stringify({ ok: true, result: {} }),
    });

    await expect(provider({}, transport).send(ARTICLE)).rejects.toMatchObject({
      reason: 'invalid_response',
    });
  });

  it('never puts the bot token in the error it raises', async () => {
    const { transport } = fakeTransport({ status: 500, body: '' });

    const error = await provider({}, transport)
      .send(ARTICLE)
      .then(() => undefined)
      .catch((thrown: TelegramSendError) => thrown);

    expect(error).toBeInstanceOf(TelegramSendError);
    expect(error?.message).not.toContain(TOKEN);
    expect(error?.message).not.toContain(TELEGRAM_API_ORIGIN);
  });
});

describe('createTelegramProvider — configuration and content', () => {
  it.each([
    ['a missing token', { botToken: undefined }],
    ['a blank token', { botToken: '   ' }],
    ['a missing chat id', { chatId: undefined }],
    ['a blank chat id', { chatId: '' }],
  ])('reports not_configured for %s, before any I/O', async (_label, overrides) => {
    const { calls, transport } = fakeTransport({
      status: 200,
      body: JSON.stringify({ ok: true, result: { message_id: 1 } }),
    });

    await expect(provider(overrides, transport).send(ARTICLE)).rejects.toMatchObject({
      reason: 'not_configured',
    });
    expect(calls).toEqual([]);
  });

  it('reports missing_content for an article without a link, before any I/O', async () => {
    const { calls, transport } = fakeTransport({
      status: 200,
      body: JSON.stringify({ ok: true, result: { message_id: 1 } }),
    });

    await expect(
      provider({}, transport).send({ ...ARTICLE, sourceUrl: null }),
    ).rejects.toMatchObject({ reason: 'missing_content', message: expect.stringContaining('a1') });
    expect(calls).toEqual([]);
  });
});
