import type { DerivationCategory } from '../modules/derivation/derivation.service.js';

/**
 * `--category <category>` parsing, shared by the two notification entry points.
 *
 * Both `notify` and `notify-scheduled` publish through the same flow and accept the
 * same flag, so the flag's rules — one label, from the closed list, rejected loudly
 * otherwise — live in one place. Two copies would eventually disagree about which
 * spellings are legal.
 *
 * ## Why the vocabulary is imported dynamically
 *
 * `env.ts` validates `process.env` the moment it is evaluated, and the entry points
 * must answer a bad command line without configuration. A call that names a
 * category outside the list therefore has to be rejected before anything reaches
 * `env.ts` or a database. Only the type import is static, because types are erased.
 *
 * ## Why three failures instead of one
 *
 * A missing value, a repeated flag and an unknown label are different mistakes and
 * get different messages, so an operator can fix the cron line from the output
 * alone. All three exit `2` at the entry point.
 */
export interface ParsedCategoryArgument {
  /** The remaining arguments, with the flag and its value removed. */
  readonly rest: readonly string[];
  /**
   * The validated category.
   *
   * Absent when `--category` was not given: that run is the unfiltered one.
   */
  readonly category?: DerivationCategory;
}

export type CategoryArgumentResult =
  | { readonly kind: 'ok'; readonly argument: ParsedCategoryArgument }
  | { readonly kind: 'error'; readonly message: string };

/**
 * Lifts `--category <value>` out of an argument vector and validates the label.
 *
 * The remaining arguments are returned untouched, so the caller can still hand
 * them to `parseCliArgs` and keep rejecting flags it does not know. The `--flag=value`
 * spelling is deliberately not recognised: it stays in `rest` and is therefore
 * rejected as an unknown argument rather than silently accepted in two forms.
 */
export async function parseCategoryArgument(
  argv: readonly string[],
): Promise<CategoryArgumentResult> {
  const at = argv.indexOf('--category');
  if (at === -1) {
    return { kind: 'ok', argument: { rest: argv } };
  }

  const value = argv[at + 1];
  if (value === undefined || value.startsWith('-')) {
    return { kind: 'error', message: 'The --category flag needs a value.' };
  }

  const rest = argv.filter((_, index) => index !== at && index !== at + 1);
  if (rest.includes('--category')) {
    return { kind: 'error', message: 'The --category flag may be given only once.' };
  }

  const { DERIVATION_CATEGORIES } = await import('../modules/derivation/derivation.service.js');
  if (!(DERIVATION_CATEGORIES as readonly string[]).includes(value)) {
    return {
      kind: 'error',
      message: `Unknown category "${value}". Expected one of: ${DERIVATION_CATEGORIES.join(', ')}.`,
    };
  }

  return {
    kind: 'ok',
    argument: { rest, category: value as DerivationCategory },
  };
}
