import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const testsRoot = join(here, '..');
const probe = join(testsRoot, 'fixtures', 'database-handle-probe.ts');

/**
 * The probe inspects `/proc/self/fd`, which exists only on Linux. An open SQLite
 * handle cannot be detected any other way: it is absent from
 * `process.getActiveResourcesInfo()` and does not keep the event loop alive.
 *
 * Skipping is explicit rather than inferred from an empty directory listing. A
 * missing `/proc` makes the probe throw `ENOENT`; treating that as "no
 * descriptors" would turn an unavailable inspector into a passing leak test.
 */
const PROC_FD_DIRECTORY = '/proc/self/fd';
const isLinux = process.platform === 'linux';

const temporaryDirectories: string[] = [];

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), 'kou-news-handles-'));
  temporaryDirectories.push(directory);
  return directory;
}

interface ProbeResult {
  mode: string;
  descriptors: string[];
  error?: string;
}

/**
 * Runs the probe in a fresh process and returns what it observed.
 *
 * A separate process is what makes the result trustworthy: `/proc/self/fd` then
 * describes only the handles the probe opened. In-process inspection would see
 * the runner's own descriptors and could not distinguish a leak from them.
 */
function runProbe(mode: string, databasePath: string): ProbeResult {
  const output = execFileSync(process.execPath, ['--import', 'tsx', probe, mode, databasePath], {
    encoding: 'utf8',
    cwd: join(testsRoot, '..'),
  });
  return JSON.parse(output.trim()) as ProbeResult;
}

afterEach(() => {
  while (temporaryDirectories.length > 0) {
    const directory = temporaryDirectories.pop();
    if (directory !== undefined) {
      rmSync(directory, { recursive: true, force: true });
    }
  }
});

describe.skipIf(!isLinux)(
  `database handle cleanup after a failed initialisation (Linux only: descriptor inspection reads ${PROC_FD_DIRECTORY})`,
  () => {
    // A `describe` body runs during collection even when the suite is skipped, so
    // this check must not be an unconditional throw: on macOS and Windows it would
    // fail collection instead of skipping. Only a Linux host without procfs
    // mounted — a stripped container — reaches the throw.
    if (isLinux && !existsSync(PROC_FD_DIRECTORY)) {
      throw new Error(
        `descriptor inspection requires ${PROC_FD_DIRECTORY}, which is not present on this host`,
      );
    }

    it('detects a leaked handle, so a clean result means something', () => {
      const path = join(temporaryDirectory(), 'leak.db');

      // Positive control. Without this, an inspector that silently reports nothing
      // would make every "no leak" assertion pass for the wrong reason.
      const result = runProbe('leaked-handle', path);

      expect(result.descriptors.length).toBeGreaterThan(0);
      expect(result.descriptors.every((descriptor) => descriptor.startsWith(path))).toBe(true);
    });

    it('leaves no descriptor open when a migration fails during open', () => {
      const path = join(temporaryDirectory(), 'migration-failure.db');

      const result = runProbe('failing-migration', path);

      // The open really failed; otherwise "no descriptors" would only prove the
      // probe never opened the file.
      expect(result.error).toBe('DatabaseOpenError');
      expect(result.descriptors).toEqual([]);
    });
  },
);
