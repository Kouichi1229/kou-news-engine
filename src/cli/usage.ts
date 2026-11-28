/**
 * Usage text shared by the one-shot CLIs.
 *
 * Kept in one module with no imports so the entry points can print it before
 * `env.ts` is evaluated, before a database is opened, and before any signal
 * handler is installed.
 */

export const COMMON_FLAGS = `  --help, -h   Show this message and exit. Opens no database.
  --dry-run    Preview only. Reads the database read-only, writes nothing,
               and makes no network requests. This is the default.
  --execute    Perform real work. The only flag that may write to the database
               or send requests.`;

/**
 * Flags for a command that has no preview mode (`D-4b`).
 *
 * `--dry-run` is absent deliberately: it is rejected rather than accepted as a
 * no-op, because a scheduler must be able to tell a completed run from an
 * invocation that never did any work (`D-4a`).
 */
export const EXECUTE_ONLY_FLAGS = `  --help, -h   Show this message and exit. Opens no database.
  --execute    Perform real work. Required: there is no preview mode.`;

export interface UsageOptions {
  /**
   * When true, the command has no dry-run and `--execute` is mandatory.
   *
   * Defaults to false, which keeps the existing output byte-for-byte identical
   * for the commands that do have a preview.
   */
  executeRequired?: boolean;
}

export function usageFor(command: string, description: string, options: UsageOptions = {}): string {
  if (options.executeRequired === true) {
    return `Usage: ${command} [--help | --execute]

${description}

Options:
${EXECUTE_ONLY_FLAGS}

There is no preview mode and no default mode. An external scheduler must pass
--execute explicitly; every other invocation exits 2 without opening a database.
`;
  }

  return `Usage: ${command} [--help | --dry-run | --execute]

${description}

Options:
${COMMON_FLAGS}

With no arguments the command runs a dry-run preview, never real work. A
scheduler must pass --execute explicitly.
`;
}
