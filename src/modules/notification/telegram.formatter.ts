import type { ArticleDerivedDraft } from '../derivation/repository/article-derived.repository.js';

/**
 * Telegram's limit for one `sendMessage` text, in UTF-16 code units.
 *
 * Telegram rejects a longer message outright, so a formatter that ignores this
 * turns a long summary into a failed delivery rather than a shorter message.
 */
export const TELEGRAM_MESSAGE_LIMIT = 4_096;

/** Appended when the summary had to be cut, so a reader sees it is incomplete. */
export const TELEGRAM_TRUNCATION_MARK = '…';

const SEPARATOR = '\n\n';

/**
 * One derived article, plus the original link taken from the database.
 *
 * `sourceUrl` is `articles.url` (or `article_contents.final_url` — whichever the
 * caller read), and is never derived from the article id here: a link this module
 * invented would look valid and point nowhere.
 */
export type TelegramArticleInput = ArticleDerivedDraft & {
  readonly sourceUrl: string | null;
};

/**
 * Whether the stored link is something Telegram can send as a link.
 *
 * Uses the platform `URL` parser rather than a validation package: the question is
 * exactly "does this parse, and is the scheme http or https", and a regex over
 * URLs is a well-known way to be wrong. `ftp:`, `javascript:`, a bare
 * `example.com/x` and a relative path are all rejected, and so is `https://` with
 * no host.
 */
function isHttpUrl(value: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return false;
  }
  return (parsed.protocol === 'http:' || parsed.protocol === 'https:') && parsed.hostname !== '';
}

function fitSummary(summary: string, budget: number): string {
  if (summary.length <= budget) {
    return summary;
  }
  if (budget <= 1) {
    return '';
  }

  // Iterating a string yields code points, so a surrogate pair is never cut in
  // half; one unit is reserved for the truncation mark.
  const kept: string[] = [];
  let used = 0;
  for (const character of summary) {
    if (used + character.length > budget - 1) {
      break;
    }
    kept.push(character);
    used += character.length;
  }
  return `${kept.join('')}${TELEGRAM_TRUNCATION_MARK}`;
}

/**
 * Renders one article as a Telegram message, or `null` when it cannot be sent.
 *
 * The message is the derived title, the summary, then the original link, each on
 * its own block. A missing title, summary or link means there is no message worth
 * sending, and `null` says so without an error: a caller skips the article and
 * moves on.
 *
 * Validation happens here, before anything is sent: a blank title or summary, and
 * a link that is not an http(s) URL, all yield `null`. The checks live in the one
 * place every caller already goes through, so no path can skip them and reach the
 * network with content that should never have been published.
 *
 * The summary is the only part that yields to the length limit. The title and the
 * link are what make the message identifiable, so an article whose title and link
 * alone do not fit is skipped rather than sent without its summary.
 */
export function formatTelegramMessage(article: TelegramArticleInput): string | null {
  const title = article.titleZh.trim();
  const summary = article.summaryZh.trim();
  const sourceUrl = (article.sourceUrl ?? '').trim();

  if (title.length === 0 || summary.length === 0 || !isHttpUrl(sourceUrl)) {
    return null;
  }

  const budget = TELEGRAM_MESSAGE_LIMIT - title.length - sourceUrl.length - SEPARATOR.length * 2;
  if (budget <= 0) {
    return null;
  }

  const body = fitSummary(summary, budget);
  if (body.length === 0) {
    return null;
  }

  return `${title}${SEPARATOR}${body}${SEPARATOR}${sourceUrl}`;
}

/**
 * Renders every article it can, dropping the ones that cannot be sent.
 *
 * The drop is silent by design: an article missing a link is a data condition, not
 * a delivery error, and reporting it as one would turn a partial batch into a
 * failure.
 */
export function formatTelegramMessages(
  articles: Iterable<TelegramArticleInput>,
): readonly string[] {
  const messages: string[] = [];
  for (const article of articles) {
    const message = formatTelegramMessage(article);
    if (message !== null) {
      messages.push(message);
    }
  }
  return messages;
}
