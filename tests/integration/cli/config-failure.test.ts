import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * Import-time environment configuration failures.
 *
 * Every case runs in a child process. The test runner's own environment is
 * already valid, so importing the modules here would prove nothing about what
 * happens when `loadEnv` rejects. The child is given an explicit environment and
 * a fetch guard, so neither a real feed nor the project database is reachable.
 */
const repositoryRoot = join(import.meta.dirname, '..', '..', '..');
const probe = join(repositoryRoot, 'tests', 'fixtures', 'cli-config-probe.ts');

interface ProbeResult {
  status: number | null;
  stdout: string;
  stderr: string;
  /** Both streams: the logger sends `info` to stdout and `error`/`warn` to stderr. */
  combined: string;
  fetchCalls: number;
}

function runProbe(
  target: 'library' | 'entry',
  environment: Record<string, string>,
  args: readonly string[] = [],
): ProbeResult {
  const result = spawnSync(process.execPath, ['--import', 'tsx', probe, target, ...args], {
    cwd: repositoryRoot,
    env: {
      // A minimal, valid baseline. `PATH` is kept so Node can find its own
      // dependencies; nothing else from the runner leaks in.
      PATH: process.env.PATH ?? '',
      HOME: process.env.HOME ?? '',
      // Pinned to a path outside the repository so a regression in the fix
      // cannot make a child open the real `data/kou-news.db`.
      DATABASE_PATH: join(tmpdir(), 'kou-config-probe-never-created.db'),
      // Every case below overrides whatever it needs to make invalid.
      NODE_ENV: 'test',
      ...environment,
    },
    encoding: 'utf8',
    timeout: 60_000,
  });

  const fetchMatch = /PROBE_FETCH_CALLS=(\d+)/.exec(result.stderr);

  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
    combined: `${result.stdout}\n${result.stderr}`,
    fetchCalls: fetchMatch === null ? -1 : Number(fetchMatch[1]),
  };
}

describe('CLI module evaluation — invalid configuration', () => {
  it('imports the CLI library without evaluating environment configuration', () => {
    const result = runProbe('library', { NODE_ENV: 'not-a-real-environment' });

    // The import itself must succeed: a static `env` import anywhere in the
    // library's dependency graph would throw here.
    expect(result.stderr).toContain('PROBE_IMPORT_OK');
    expect(result.stderr).not.toContain('PROBE_IMPORT_FAILED');
    expect(result.status).toBe(0);
  });

  it('imports the CLI library when a numeric variable is out of range', () => {
    // A different validation failure, to prove the deferral is not specific to
    // the enum check.
    const result = runProbe('library', { PORT: '99999' });

    expect(result.stderr).toContain('PROBE_IMPORT_OK');
    expect(result.status).toBe(0);
  });

  it('reaches its error handler instead of failing during module evaluation', () => {
    const result = runProbe('entry', { NODE_ENV: 'not-a-real-environment' });

    // The entry point's own diagnostic, which can only be produced by the
    // `.catch` — an uncaught module-evaluation error would print a stack trace
    // and never reach it.
    expect(result.stderr).toContain('Ingestion CLI crashed before it could report an outcome');
    expect(result.stderr).toContain('Invalid environment configuration');
    expect(result.stderr).toContain('NODE_ENV');

    // Node's uncaught-exception banner would indicate the old path.
    expect(result.stderr).not.toContain('throw new Error');
    expect(result.stderr).not.toMatch(/at ModuleJob\.run/);
  });

  it('reports the structured diagnostic on stderr as one JSON line', () => {
    const result = runProbe('entry', { NODE_ENV: 'not-a-real-environment' });

    const line = result.stderr
      .split('\n')
      .find((candidate) => candidate.includes('crashed before it could report an outcome'));

    expect(line).toBeDefined();
    const parsed = JSON.parse(line ?? '{}') as { level?: string; message?: string; error?: string };
    expect(parsed.level).toBe('error');
    expect(parsed.message).toBe('Ingestion CLI crashed before it could report an outcome');
    expect(parsed.error).toContain('Invalid environment configuration');
  });

  it('exits 1 on invalid configuration', () => {
    const result = runProbe('entry', { NODE_ENV: 'not-a-real-environment' });

    expect(result.status).toBe(1);
  });

  it('does not fetch or start ingestion when configuration is invalid', () => {
    const result = runProbe('entry', { NODE_ENV: 'not-a-real-environment' });

    // The probe counts every `fetch` call; zero means no source was contacted.
    expect(result.fetchCalls).toBe(0);
    // And the run never began: this log line is emitted by `runIngestion`.
    expect(result.stdout).not.toContain('Ingestion run started');
    expect(result.stderr).not.toContain('Ingestion run started');
  });

  it('exits 1 and reports no fetch when a numeric variable is invalid', () => {
    const result = runProbe('entry', { PORT: '99999' });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Invalid environment configuration');
    expect(result.fetchCalls).toBe(0);
  });
});

describe('CLI module evaluation — valid configuration', () => {
  it('imports the entry point and starts a run with a valid environment', () => {
    // A valid environment with an unwritable database directory: the run starts,
    // fails at initialization, and never touches a feed. This is the only case
    // that proves normal execution still reaches `createRuntime`.
    // `--execute` because the default is now a dry-run, which never builds the
    // runtime. This case exists to prove the real path is still reachable.
    const result = runProbe('entry', { DATABASE_PATH: '/etc/hostname/x.db' }, ['--execute']);

    expect(result.stderr).toContain('PROBE_IMPORT_OK');
    expect(result.combined).toContain('initialization-failure');
    expect(result.status).toBe(1);
    expect(result.fetchCalls).toBe(0);
  });

  it('distinguishes a configuration failure from a runtime initialization failure', () => {
    const configuration = runProbe('entry', { NODE_ENV: 'not-a-real-environment' });
    const initialization = runProbe('entry', { DATABASE_PATH: '/etc/hostname/x.db' }, [
      '--execute',
    ]);

    // Configuration: the CLI never ran, so no outcome was classified.
    expect(configuration.stderr).toContain('crashed before it could report an outcome');
    expect(configuration.combined).not.toContain('initialization-failure');

    // Initialization: the CLI ran and classified the failure as its own outcome.
    expect(initialization.combined).toContain('initialization-failure');
    expect(initialization.stderr).not.toContain('crashed before it could report an outcome');

    // Both are failures, so a supervisor sees the same nonzero code.
    expect(configuration.status).toBe(1);
    expect(initialization.status).toBe(1);
  });
});
