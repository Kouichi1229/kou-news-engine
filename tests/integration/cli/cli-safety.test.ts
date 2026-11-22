import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, sep } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { EXIT_USAGE } from '../../../src/cli/exit-codes.js';
import { assertNoDatabaseFiles, requireNetCounts, spawnCli } from './harness.js';

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

/**
 * T-11a and T-11b — `--help` isolation.
 *
 * Each case runs the real entry point in a child process behind the network guard.
 * A subprocess is the only place the claim is observable: the test runner has
 * already evaluated its own modules, so a same-process import cannot show that
 * `env.ts` was skipped.
 *
 * The isolation evidence is an environment that **would** fail validation. Help
 * still exits 0 with no configuration error, which cannot happen if `loadEnv()`
 * ran. Asserting "no error appeared" alone would be weak; pairing it with an
 * environment that must produce an error is what makes it evidential.
 */
describe.each([
  ['T-11a', 'extract.ts'],
  ['T-11b', 'ingest.ts'],
] as const)('%s — %s --help entry isolation', (testId, script) => {
  const cases: Array<{ databasePath: string; directory: string }> = [];

  function newCase(): { databasePath: string; directory: string } {
    const directory = mkdtempSync(join(tmpdir(), 'kou-t11-help-'));
    const entry = { databasePath: join(directory, 'help.db'), directory };
    cases.push(entry);
    return entry;
  }

  afterEach(() => {
    for (const entry of cases.splice(0)) {
      rmSync(entry.directory, { recursive: true, force: true });
    }
  });

  it(`${testId} prints usage and exits 0 without creating database files`, () => {
    const { databasePath, directory } = newCase();
    const before = readdirSync(directory);

    const result = spawnCli({
      script,
      args: ['--help'],
      databasePath,
      temporaryDirectory: directory,
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Usage:');
    expect(result.stdout).toContain('--execute');
    expect(result.stdout).toContain('--dry-run');

    assertNoDatabaseFiles(databasePath);
    // Nothing else appeared either, so a stray file cannot hide behind the three
    // names checked above.
    expect(readdirSync(directory)).toEqual(before);
  });

  it(`${testId} answers --help under an invalid environment, proving env.ts is never evaluated`, () => {
    const { databasePath, directory } = newCase();

    const result = spawnCli({
      script,
      args: ['--help'],
      databasePath,
      temporaryDirectory: directory,
      environment: { NODE_ENV: 'not-an-environment', PORT: 'not-a-port' },
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Usage:');
    // If `loadEnv()` had run, this string would be on stderr and the exit nonzero.
    expect(result.stderr).not.toContain('Invalid environment configuration');
    expect(result.stderr).not.toContain('crashed before it could report an outcome');
    assertNoDatabaseFiles(databasePath);
  });

  it(`${testId} performs zero network calls on every intercepted API`, () => {
    const { databasePath, directory } = newCase();

    const result = spawnCli({
      script,
      args: ['--help'],
      databasePath,
      temporaryDirectory: directory,
      // A key is supplied so the absence of a network call is not merely a
      // consequence of a credential being missing.
      environment: { LLM_PROVIDER: 'gemini', GEMINI_API_KEY: 'test-key-not-real' },
    });

    const counts = requireNetCounts(result);
    expect(result.status).toBe(0);
    // Every intercepted member, named explicitly: a loop over keys would pass if
    // the guard stopped reporting one of them.
    expect(counts['fetch']).toBe(0);
    expect(counts['httpRequest']).toBe(0);
    expect(counts['httpGet']).toBe(0);
    expect(counts['httpsRequest']).toBe(0);
    expect(counts['httpsGet']).toBe(0);
    expect(counts['dnsLookup']).toBe(0);
    expect(counts['dnsPromisesLookup']).toBe(0);
    expect(counts['netConnect']).toBe(0);
    expect(counts['tlsConnect']).toBe(0);
  });

  it(`${testId} constructs no provider and reads no Gemini key`, () => {
    const { databasePath, directory } = newCase();

    // `LLM_PROVIDER=gemini` with no key: entering the provider path would raise
    // `LlmConfigurationError`, so a clean exit 0 rules it out.
    const result = spawnCli({
      script,
      args: ['--help'],
      databasePath,
      temporaryDirectory: directory,
      environment: { LLM_PROVIDER: 'gemini' },
    });

    expect(result.status).toBe(0);
    expect(result.combined).not.toContain('GEMINI_API_KEY');
    expect(result.combined).not.toContain('LlmConfigurationError');
    expect(result.combined).not.toContain('The Gemini provider adapter is not implemented');
  });
});

/**
 * Positive control for the network guard shared by T-11a..T-11d.
 *
 * A guard that never fires and a guard that could never fire are
 * indistinguishable from the counters alone: both report zero. This case proves
 * the interception is real, and it is labelled separately because it exercises
 * the guard mechanism rather than any CLI behaviour.
 *
 * A loopback server is started, the guard blocks a request to it, and the
 * original is restored so the same request must succeed. The second half is what
 * makes the result meaningful: without it, `blocked` could simply mean the port
 * was unreachable. `blocked,reached` shows the refusal came from the guard.
 *
 * Loopback only. No external host is contacted.
 */
describe('network guard positive control — shared by T-11a..T-11d', () => {
  const root = join(import.meta.dirname, '..', '..', '..');
  const probe = join(root, 'tests', 'fixtures', 'cli-config-probe.ts');

  it('blocks a guarded request and lets the same request through when restored', () => {
    const directory = mkdtempSync(join(tmpdir(), 'kou-guard-selfcheck-'));
    const databasePath = join(directory, 'selfcheck.db');

    try {
      // Fail-closed, as the CLI tests are: never spawn unless the path is inside
      // this test's own directory. The control opens no database, but the same
      // mistake that once reached the real file is worth excluding here too.
      expect(isAbsolute(databasePath)).toBe(true);
      expect(databasePath.startsWith(`${directory}${sep}`)).toBe(true);

      // Dispatch mode, not `PROBE_MODE=guard`: this case *is* the entry point, so
      // it can reach the self-check. `spawnCli` is not used for that reason.
      const result = spawnSync(process.execPath, ['--import', 'tsx', probe, 'network-self-check'], {
        cwd: root,
        env: {
          PATH: process.env['PATH'] ?? '',
          HOME: process.env['HOME'] ?? '',
          NODE_ENV: 'test',
          DATABASE_PATH: databasePath,
        },
        encoding: 'utf8',
        timeout: 60_000,
      });

      expect(result.status).toBe(0);
      const stderr = result.stderr ?? '';

      // `blocked` proves the guard intercepted; `reached` proves the server was
      // actually there, so the block was the guard's doing and not a dead port.
      const selfCheck = /PROBE_SELFCHECK=(\w+),(\w+)/.exec(stderr);
      expect(selfCheck).not.toBeNull();
      expect(selfCheck?.[1]).toBe('blocked');
      expect(selfCheck?.[2]).toBe('reached');

      // The blocked attempt is counted, so the counters are demonstrably live
      // rather than structurally stuck at zero. A missing line is a failure, not
      // an implicit zero — the same rule the CLI tests apply.
      const countsLine = /PROBE_NET_COUNTS=(\{.*\})/.exec(stderr);
      expect(countsLine).not.toBeNull();
      const counts = JSON.parse(countsLine?.[1] ?? '{}') as Record<string, number>;
      expect(counts['httpRequest']).toBeGreaterThan(0);

      assertNoDatabaseFiles(databasePath);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
