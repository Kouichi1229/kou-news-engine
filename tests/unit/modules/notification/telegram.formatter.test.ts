import { describe, expect, it } from 'vitest';

import {
  formatTelegramMessage,
  formatTelegramMessages,
  TELEGRAM_MESSAGE_LIMIT,
  TELEGRAM_TRUNCATION_MARK,
  type TelegramArticleInput,
} from '../../../../src/modules/notification/telegram.formatter.js';

const SOURCE_URL = 'https://example.com/news/2026/02/story-42';
const AT = '2026-02-01T00:00:00.000Z';

function article(overrides: Partial<TelegramArticleInput> = {}): TelegramArticleInput {
  return {
    articleId: 'a1',
    titleZh: '繁體中文標題',
    summaryZh: '這是一段繁體中文短摘要。',
    at: AT,
    sourceUrl: SOURCE_URL,
    ...overrides,
  };
}

describe('formatTelegramMessage', () => {
  it('renders the title, the summary and the stored link', () => {
    expect(formatTelegramMessage(article())).toBe(
      ['繁體中文標題', '這是一段繁體中文短摘要。', SOURCE_URL].join('\n\n'),
    );
  });

  it('uses the link it was given, verbatim', () => {
    const other = 'https://another.example.org/path?q=1&x=2';
    const message = formatTelegramMessage(article({ sourceUrl: other }));

    expect(message).toContain(other);
    // Nothing about the article id may leak into a URL: the link is data, not a rule.
    expect(message).not.toContain('a1');
  });

  it.each(['http://example.com/story', 'https://example.com/story'])(
    'accepts the %s form',
    (sourceUrl) => {
      expect(formatTelegramMessage(article({ sourceUrl }))).toBe(
        ['繁體中文標題', '這是一段繁體中文短摘要。', sourceUrl].join('\n\n'),
      );
    },
  );

  it('trims surrounding whitespace instead of reshaping the text', () => {
    const message = formatTelegramMessage(
      article({ titleZh: '  標題  ', summaryZh: '\n摘要\n', sourceUrl: `  ${SOURCE_URL}  ` }),
    );

    expect(message).toBe(['標題', '摘要', SOURCE_URL].join('\n\n'));
  });

  describe('skips an article that cannot be sent', () => {
    it('without a link', () => {
      expect(formatTelegramMessage(article({ sourceUrl: null }))).toBeNull();
      expect(formatTelegramMessage(article({ sourceUrl: '   ' }))).toBeNull();
    });

    it('without a title', () => {
      expect(formatTelegramMessage(article({ titleZh: '   ' }))).toBeNull();
    });

    it('without a summary', () => {
      expect(formatTelegramMessage(article({ summaryZh: '' }))).toBeNull();
    });

    it.each([
      ['a whitespace-only title', { titleZh: ' \n\t ' }],
      ['an empty title', { titleZh: '' }],
      ['a whitespace-only summary', { summaryZh: '  \t\n ' }],
      ['an empty summary', { summaryZh: '' }],
    ])('with %s', (_label, overrides) => {
      expect(formatTelegramMessage(article(overrides as Partial<TelegramArticleInput>))).toBeNull();
    });

    it.each([
      ['no scheme', 'example.com/news/2026/02/story-42'],
      ['a relative path', '/news/2026/02/story-42'],
      ['a non-http scheme', 'ftp://example.com/story-42'],
      ['a script scheme', 'javascript:alert(1)'],
      ['a scheme with no host', 'https://'],
      ['plain text', 'not a url at all'],
    ])('with a link that has %s', (_label, sourceUrl) => {
      expect(formatTelegramMessage(article({ sourceUrl }))).toBeNull();
    });

    it('whose title and link alone leave no room for a summary', () => {
      expect(
        formatTelegramMessage(article({ titleZh: '長'.repeat(TELEGRAM_MESSAGE_LIMIT) })),
      ).toBeNull();
    });
  });

  describe('respects the Telegram length limit', () => {
    it('keeps a long summary inside the limit and marks the cut', () => {
      const message = formatTelegramMessage(article({ summaryZh: '摘'.repeat(5_000) }));

      expect(message).not.toBeNull();
      expect(message?.length).toBeLessThanOrEqual(TELEGRAM_MESSAGE_LIMIT);
      expect(message).toContain(TELEGRAM_TRUNCATION_MARK);
      expect(message?.startsWith('繁體中文標題\n\n')).toBe(true);
      // The link survives truncation intact: it is the part that cannot be cut.
      expect(message?.endsWith(`\n\n${SOURCE_URL}`)).toBe(true);
    });

    it('leaves a summary that exactly fills the budget untouched', () => {
      const overhead = '繁體中文標題'.length + SOURCE_URL.length + 4;
      const summary = '摘'.repeat(TELEGRAM_MESSAGE_LIMIT - overhead);
      const message = formatTelegramMessage(article({ summaryZh: summary }));

      expect(message).toBe(`繁體中文標題\n\n${summary}\n\n${SOURCE_URL}`);
      expect(message?.length).toBe(TELEGRAM_MESSAGE_LIMIT);
      expect(message).not.toContain(TELEGRAM_TRUNCATION_MARK);
    });

    it('never splits a surrogate pair when cutting', () => {
      const summary = `${'😀'.repeat(3_000)}尾`;
      const message = formatTelegramMessage(article({ summaryZh: summary }));

      expect(message).not.toBeNull();
      expect(message?.length).toBeLessThanOrEqual(TELEGRAM_MESSAGE_LIMIT);
      // A lone surrogate would make the string round-trip differently through UTF-8.
      expect(Buffer.from(message ?? '', 'utf8').toString('utf8')).toBe(message);
    });
  });
});

describe('formatTelegramMessages', () => {
  it('returns one message per sendable article and drops the rest', () => {
    const messages = formatTelegramMessages([
      article({ articleId: 'a1' }),
      article({ articleId: 'a2', sourceUrl: null }),
      article({ articleId: 'a3', titleZh: '第三篇標題' }),
    ]);

    expect(messages).toHaveLength(2);
    expect(messages[0]).toContain('繁體中文標題');
    expect(messages[1]).toContain('第三篇標題');
  });

  it('returns an empty list rather than an error when nothing is sendable', () => {
    expect(formatTelegramMessages([article({ sourceUrl: null })])).toEqual([]);
    expect(formatTelegramMessages([])).toEqual([]);
  });
});
