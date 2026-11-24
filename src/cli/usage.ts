/**
 * Usage text shared by both one-shot CLIs.
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

export function usageFor(command: string, description: string): string {
  return `Usage: ${command} [--help | --dry-run | --execute]

${description}

Options:
${COMMON_FLAGS}

With no arguments the command runs a dry-run preview, never real work. A
scheduler must pass --execute explicitly.
`;
}
