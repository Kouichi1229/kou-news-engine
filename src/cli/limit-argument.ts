import { MAX_EXTRACT_LIMIT, MIN_EXTRACT_LIMIT } from '../config/constants.js';

/**
 * `--limit <n>` parsing for `extract`.
 *
 * Mirrors `category-argument.ts`: the flag is lifted out of the argument vector
 * here, and the rest is handed to `parseCliArgs`, so an unknown flag is still
 * rejected by the shared parser. Keeping this out of `args.ts` leaves that module
 * import-free, which is what lets `--help` answer before `env.ts` is evaluated.
 */
export interface ParsedLimitArgument {
  /** The remaining arguments, with the flag and its value removed. */
  readonly rest: readonly string[];
  /** Absent when `--limit` was not given: the caller's default applies. */
  readonly limit?: number;
}

export type LimitArgumentResult =
  | { readonly kind: 'ok'; readonly argument: ParsedLimitArgument }
  | { readonly kind: 'error'; readonly message: string };

/**
 * Lifts `--limit <n>` out of an argument vector.
 *
 * The value must be a whole number of articles within the documented range. A
 * rejected value is a usage error rather than a silent fallback: a cron line that
 * asks for 500 articles should fail loudly, not quietly process five.
 */
export function parseLimitArgument(argv: readonly string[]): LimitArgumentResult {
  const at = argv.indexOf('--limit');
  if (at === -1) {
    return { kind: 'ok', argument: { rest: argv } };
  }

  const raw = argv[at + 1];
  // Only a following flag counts as "no value"; a negative number is a value that
  // the range check rejects with a clearer message.
  if (raw === undefined || raw.startsWith('--')) {
    return { kind: 'error', message: 'The --limit flag needs a value.' };
  }

  const rest = argv.filter((_, index) => index !== at && index !== at + 1);
  if (rest.includes('--limit')) {
    return { kind: 'error', message: 'The --limit flag may be given only once.' };
  }

  const limit = Number(raw);
  if (!Number.isInteger(limit) || limit < MIN_EXTRACT_LIMIT || limit > MAX_EXTRACT_LIMIT) {
    return {
      kind: 'error',
      message: `The --limit value must be a whole number from ${String(MIN_EXTRACT_LIMIT)} to ${String(MAX_EXTRACT_LIMIT)}; got "${raw}".`,
    };
  }

  return { kind: 'ok', argument: { rest, limit } };
}
