import { formatTelegramMessage, type TelegramArticleInput } from './telegram.formatter.js';

/**
 * The one permitted destination for a Telegram send.
 *
 * A module constant rather than a parameter, for the same reason the Gemini
 * transport fixes its origin: a caller cannot point this provider at another host.
 */
export const TELEGRAM_API_ORIGIN = 'https://api.telegram.org';

/** Deadline for one `sendMessage` call. Telegram usually answers in well under a second. */
export const TELEGRAM_SEND_TIMEOUT_MS = 10_000;

/**
 * Why a send did not produce a message id.
 *
 * A closed union so a caller can act on the reason without matching on message
 * text. `not_configured` and `missing_content` are decided before any I/O; the
 * rest come from the round trip.
 */
export type TelegramSendFailureReason =
  | 'not_configured'
  | 'missing_content'
  | 'network'
  | 'timeout'
  | 'http_status'
  | 'api_rejected'
  | 'invalid_response';

/**
 * A send that did not happen.
 *
 * The message never contains the bot token or the request URL: both carry the
 * credential, and an error that leaks it ends up in logs.
 */
export class TelegramSendError extends Error {
  readonly reason: TelegramSendFailureReason;

  constructor(
    reason: TelegramSendFailureReason,
    message: string,
    options: { readonly cause?: unknown } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.reason = reason;
    this.name = 'TelegramSendError';
  }
}

/**
 * The HTTP seam.
 *
 * Dumb on purpose: it performs the request and reports the status and body. Every
 * judgement about what those mean — and every error this module raises — belongs
 * to the provider above it, which is what makes a fake transport sufficient to
 * test the whole contract.
 */
export interface TelegramTransport {
  send(
    url: string,
    init: {
      readonly body: string;
      readonly headers: Record<string, string>;
      readonly signal: AbortSignal;
    },
  ): Promise<{ readonly status: number; readonly body: string }>;
}

/** The production transport: global `fetch`, no SDK, no retries. */
export function createTelegramTransport(): TelegramTransport {
  return {
    async send(url, init): Promise<{ status: number; body: string }> {
      const response = await fetch(url, {
        method: 'POST',
        headers: init.headers,
        body: init.body,
        signal: init.signal,
      });
      return { status: response.status, body: await response.text() };
    },
  };
}

/**
 * Configuration for one provider.
 *
 * Both values are injected rather than read from `process.env` here, so
 * environment access stays in `config/env.ts` and a test can supply placeholders
 * without touching the real environment.
 */
export interface TelegramProviderConfig {
  readonly botToken: string | undefined;
  readonly chatId: string | undefined;
  /** Defaults to `TELEGRAM_SEND_TIMEOUT_MS`. */
  readonly timeoutMs?: number;
}

export interface TelegramProvider {
  /** Sends one derived article. Resolves with the id Telegram assigned to it. */
  send(article: TelegramArticleInput): Promise<{ readonly messageId: number }>;
}

function isAbortError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { name?: unknown }).name === 'AbortError'
  );
}

/** The subset of Telegram's response this provider reads. */
interface TelegramResponseBody {
  ok?: unknown;
  result?: { message_id?: unknown };
  description?: unknown;
}

function parseBody(body: string): TelegramResponseBody | undefined {
  try {
    const parsed: unknown = JSON.parse(body);
    return typeof parsed === 'object' && parsed !== null
      ? (parsed as TelegramResponseBody)
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Builds a provider bound to one bot, one chat and one transport.
 *
 * The formatter decides what the message says and whether it can be sent at all;
 * this provider decides only whether the round trip succeeded. Keeping the split
 * means a message never changes shape between a test and production.
 */
export function createTelegramProvider(
  config: TelegramProviderConfig,
  transport: TelegramTransport = createTelegramTransport(),
): TelegramProvider {
  const botToken = (config.botToken ?? '').trim();
  const chatId = (config.chatId ?? '').trim();
  const timeoutMs = config.timeoutMs ?? TELEGRAM_SEND_TIMEOUT_MS;

  return {
    async send(article: TelegramArticleInput): Promise<{ readonly messageId: number }> {
      if (botToken === '' || chatId === '') {
        throw new TelegramSendError(
          'not_configured',
          'Telegram delivery needs both TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID',
        );
      }

      const text = formatTelegramMessage(article);
      if (text === null) {
        throw new TelegramSendError(
          'missing_content',
          `Article ${article.articleId} has no title, summary or link to send`,
        );
      }

      let response: { readonly status: number; readonly body: string };
      try {
        response = await transport.send(`${TELEGRAM_API_ORIGIN}/bot${botToken}/sendMessage`, {
          body: JSON.stringify({ chat_id: chatId, text }),
          headers: { 'content-type': 'application/json' },
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (error) {
        if (isAbortError(error)) {
          throw new TelegramSendError('timeout', 'Telegram did not answer before the deadline', {
            cause: error,
          });
        }
        throw new TelegramSendError('network', 'Could not reach the Telegram Bot API', {
          cause: error,
        });
      }

      if (response.status < 200 || response.status >= 300) {
        throw new TelegramSendError('http_status', `Telegram answered HTTP ${response.status}`);
      }

      const payload = parseBody(response.body);
      if (payload === undefined) {
        throw new TelegramSendError('invalid_response', 'Telegram answered with a non-JSON body');
      }

      if (payload.ok !== true) {
        const description =
          typeof payload.description === 'string' && payload.description.trim() !== ''
            ? `: ${payload.description}`
            : '';
        throw new TelegramSendError('api_rejected', `Telegram refused the message${description}`);
      }

      const messageId = payload.result?.message_id;
      if (typeof messageId !== 'number' || !Number.isInteger(messageId)) {
        throw new TelegramSendError(
          'invalid_response',
          'Telegram reported success without a message id',
        );
      }

      return { messageId };
    },
  };
}
