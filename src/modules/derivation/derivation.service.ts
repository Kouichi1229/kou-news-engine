import { z } from 'zod';

import type { LlmProvider } from '../../core/llm/llm.provider.js';
import type {
  ArticleDerivedDraft,
  ArticleDerivedRepository,
} from './repository/article-derived.repository.js';

/**
 * The output contract for one derivation call.
 *
 * `summaryChars` is the range the prompt asks for and the range the caller
 * enforces. A model that overshoots is rejected rather than truncated: a
 * summary cut off mid-sentence is worse than no summary, and silently trimming
 * would hide that the prompt needs tuning.
 */
export const DERIVATION_LIMITS = {
  minSummaryChars: 100,
  maxSummaryChars: 150,
  maxTitleChars: 200,
  /**
   * Prompt input cap. A long article is cut here, not summarised in chunks: one
   * call, one summary, and the opening of an article carries the facts a short
   * summary needs.
   */
  maxArticleChars: 20_000,
  maxOutputTokens: 1_024,
} as const;

export type DerivationFailureReason =
  'article-missing' | 'invalid-json' | 'invalid-output' | 'summary-length';

/** A derivation that produced nothing storable. Never a storage failure. */
export class DerivationError extends Error {
  readonly reason: DerivationFailureReason;

  constructor(reason: DerivationFailureReason, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.reason = reason;
    this.name = 'DerivationError';
  }
}

/**
 * The shape one completion must have before anything is stored.
 *
 * `trim()` runs before `min(1)`, so a field holding only whitespace fails the
 * check instead of being stored as an empty string, and the title cap applies to
 * the trimmed text rather than to padding the model may add.
 */
const outputSchema = z.object({
  title_zh: z.string().trim().min(1).max(DERIVATION_LIMITS.maxTitleChars),
  summary_zh: z.string().trim().min(1),
});

const SYSTEM_INSTRUCTION =
  '你是繁體中文新聞編輯。使用者會給你一篇新聞的標題與全文。' +
  '你只輸出一個 JSON 物件，不輸出任何說明、前言或 Markdown 程式碼區塊。';

/** Code points, not UTF-16 units: a CJK character counts once. */
function charCount(text: string): number {
  return [...text].length;
}

function buildPrompt(title: string, text: string): string {
  const body =
    charCount(text) > DERIVATION_LIMITS.maxArticleChars
      ? [...text].slice(0, DERIVATION_LIMITS.maxArticleChars).join('')
      : text;

  return [
    `標題：${title}`,
    '',
    '全文：',
    body,
    '',
    '請輸出下列 JSON，不要有其他文字：',
    '{"title_zh":"繁體中文標題","summary_zh":"繁體中文摘要"}',
    '',
    '規則：',
    '1. 一律使用繁體中文（台灣用語）。',
    `2. summary_zh 必須是 ${DERIVATION_LIMITS.minSummaryChars} 至 ${DERIVATION_LIMITS.maxSummaryChars} 字。`,
    '3. 只輸出 JSON。',
  ].join('\n');
}

/**
 * Parses one completion into the two stored strings.
 *
 * Tolerates a wrapping Markdown code fence because models add one even when told
 * not to; it tolerates nothing else. Both fields are trimmed before they are
 * checked, so a blank title or a blank summary is a rejection rather than a row
 * holding `''`. Any other deviation is a rejection too, so a malformed answer is
 * never written as if it were a summary.
 */
export function parseDerivationOutput(raw: string): { titleZh: string; summaryZh: string } {
  const unfenced = raw
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '');

  let parsed: unknown;
  try {
    parsed = JSON.parse(unfenced);
  } catch (cause) {
    throw new DerivationError('invalid-json', 'Model output was not valid JSON', { cause });
  }

  const result = outputSchema.safeParse(parsed);
  if (!result.success) {
    const issue = result.error.issues[0];
    throw new DerivationError(
      'invalid-output',
      `Model output did not match the contract: ${
        issue === undefined ? 'unknown issue' : `${issue.path.join('.')} ${issue.message}`
      }`,
    );
  }

  const titleZh = result.data.title_zh;
  const summaryZh = result.data.summary_zh;
  const length = charCount(summaryZh);
  if (length < DERIVATION_LIMITS.minSummaryChars || length > DERIVATION_LIMITS.maxSummaryChars) {
    throw new DerivationError(
      'summary-length',
      `Summary is ${length} characters; expected ${DERIVATION_LIMITS.minSummaryChars}-${DERIVATION_LIMITS.maxSummaryChars}`,
    );
  }

  return { titleZh, summaryZh };
}

export interface ArticleDerivationDeps {
  readonly provider: LlmProvider;
  readonly repository: ArticleDerivedRepository;
  /** Epoch milliseconds; defaults to the system clock. */
  readonly now?: (() => number) | undefined;
  readonly maxOutputTokens?: number | undefined;
}

/**
 * Produces the Traditional Chinese title and summary for one extracted article.
 *
 * One provider call, no retry, no queue and no status: the caller decides what a
 * thrown error means. The extraction process treats it as a warning, because the
 * extracted body is already committed and must not be lost to a model failure.
 */
export class ArticleDerivationService {
  private readonly deps: ArticleDerivationDeps;

  constructor(deps: ArticleDerivationDeps) {
    this.deps = deps;
  }

  async derive(articleId: string, text: string): Promise<ArticleDerivedDraft> {
    const title = await this.deps.repository.findArticleTitle(articleId);
    if (title === undefined) {
      throw new DerivationError('article-missing', `No article row for ${articleId}`);
    }

    const response = await this.deps.provider.complete({
      prompt: buildPrompt(title, text),
      systemInstruction: SYSTEM_INSTRUCTION,
      maxOutputTokens: this.deps.maxOutputTokens ?? DERIVATION_LIMITS.maxOutputTokens,
    });

    const { titleZh, summaryZh } = parseDerivationOutput(response.text);
    const draft: ArticleDerivedDraft = {
      articleId,
      titleZh,
      summaryZh,
      at: new Date(this.deps.now?.() ?? Date.now()).toISOString(),
    };

    await this.deps.repository.save(draft);
    return draft;
  }
}
