import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { EXIT_USAGE } from '../../../src/cli/exit-codes.js';

/**
 * End-to-end command-line safety, exercised through real child processes.
 *
 * A subprocess is necessary here: the guarantees under test are about module
 * evaluation order (whether `env.ts` or a database is reached at all), which a
 * same-process import cannot demonstrate — the runner's modules are already
 * loaded.
 *
 * Every case points `DATABASE_PATH` at a path inside a fresh temporary
 * directory, so a regression that opens the database is visible as a created
 * file, and the project database is never reachable.
 */
const repositoryRoot = join(import.meta.dirname, '..', '..', '..');
let directory: string | undefined;

function temporaryDirectory(): string {
  directory = mkdtempSync(join(tmpdir(), 'kou-cli-safety-'));
  return directory;
}

interface RunResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

function runCli(
  script: string,
  args: readonly string[],
  environment: Record<string, string> = {},
): RunResult {
  const result = spawnSync(
    process.execPath,
    ['--env-file-if-exists=.env', '--import', 'tsx', join('src', 'cli', script), ...args],
    {
      cwd: repositoryRoot,
      env: {
        PATH: process.env.PATH ?? '',
        HOME: process.env.HOME ?? '',
        NODE_ENV: 'test',
        ...environment,
      },
      encoding: 'utf8',
      timeout: 60_000,
    },
  );
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

afterEach(() => {
  if (directory !== undefined) {
    rmSync(directory, { recursive: true, force: true });
    directory = undefined;
  }
});

describe.each([['extract.ts'], ['ingest.ts']] as const)('%s — help', (script) => {
  it('prints usage and exits 0', () => {
    const result = runCli(script, ['--help'], {
      DATABASE_PATH: join(temporaryDirectory(), 'x.db'),
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Usage:');
    expect(result.stdout).toContain('--execute');
  });

  it('does not create the database named by DATABASE_PATH', () => {
    // The acceptance case: a help request must work even when the configured
    // database does not exist, and must not bring it into existence.
    const path = join(temporaryDirectory(), 'never-created.db');
    const result = runCli(script, ['--help'], { DATABASE_PATH: path });

    expect(result.status).toBe(0);
    expect(existsSync(path)).toBe(false);
  });

  it('works when the configured database directory does not exist', () => {
    const path = join(temporaryDirectory(), 'missing-dir', 'x.db');
    const result = runCli(script, ['--help'], { DATABASE_PATH: path });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Usage:');
    expect(existsSync(join(temporaryDirectory(), 'missing-dir'))).toBe(false);
  });

  it('works when the environment is invalid, because help precedes configuration', () => {
    const result = runCli(script, ['--help'], {
      DATABASE_PATH: join(temporaryDirectory(), 'x.db'),
      PORT: 'not-a-port',
      NODE_ENV: 'not-an-environment',
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Usage:');
    expect(result.stderr).not.toContain('Invalid environment configuration');
  });

  it('accepts -h', () => {
    const result = runCli(script, ['-h'], { DATABASE_PATH: join(temporaryDirectory(), 'x.db') });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Usage:');
  });
});

describe.each([['extract.ts'], ['ingest.ts']] as const)('%s — rejected arguments', (script) => {
  it('rejects an unknown flag with the usage exit code', () => {
    const path = join(temporaryDirectory(), 'x.db');
    const result = runCli(script, ['--frobnicate'], { DATABASE_PATH: path });

    expect(result.status).toBe(EXIT_USAGE);
    expect(result.stderr).toContain('Unknown argument');
    expect(result.stderr).toContain('Usage:');
    expect(existsSync(path)).toBe(false);
  });

  it('rejects an unknown flag even alongside --help', () => {
    const result = runCli(script, ['--help', '--frobnicate'], {
      DATABASE_PATH: join(temporaryDirectory(), 'x.db'),
    });

    expect(result.status).toBe(EXIT_USAGE);
    expect(result.stderr).toContain('--frobnicate');
  });

  it('rejects --execute combined with --dry-run', () => {
    const path = join(temporaryDirectory(), 'x.db');
    const result = runCli(script, ['--execute', '--dry-run'], { DATABASE_PATH: path });

    expect(result.status).toBe(EXIT_USAGE);
    expect(existsSync(path)).toBe(false);
  });
});
