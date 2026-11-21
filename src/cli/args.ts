/**
 * Argument parsing shared by the one-shot CLIs.
 *
 * ## Why the default is dry-run
 *
 * Both CLIs have an external side effect: ingestion fetches feeds, extraction
 * fetches article pages. Neither may be triggered by an ambiguous command line.
 * A flag that is misspelled, forgotten, or invented by a stale runbook must not
 * start real work, so the parser only ever grants execution to the one literal
 * `--execute` token. Every other successful parse yields `dry-run`.
 *
 * ## Why this module imports nothing
 *
 * `env.ts` validates `process.env` when it is evaluated, and `sqlite.ts` opens
 * (and migrates) a database on import of the composition root. Parsing therefore
 * has to complete before either is reached, so `--help` can be answered on a
 * machine with no configuration and no database. Keeping this module free of
 * imports is what makes that ordering enforceable rather than a convention.
 */

/** The requested mode. Only `execute` may cause writes or network traffic. */
export type CliMode = 'help' | 'dry-run' | 'execute';

export type ParsedArgs =
  | { readonly mode: 'help' }
  | { readonly mode: 'dry-run' }
  | { readonly mode: 'execute' }
  | { readonly mode: 'usage-error'; readonly message: string };

/**
 * Flags that name a mode. `--help` is not one: it is answered on its own.
 *
 * A `Map` rather than an object literal because lookups must not consult the
 * prototype chain: `argument in MODE_FLAGS` would be true for `constructor` or
 * `toString`, which would then be read as a mode and return a function.
 */
const MODE_FLAGS = new Map<string, CliMode>([
  ['--dry-run', 'dry-run'],
  ['--execute', 'execute'],
]);

/**
 * Parses CLI arguments.
 *
 * The whole vector is validated before any mode is chosen, so an unknown
 * argument is reported even when `--help` is also present. Answering `--help`
 * for `--help --typo` would tell the operator their command was understood when
 * it was not, and would hide a typo that a scheduler depends on.
 *
 * @param argv arguments excluding the executable and script path.
 */
export function parseCliArgs(argv: readonly string[]): ParsedArgs {
  if (argv.length === 0) {
    return { mode: 'dry-run' };
  }

  const unknown = argv.filter(
    (argument) => argument !== '--help' && argument !== '-h' && !MODE_FLAGS.has(argument),
  );
  if (unknown.length > 0) {
    return {
      mode: 'usage-error',
      message: `Unknown argument${unknown.length > 1 ? 's' : ''}: ${unknown.join(', ')}`,
    };
  }

  const wantsHelp = argv.includes('--help') || argv.includes('-h');
  const modeFlags = [...new Set(argv.filter((argument) => MODE_FLAGS.has(argument)))];

  // Repeating one flag (`--execute --execute`) is redundant, not contradictory.
  // Two different ones name two modes, and picking either would be a guess.
  if (modeFlags.length > 1) {
    return {
      mode: 'usage-error',
      message: `Conflicting arguments: ${modeFlags.join(' and ')}`,
    };
  }

  // `--help` beside a mode flag is ambiguous: the operator either wanted the
  // usage text or wanted that mode. Refusing is the only answer that cannot be
  // misread, and it keeps `--help` from being used to excuse a stray `--execute`.
  if (wantsHelp && modeFlags.length > 0) {
    return {
      mode: 'usage-error',
      message: `--help cannot be combined with ${modeFlags.join(' and ')}`,
    };
  }

  if (wantsHelp) {
    return { mode: 'help' };
  }

  const [flag] = modeFlags;
  return { mode: flag === undefined ? 'dry-run' : (MODE_FLAGS.get(flag) ?? 'dry-run') };
}
