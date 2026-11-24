/**
 * Child process used by the database handle-leak test.
 *
 * Runs in its own process so the descriptor table it inspects contains only what
 * this script opened — the test runner's own handles cannot pollute the result,
 * and nothing here can affect the suite that spawned it.
 *
 * Usage: node --import tsx database-handle-probe.ts <mode> <database-path>
 *
 * Modes:
 *   failing-migration — open a database whose migration fails, then report.
 *   leaked-handle     — open a raw handle and never close it (positive control).
 *
 * Prints one JSON line: { "mode", "descriptors", "error" }.
 */

import { readdirSync, readlinkSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

import { openDatabase } from '../../src/core/persistence/sqlite.js';

/**
 * Descriptors in this process that point at the database file, plus its WAL and
 * shared-memory companions.
 *
 * `/proc/self/fd` is the only reliable source here: an open SQLite handle is not
 * reported by `process.getActiveResourcesInfo()` and does not keep the event
 * loop alive, so neither can be used to detect a leak.
 */
function descriptorsFor(databasePath: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync('/proc/self/fd')) {
    let target: string;
    try {
      target = readlinkSync(`/proc/self/fd/${entry}`);
    } catch {
      // A descriptor can close between listing and reading it; skipping it is
      // correct because a closed descriptor cannot be the leak we look for.
      continue;
    }
    if (target.startsWith(databasePath)) {
      found.push(target);
    }
  }
  return found.sort();
}

const mode = process.argv[2];
const databasePath = process.argv[3];

if (databasePath === undefined) {
  throw new Error('database-handle-probe requires a database path');
}

let error: string | undefined;

if (mode === 'failing-migration') {
  try {
    openDatabase({
      path: databasePath,
      migrations: [
        {
          version: 1,
          name: 'probe-broken',
          statements: ['CREATE TABLE probe_half (id TEXT)', 'THIS IS NOT VALID SQL'],
        },
      ],
    });
  } catch (caught) {
    error = caught instanceof Error ? caught.constructor.name : String(caught);
  }
} else if (mode === 'leaked-handle') {
  const handle = new DatabaseSync(databasePath);
  handle.exec('CREATE TABLE probe_leak (id TEXT)');
  // Deliberately not closed: this is the positive control.
} else {
  throw new Error(`unknown mode: ${String(mode)}`);
}

process.stdout.write(
  `${JSON.stringify({ mode, descriptors: descriptorsFor(databasePath), error })}\n`,
);
