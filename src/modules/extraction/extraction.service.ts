import { randomUUID } from 'node:crypto';
import { hostname as osHostname } from 'node:os';

import {
  CONCURRENCY,
  EMPTY_FAILURE_CODES,
  EXTRACTOR_VERSION,
  LEASE_MS,
  MAX_ATTEMPTS,
  MIN_CONTENT_LENGTH,
  REQUEST_TIMEOUT_MS,
} from './extraction.constants.js';
import { ExtractionFailureError } from './extraction.errors.js';
import type { ExtractionRunSummary, ExtractionSuccess } from './extraction.types.js';
import { safeFetch } from './http/safe-fetch.js';
import { looksMisDecoded } from './http/charset.js';
import type { ResolveFunction } from './http/dns-pin.js';
import { extractArticleBody, meetsMinimumLength } from './parse/html-extractor.js';
import { codePointLength, normaliseText } from './parse/text-normaliser.js';
import type { ArticleContentRepository } from './repository/article-content.repository.js';
import type { Clock } from './clock.js';
import { systemClock } from './clock.js';

/** An article whose URL is known; only what extraction needs. */
export interface ExtractionCandidate {
  articleId: string;
  url: string;
}

/** Reads the URL for a claimed article. */
export interface ArticleUrlLookup {
  findUrlById(articleId: string): Promise<string | undefined>;
}

export interface ExtractionServiceOptions {
  repository: ArticleContentRepository;
  urls: ArticleUrlLookup;
  clock?: Clock;
  /** Aborts between attempts. Never interrupts an in-flight request. */
  isCancelled?: () => boolean;
  /** DNS seam, for tests. */
  resolve?: ResolveFunction;
  /** Fetches and returns the HTML. Overridden in tests to avoid the network. */
  fetchPage?: (url: string) => Promise<{ html: string; finalUrl: string; status: number }>;
  /** Called immediately before the HTTP request leaves the process. */
  onRequestIssued?: () => void;
  /** Injected for deterministic lease tokens in tests. */
  tokenFactory?: () => string;
  concurrency?: number;
  timeoutMs?: number;
}

/**
 * Runs article extraction against the queue held in `article_contents`.
 *
 * ## The cancellation contract
 *
 * The line between "safe to cancel" and "must finish" is drawn at the HTTP
 * request:
 *
 * - **Before** the request is issued, cancellation returns the claim via
 *   `RELEASE`, which refunds the attempt. Nothing reached the remote host, so
 *   the attempt was not really spent.
 * - **After** the request is issued, cancellation is only observed at the top of
 *   the next loop. The current article finishes and writes its real outcome.
 *   Aborting mid-request would leave the remote host having done the work while
 *   this process records nothing — and refunding the attempt would let the same
 *   host be hit more than `MAX_ATTEMPTS` times.
 *
 * A second signal or a crash executes no SQL at all: the row keeps its
 * `in_progress` lease and its consumed attempt, and becomes claimable again once
 * the lease expires. That is why there is no `INTERRUPTED` state — the expired
 * lease already expresses it.
 *
 * ## Fencing
 *
 * Every write is gated on the lease token. When a write affects no rows the
 * claim was lost to another worker, whose result may already be stored. This
 * worker's outcome is then discarded and counted as `lostClaims`, never as a
 * success and never retried.
 */
export class ExtractionService {
  private readonly options: ExtractionServiceOptions;
  private readonly clock: Clock;

  constructor(options: ExtractionServiceOptions) {
    this.options = options;
    this.clock = options.clock ?? systemClock;
  }

  private get owner(): string {
    return `${osHostname()}:${process.pid}`;
  }

  private token(): string {
    return this.options.tokenFactory?.() ?? randomUUID();
  }

  /**
   * Processes claimable articles until the queue is empty or a signal arrives.
   *
   * `CONCURRENCY` is fixed at 1, so this is a serial loop. The shape is kept as
   * a loop rather than recursion so the cancellation check has an obvious place
   * to live: the top, before any claim is taken.
   */
  async run(): Promise<ExtractionRunSummary> {
    const summary: ExtractionRunSummary = {
      claimed: 0,
      extracted: 0,
      empty: 0,
      failed: 0,
      released: 0,
      lostClaims: 0,
      cancelled: false,
    };

    const concurrency = this.options.concurrency ?? CONCURRENCY;
    if (concurrency !== 1) {
      throw new Error('Only CONCURRENCY = 1 is supported');
    }

    // One attempt per article per run. Without this a failed article is
    // immediately claimable again and would burn every allowed attempt
    // back-to-back against a host that is already failing; attempts are meant to
    // accumulate across cron-invoked runs.
    const attempted = new Set<string>();

    for (;;) {
      if (this.options.isCancelled?.() === true) {
        summary.cancelled = true;
        return summary;
      }

      const claim = await this.options.repository.claim({
        owner: this.owner,
        token: this.token(),
        now: this.clock.now(),
        leaseDurationMs: LEASE_MS,
        extractorVersion: EXTRACTOR_VERSION,
        excludeArticleIds: [...attempted],
      });

      if (claim === null) {
        return summary;
      }
      summary.claimed += 1;
      attempted.add(claim.articleId);

      // Cancellation observed after the claim but before any request: the
      // attempt is refunded because nothing was sent.
      if (this.options.isCancelled?.() === true) {
        const released = await this.options.repository.release({
          articleId: claim.articleId,
          token: claim.leaseToken,
        });
        if (released) {
          summary.released += 1;
        } else {
          summary.lostClaims += 1;
        }
        summary.cancelled = true;
        return summary;
      }

      const outcome = await this.processClaim(claim.articleId, claim.leaseToken);

      switch (outcome) {
        case 'extracted':
          summary.extracted += 1;
          break;
        case 'empty':
          summary.empty += 1;
          break;
        case 'failed':
          summary.failed += 1;
          break;
        case 'lost':
          summary.lostClaims += 1;
          break;
      }
    }
  }

  /**
   * Fetches, parses and stores one article.
   *
   * Returns which counter to bump. `lost` means a fenced write affected no rows.
   */
  private async processClaim(
    articleId: string,
    token: string,
  ): Promise<'extracted' | 'empty' | 'failed' | 'lost'> {
    const url = await this.options.urls.findUrlById(articleId);
    if (url === undefined) {
      const recorded = await this.options.repository.markFailed({
        articleId,
        token,
        failure: { code: 'ARTICLE_URL_MISSING', httpStatus: null },
      });
      return recorded ? 'failed' : 'lost';
    }

    let page: { html: string; finalUrl: string; status: number };
    try {
      page = await this.fetch(url);
    } catch (error) {
      return this.recordFailure(articleId, token, error);
    }

    // A body decoded under the wrong encoding is corrupt throughout, not merely
    // noisy, so it is recorded as a failure instead of being stored as article
    // text. The parser would otherwise find enough characters to pass the
    // minimum-length gate and the damage would only surface downstream.
    if (looksMisDecoded(page.html)) {
      const recorded = await this.options.repository.markFailed({
        articleId,
        token,
        failure: { code: 'DECODE_FAILED', httpStatus: page.status },
      });
      return recorded ? 'failed' : 'lost';
    }

    const parsed = extractArticleBody(page.html, page.finalUrl);
    const extractedAt = new Date(this.clock.now()).toISOString();

    if (parsed === null || !meetsMinimumLength(parsed.length)) {
      const recorded = await this.options.repository.markEmpty({
        articleId,
        token,
        failure: {
          code: parsed === null ? 'NO_CONTENT' : 'CONTENT_TOO_SHORT',
          httpStatus: page.status,
        },
        extractedAt,
        finalUrl: page.finalUrl,
      });
      return recorded ? 'empty' : 'lost';
    }

    // The normaliser has already removed NUL, but the stored length is computed
    // from the exact string being written so the schema's
    // `content_length = length(content_text)` assertion always holds.
    const text = normaliseText(parsed.text);
    if (codePointLength(text) < MIN_CONTENT_LENGTH) {
      const recorded = await this.options.repository.markEmpty({
        articleId,
        token,
        failure: { code: 'CONTENT_TOO_SHORT', httpStatus: page.status },
        extractedAt,
        finalUrl: page.finalUrl,
      });
      return recorded ? 'empty' : 'lost';
    }

    const success: ExtractionSuccess = {
      text,
      finalUrl: page.finalUrl,
      httpStatus: page.status,
      extractedAt,
    };
    const recorded = await this.options.repository.complete({ articleId, token, success });
    return recorded ? 'extracted' : 'lost';
  }

  /** Records a fetch failure, mapping the error to a stored code. */
  private async recordFailure(
    articleId: string,
    token: string,
    error: unknown,
  ): Promise<'failed' | 'lost'> {
    const failure =
      error instanceof ExtractionFailureError
        ? { code: error.code, httpStatus: error.httpStatus }
        : { code: 'UNEXPECTED_ERROR', httpStatus: null };

    // An "empty" code can only be written through `markEmpty`, which the schema
    // requires to carry `extracted_at` and `final_url`. A fetch failure has
    // neither, so a code from that set is remapped rather than written to the
    // wrong state.
    const code = EMPTY_FAILURE_CODES.includes(failure.code) ? 'UNEXPECTED_ERROR' : failure.code;

    const recorded = await this.options.repository.markFailed({
      articleId,
      token,
      failure: { code, httpStatus: failure.httpStatus },
    });
    return recorded ? 'failed' : 'lost';
  }

  /**
   * Performs the fetch.
   *
   * `onRequestIssued` fires immediately before the request is sent, because that
   * is the moment the attempt stops being refundable: everything before it can
   * be cancelled and released, everything after must run to completion.
   */
  private async fetch(url: string): Promise<{ html: string; finalUrl: string; status: number }> {
    if (this.options.fetchPage !== undefined) {
      return this.options.fetchPage(url);
    }

    this.options.onRequestIssued?.();
    const result = await safeFetch(url, {
      timeoutMs: this.options.timeoutMs ?? REQUEST_TIMEOUT_MS,
      ...(this.options.resolve === undefined ? {} : { resolve: this.options.resolve }),
    });

    return { html: result.body.text, finalUrl: result.finalUrl, status: result.status };
  }
}

export { MAX_ATTEMPTS };
