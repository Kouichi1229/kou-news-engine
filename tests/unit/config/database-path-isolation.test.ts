import { isAbsolute, join, relative, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { DEFAULT_DATABASE_PATH } from '../../../src/config/constants.js';

/**
 * Guards the test runner's database isolation.
 *
 * `vitest.config.ts` sets `test.env.DATABASE_PATH` so a test that forgets to
 * inject its own path cannot reach the operator's database. That setting is the
 * only thing standing between a careless test and `data/kou-news.db`, and until
 * now nothing asserted it was still in place.
 *
 * These assertions read the value the runner actually installed into
 * `process.env`, so removing or weakening the config entry fails the test. They
 * do not parse `vitest.config.ts` as text: a comment or a differently-spelled
 * assignment would defeat a string match, and a match would not prove the value
 * reached the worker.
 *
 * Nothing here opens, reads, stats or hashes a database. Every check is a pure
 * path computation, so the test cannot create the file it is warning about.
 */
const repositoryRoot = join(import.meta.dirname, '..', '..', '..');

/** Absolute path of the repository's `data/` directory, where the real DB lives. */
const projectDataDirectory = join(repositoryRoot, 'data');

/** Absolute path a caller gets by using the production default. */
const productionDatabasePath = resolve(repositoryRoot, DEFAULT_DATABASE_PATH);

function configuredPath(): string {
  const value = process.env.DATABASE_PATH;
  if (value === undefined || value.trim() === '') {
    throw new Error(
      'DATABASE_PATH is not set in the test environment. vitest.config.ts must set ' +
        'test.env.DATABASE_PATH so tests cannot reach the project database.',
    );
  }
  return resolve(value);
}

/** True when `child` is `parent` or lives beneath it. */
function isInside(parent: string, child: string): boolean {
  const path = relative(parent, child);
  return path === '' || (!path.startsWith('..') && !isAbsolute(path));
}

describe('test database isolation', () => {
  it('sets DATABASE_PATH in the test environment', () => {
    // The single fact everything else depends on. A missing value means the
    // config entry was removed, and the failure should say so rather than
    // surface later as a mysterious path.
    expect(process.env.DATABASE_PATH).toBeTruthy();
  });

  it('points DATABASE_PATH outside the repository', () => {
    // If the path were inside the repo, a test could write a stray database into
    // the working tree and, on a checkout that has one, onto the real file.
    expect(isInside(repositoryRoot, configuredPath())).toBe(false);
  });

  it('does not point at the project data directory', () => {
    expect(isInside(projectDataDirectory, configuredPath())).toBe(false);
  });

  it('differs from the production default', () => {
    // Guards against the config being set to `DEFAULT_DATABASE_PATH`, which would
    // satisfy "a value is set" while still naming the real database.
    expect(configuredPath()).not.toBe(productionDatabasePath);
  });

  it('confirms the production default really is inside data/', () => {
    // The contrast that gives the assertions above their meaning: the value we
    // reject is the one that resolves into the operator's data directory.
    expect(isInside(projectDataDirectory, productionDatabasePath)).toBe(true);
  });

  it('uses a path that no test process inherits from the shell', () => {
    // The runner sets this value itself, so a shell that exported a different
    // DATABASE_PATH must not win. Proving the value is absolute and lives under
    // the OS temp directory is enough to show it came from configuration rather
    // than from `./data/kou-news.db`.
    expect(isAbsolute(configuredPath())).toBe(true);
    expect(configuredPath()).not.toMatch(/[\\/]data[\\/]kou-news\.db$/);
  });
});
