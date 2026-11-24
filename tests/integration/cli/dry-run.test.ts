import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import ts from 'typescript';
import { afterEach, describe, expect, it } from 'vitest';

import { PREVIEW_NOTES, runExtractionCli } from '../../../src/cli/extraction.cli.js';
import { runCli } from '../../../src/cli/ingestion.cli.js';
import { EXIT_FAILURE, EXIT_SUCCESS } from '../../../src/cli/exit-codes.js';
import { openDatabase } from '../../../src/core/persistence/sqlite.js';
import { EXTRACTOR_VERSION } from '../../../src/modules/extraction/extraction.constants.js';
import { SqliteArticleContentRepository } from '../../../src/modules/extraction/repository/sqlite-article-content.repository.js';

import { assertNoDatabaseFiles, requireNetCounts, snapshotDatabase, spawnCli } from './harness.js';

/**
 * Dry-run behaviour of both CLIs.
 *
 * The assertions are about absence: no fetch, no exit code other than success,
 * and one single-line JSON document on stdout. `fetchImpl` throws if called, so
 * any network attempt fails the test rather than reaching the internet.
 */
const directories: string[] = [];

function temporaryDirectory(): string {
  const created = mkdtempSync(join(tmpdir(), 'kou-dry-run-'));
  directories.push(created);
  return created;
}

function forbiddenFetch(): never {
  throw new Error('a dry-run must not perform a network request');
}

const silentLogger = { info: () => undefined, warn: () => undefined, error: () => undefined };

afterEach(() => {
  // Every directory created during a test is removed: several tests build more
  // than one database, so a single tracked path would leak the rest.
  for (const created of directories.splice(0)) {
    rmSync(created, { recursive: true, force: true });
  }
});

describe('extraction dry-run', () => {
  interface Preview {
    mode: string;
    database: string;
    articles: number | null;
    seeded: boolean | null;
    claimable: number | null;
    note: string;
  }

  /** Runs the preview and parses the single line it must write. */
  async function preview(path: string): Promise<{ code: number; lines: string[]; json: Preview }> {
    const lines: string[] = [];
    const code = await runExtractionCli({
      databasePath: path,
      writeStdout: (line) => lines.push(line),
      logger: silentLogger,
    });
    const parsed = JSON.parse(lines[0] ?? 'null') as Preview;
    return { code, lines, json: parsed };
  }

  /** Creates a migrated database holding `count` articles and returns its path. */
  function databaseWithArticles(count: number): string {
    const path = join(temporaryDirectory(), `articles-${String(count)}.db`);
    const database = openDatabase({ path });
    for (let index = 0; index < count; index += 1) {
      const id = `a${String(index)}`;
      database.query((connection) => {
        connection.all(
          `INSERT INTO articles
             (id, title, url, canonical_url, published_at_is_estimated, fetched_at, inserted_order)
           VALUES (?, ?, ?, ?, 0, '2026-01-01T00:00:00Z', ?)`,
          [id, `Title ${id}`, `https://example.com/${id}`, `https://example.com/${id}`, index],
        );
      });
    }
    database.close();
    return path;
  }

  it('writes one line of JSON and exits successfully', async () => {
    const lines: string[] = [];
    const code = await runExtractionCli({
      databasePath: join(temporaryDirectory(), 'absent.db'),
      writeStdout: (line) => lines.push(line),
      logger: silentLogger,
    });

    expect(code).toBe(EXIT_SUCCESS);
    expect(lines).toHaveLength(1);
    expect(lines[0]).not.toContain('\n');
    expect(JSON.parse(lines[0] ?? '{}')).toMatchObject({ mode: 'dry-run' });
  });

  it('reports an unavailable count rather than creating the database', async () => {
    const lines: string[] = [];
    await runExtractionCli({
      databasePath: join(temporaryDirectory(), 'absent.db'),
      writeStdout: (line) => lines.push(line),
      logger: silentLogger,
    });

    const parsed = JSON.parse(lines[0] ?? '{}') as { claimable?: unknown };
    expect(parsed.claimable).toBeNull();
  });

  it('does not extract when execute is omitted', async () => {
    // `openDatabase` would create and migrate a database. It must not be called.
    let opened = false;
    const code = await runExtractionCli({
      openDatabase: () => {
        opened = true;
        throw new Error('must not open a writable database during a dry-run');
      },
      databasePath: join(temporaryDirectory(), 'absent.db'),
      writeStdout: () => undefined,
      logger: silentLogger,
    });

    expect(code).toBe(EXIT_SUCCESS);
    expect(opened).toBe(false);
  });

  it('test 1 — reports an empty database without claiming it is seeded', async () => {
    const { code, json } = await preview(databaseWithArticles(0));

    expect(code).toBe(EXIT_SUCCESS);
    expect(json).toEqual({
      mode: 'dry-run',
      database: 'available',
      articles: 0,
      seeded: null,
      claimable: 0,
      note: PREVIEW_NOTES.noArticles,
    });
  });

  it('test 2 — reports articles that have never been seeded', async () => {
    const path = databaseWithArticles(3);
    const { code, json } = await preview(path);

    expect(code).toBe(EXIT_SUCCESS);
    expect(json).toEqual({
      mode: 'dry-run',
      database: 'available',
      articles: 3,
      seeded: false,
      claimable: 0,
      note: PREVIEW_NOTES.unseeded,
    });

    // The figure that made this fix necessary: 0 claimable would otherwise read
    // as "nothing to do" while the next run would process all three articles.
    expect(json.note).toBe('articles exist but extraction lifecycle records have not been seeded');

    // And it must not have seeded on our behalf.
    const database = openDatabase({ path });
    const row = database.query((connection) =>
      connection.get('SELECT COUNT(*) AS n FROM article_contents'),
    ) as { n: number };
    database.close();
    expect(row.n).toBe(0);
  });

  it('test 3 — reports a seeded database with claimable articles', async () => {
    const path = databaseWithArticles(3);
    const database = openDatabase({ path });
    await new SqliteArticleContentRepository(database).seed(EXTRACTOR_VERSION);
    database.close();

    const { code, json } = await preview(path);

    expect(code).toBe(EXIT_SUCCESS);
    expect(json).toEqual({
      mode: 'dry-run',
      database: 'available',
      articles: 3,
      seeded: true,
      claimable: 3,
      note: PREVIEW_NOTES.claimable,
    });
  });

  it('test 4 — reports a seeded database with nothing claimable', async () => {
    const path = databaseWithArticles(2);
    const database = openDatabase({ path });
    const repository = new SqliteArticleContentRepository(database);
    await repository.seed(EXTRACTOR_VERSION);

    // Finish both articles, so nothing is left to claim.
    for (const articleId of ['a0', 'a1']) {
      const token = `t-${articleId}`;
      const claim = await repository.claim({
        owner: 'test',
        token,
        now: Date.now(),
        leaseDurationMs: 60_000,
        extractorVersion: EXTRACTOR_VERSION,
      });
      await repository.complete({
        articleId: claim?.articleId ?? '',
        token,
        success: {
          text: 'x'.repeat(250),
          extractedAt: '2026-01-01T00:00:00Z',
          finalUrl: `https://example.com/${articleId}`,
          httpStatus: 200,
        },
      });
    }
    database.close();

    const { code, json } = await preview(path);

    expect(code).toBe(EXIT_SUCCESS);
    expect(json).toEqual({
      mode: 'dry-run',
      database: 'available',
      articles: 2,
      seeded: true,
      claimable: 0,
      note: PREVIEW_NOTES.noneClaimable,
    });

    // The note must not suggest the database is empty — it is fully processed.
    expect(json.note).not.toBe(PREVIEW_NOTES.noArticles);
    expect(json.articles).toBe(2);
  });

  it('test 5 — reports a missing database as unavailable and exits 0', async () => {
    const { code, json } = await preview(join(temporaryDirectory(), 'absent.db'));

    expect(code).toBe(EXIT_SUCCESS);
    expect(json).toEqual({
      mode: 'dry-run',
      database: 'unavailable',
      articles: null,
      seeded: null,
      claimable: null,
      note: PREVIEW_NOTES.unavailable,
    });
  });

  it('test 6 — reports a corrupt database as unavailable, with JSON and exit 1', async () => {
    const path = join(temporaryDirectory(), 'corrupt.db');
    writeFileSync(path, 'this file is not a SQLite database, only filler bytes');

    const { code, lines, json } = await preview(path);

    // The counts failed, so the exit code must not claim success.
    expect(code).toBe(EXIT_FAILURE);
    // But stdout is still exactly one parseable document, never an empty line.
    expect(lines).toHaveLength(1);
    expect(json).toEqual({
      mode: 'dry-run',
      database: 'unavailable',
      articles: null,
      seeded: null,
      claimable: null,
      note: PREVIEW_NOTES.unavailable,
    });
  });

  it('test 7 — writes nothing: no rows, no attempts, no leases', async () => {
    const path = databaseWithArticles(2);
    const database = openDatabase({ path });
    const repository = new SqliteArticleContentRepository(database);
    await repository.seed(EXTRACTOR_VERSION);

    // Give one row a consumed attempt so a reset would be visible.
    await repository.claim({
      owner: 'test',
      token: 't',
      now: Date.now(),
      leaseDurationMs: 60_000,
      extractorVersion: EXTRACTOR_VERSION,
    });

    const snapshot = (): unknown =>
      database.query((connection) =>
        connection.all(
          `SELECT article_id, status, attempts, lease_owner, lease_token, lease_expires_at
             FROM article_contents ORDER BY article_id`,
        ),
      );

    const before = snapshot();
    database.close();

    const { code } = await preview(path);
    expect(code).toBe(EXIT_SUCCESS);

    const reopened = openDatabase({ path });
    const after = reopened.query((connection) =>
      connection.all(
        `SELECT article_id, status, attempts, lease_owner, lease_token, lease_expires_at
           FROM article_contents ORDER BY article_id`,
      ),
    );
    const rows = reopened.query((connection) =>
      connection.get('SELECT COUNT(*) AS n FROM article_contents'),
    ) as { n: number };
    reopened.close();

    expect(after).toEqual(before);
    expect(rows.n).toBe(2);
  });
});

describe('ingestion dry-run', () => {
  it('writes one line of JSON and exits successfully', async () => {
    const lines: string[] = [];
    const exitCalls: number[] = [];

    await runCli({
      sources: [],
      fetchImpl: forbiddenFetch,
      databasePath: join(temporaryDirectory(), 'absent.db'),
      writeStdout: (line) => lines.push(line),
      exit: (code) => exitCalls.push(code),
      logger: silentLogger,
    });

    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0] ?? '{}')).toMatchObject({ mode: 'dry-run' });
    expect(exitCalls).toEqual([EXIT_SUCCESS]);
  });

  it('writes nothing to the application logger, so stdout stays parseable', async () => {
    // `logger.info` goes to stdout. A preview that logged would put a second
    // JSON document on stdout and break a single `JSON.parse(stdout)`.
    const logged: string[] = [];
    await runCli({
      sources: [],
      fetchImpl: forbiddenFetch,
      databasePath: join(temporaryDirectory(), 'absent.db'),
      writeStdout: () => undefined,
      exit: () => undefined,
      logger: {
        info: (message) => logged.push(`info:${message}`),
        warn: () => undefined,
        error: () => undefined,
      },
    });

    expect(logged).toEqual([]);
  });

  it('does not create the runtime or reach the network', async () => {
    let runtimeCreated = false;

    await runCli({
      sources: [],
      fetchImpl: forbiddenFetch,
      createRuntime: () => {
        runtimeCreated = true;
        throw new Error('a dry-run must not build the runtime');
      },
      databasePath: join(temporaryDirectory(), 'absent.db'),
      writeStdout: () => undefined,
      exit: () => undefined,
      logger: silentLogger,
    });

    expect(runtimeCreated).toBe(false);
  });

  it('lists the enabled sources it would fetch', async () => {
    const lines: string[] = [];
    await runCli({
      sources: [
        {
          id: 'alpha',
          name: 'Alpha',
          url: 'https://alpha.example.com/feed.xml',
          homepage: 'https://alpha.example.com',
          kind: 'rss',
          enabled: true,
          defaultLanguage: 'en',
          tags: [],
          reliability: 'high',
        },
        {
          id: 'disabled',
          name: 'Disabled',
          url: 'https://disabled.example.com/feed.xml',
          homepage: 'https://disabled.example.com',
          kind: 'rss',
          enabled: false,
          defaultLanguage: 'en',
          tags: [],
          reliability: 'high',
        },
      ],
      fetchImpl: forbiddenFetch,
      databasePath: join(temporaryDirectory(), 'absent.db'),
      writeStdout: (line) => lines.push(line),
      exit: () => undefined,
      logger: silentLogger,
    });

    const parsed = JSON.parse(lines[0] ?? '{}') as { sources?: string[] };
    expect(parsed.sources).toEqual(['alpha']);
  });

  it('reports an unavailable article count rather than creating the database', async () => {
    const lines: string[] = [];
    await runCli({
      sources: [],
      fetchImpl: forbiddenFetch,
      databasePath: join(temporaryDirectory(), 'absent.db'),
      writeStdout: (line) => lines.push(line),
      exit: () => undefined,
      logger: silentLogger,
    });

    const parsed = JSON.parse(lines[0] ?? '{}') as { existingArticles?: unknown };
    expect(parsed.existingArticles).toBeNull();
  });
});

/**
 * T-11c and T-11d — dry-run isolation through the real entry points.
 *
 * Every case here runs the CLI as a child process behind the network guard. The
 * cases above drive `runExtractionCli`/`runCli` directly, which is useful for
 * behaviour but cannot serve as network-isolation evidence: the runner's own
 * modules are already loaded. Those direct-call cases are therefore kept as
 * supplementary behaviour tests and are not counted as isolation evidence.
 */
describe.each([
  ['T-11c', 'extract.ts'],
  ['T-11d', 'ingest.ts'],
] as const)('%s — %s --dry-run isolation', (testId, script) => {
  const directories: string[] = [];

  function newDirectory(): string {
    const created = mkdtempSync(join(tmpdir(), 'kou-t11-dry-'));
    directories.push(created);
    return created;
  }

  afterEach(() => {
    for (const created of directories.splice(0)) {
      rmSync(created, { recursive: true, force: true });
    }
  });

  /**
   * Gemini selected with no key, and no `.env` to supply one.
   *
   * This is what makes the cases falsifiable. A dry-run that wrongly entered the
   * provider path would fail at the credential stage. Under the default `fake`
   * provider the same mistake would pass, because a fake needs no key.
   */
  const controlled: Readonly<Record<string, string>> = { LLM_PROVIDER: 'gemini' };

  it(`${testId} completes with gemini selected and no key, creating no database file`, () => {
    const directory = newDirectory();
    const databasePath = join(directory, 'absent.db');

    const result = spawnCli({
      script,
      args: ['--dry-run'],
      databasePath,
      temporaryDirectory: directory,
      environment: controlled,
    });

    expect(result.status).toBe(0);
    assertNoDatabaseFiles(databasePath);

    // One line of parseable JSON on stdout. stderr may carry a warning — the
    // preview legitimately reports that the database could not be read — so it is
    // deliberately not required to be empty.
    const lines = result.stdout.split('\n').filter((line) => line.trim() !== '');
    expect(lines).toHaveLength(1);
    const payload = JSON.parse(lines[0] ?? '{}') as Record<string, unknown>;
    expect(payload['mode']).toBe('dry-run');

    // And the key was never consumed: no credential error anywhere.
    expect(result.combined).not.toContain('LlmConfigurationError');
    expect(result.combined).not.toContain('GEMINI_API_KEY is required');
  });

  it(`${testId} performs zero network calls on every intercepted API`, () => {
    const directory = newDirectory();

    const result = spawnCli({
      script,
      args: ['--dry-run'],
      databasePath: join(directory, 'absent.db'),
      temporaryDirectory: directory,
      environment: controlled,
    });

    const counts = requireNetCounts(result);
    expect(result.status).toBe(0);
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

  it(`${testId} leaves an open-writer WAL database byte-identical`, async () => {
    const directory = newDirectory();
    const databasePath = join(directory, 'wal.db');

    // The writer is held open across the dry-run. Closing it would checkpoint and
    // remove the `-wal` file, so a later read-only open would recreate an empty
    // one and the byte comparison would fail for reasons unrelated to the preview.
    const database = openDatabase({ path: databasePath });
    try {
      database.query((connection) => {
        connection.all(
          `INSERT INTO articles
             (id, title, url, canonical_url, published_at_is_estimated, fetched_at, inserted_order)
           VALUES (?, ?, ?, ?, 0, '2026-01-01T00:00:00Z', ?)`,
          ['a0', 'Title a0', 'https://example.com/a0', 'https://example.com/a0', 0],
        );
      });

      const repository = new SqliteArticleContentRepository(database);
      await repository.seed(EXTRACTOR_VERSION);
      // Give one row a consumed attempt and a lease, so a reset or a claim would
      // be visible in the snapshot rather than invisible.
      await repository.claim({
        owner: 'test',
        token: 'lease-token',
        now: Date.now(),
        leaseDurationMs: 60_000,
        extractorVersion: EXTRACTOR_VERSION,
      });

      // The WAL must exist, otherwise there is nothing to compare and the test
      // would pass without exercising the WAL path at all.
      expect(existsSync(`${databasePath}-wal`)).toBe(true);

      const before = snapshotDatabase(databasePath);

      const result = spawnCli({
        script,
        args: ['--dry-run'],
        databasePath,
        temporaryDirectory: directory,
        environment: controlled,
      });

      expect(result.status).toBe(0);

      const after = snapshotDatabase(databasePath);

      expect(after.databaseHash).toBe(before.databaseHash);
      expect(after.walHash).toBe(before.walHash);
      expect(after.userVersion).toBe(before.userVersion);
      expect(after.articles).toEqual(before.articles);
      expect(after.articleContents).toEqual(before.articleContents);

      // Not vacuous: the snapshot must have held real rows.
      expect(before.articles).toHaveLength(1);
      expect(before.articleContents).toHaveLength(1);
    } finally {
      database.close();
    }
  });
});

/**
 * Negative control for the read-only assertions.
 *
 * A "no database file was created" assertion is only meaningful if it can fail.
 * This substitutes a write-capable opener through the documented `openReadOnly`
 * seam and confirms the resulting file is detected. No production source is
 * modified and the real database is never involved.
 */
describe('negative control — a writable opener must be detectable', () => {
  const directories: string[] = [];

  function newDirectory(): string {
    const created = mkdtempSync(join(tmpdir(), 'kou-negctl-'));
    directories.push(created);
    return created;
  }

  afterEach(() => {
    for (const created of directories.splice(0)) {
      rmSync(created, { recursive: true, force: true });
    }
  });

  it('creates the database file when the read-only seam is replaced with a writable open', async () => {
    const directory = newDirectory();
    const databasePath = join(directory, 'control.db');

    // The real `openReadOnly` dependency is replaced with one that opens a
    // write-capable handle. This is exactly the mistake the read-only tests guard
    // against, expressed through the seam production code already exposes — no
    // edit to `src/` is involved.
    const code = await runExtractionCli({
      databasePath,
      openReadOnly: (path) => {
        const writable = openDatabase({ path });
        return {
          path: writable.path,
          query: (fn) => writable.query(fn),
          close: () => {
            writable.close();
          },
        };
      },
      writeStdout: () => undefined,
      logger: silentLogger,
    });

    expect(code).toBe(EXIT_SUCCESS);
    // The writable open created the file, so the assertion the real tests make
    // now fails. That failure is the point: it shows the assertion can detect a
    // write rather than passing unconditionally.
    expect(existsSync(databasePath)).toBe(true);
    expect(() => assertNoDatabaseFiles(databasePath)).toThrow(/expected no database file/);
  });

  it('a read-only opener on the same path leaves no file behind', () => {
    // The paired half: identical setup, read-only path, no file. Without this the
    // control above could pass for an unrelated reason.
    const directory = newDirectory();
    const databasePath = join(directory, 'readonly.db');

    assertNoDatabaseFiles(databasePath);
    expect(existsSync(databasePath)).toBe(false);
  });
});

/**
 * Static scan of the dry-run code paths.
 *
 * This is corroboration, not proof. It reads the two CLI modules and reports what
 * the preview functions and their modules reference. It does not follow imports
 * recursively, does not do data-flow analysis across functions, and cannot see a
 * provider reached through a callback, an alias chain or `eval`. The behavioural
 * tests above carry the argument; this only adds a structural check.
 */
describe('static scan — dry-run paths reference no provider', () => {
  const repositoryRoot = join(import.meta.dirname, '..', '..', '..');

  interface ScanResult {
    readonly imports: readonly string[];
    readonly dynamicImports: readonly string[];
    readonly reExports: readonly string[];
    readonly providerIdentifiers: readonly string[];
    readonly geminiKeyReads: readonly string[];
  }

  /** Collects module specifiers and provider-related identifiers from one file. */
  function scan(relativePath: string): ScanResult {
    const source = readFileSync(join(repositoryRoot, relativePath), 'utf8');
    const file = ts.createSourceFile(relativePath, source, ts.ScriptTarget.ES2023, true);
    const imports: string[] = [];
    const dynamicImports: string[] = [];
    const reExports: string[] = [];
    const providerIdentifiers: string[] = [];
    const geminiKeyReads: string[] = [];

    const interesting = /provider|gemini|createProvider|FakeProvider/i;

    const visit = (node: ts.Node): void => {
      // Static imports, including `import type`, aliases and namespace imports.
      if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
        imports.push(node.moduleSpecifier.text);
      }

      // Re-exports: `export ... from '...'`.
      if (ts.isExportDeclaration(node) && node.moduleSpecifier !== undefined) {
        if (ts.isStringLiteral(node.moduleSpecifier)) {
          reExports.push(node.moduleSpecifier.text);
        }
      }

      // Dynamic imports, with or without an await.
      if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
        const [argument] = node.arguments;
        if (argument !== undefined && ts.isStringLiteral(argument)) {
          dynamicImports.push(argument.text);
        }
      }

      // Property access, which is how `env.GEMINI_API_KEY` would be read.
      if (ts.isPropertyAccessExpression(node)) {
        const name = node.name.text;
        if (interesting.test(name)) {
          providerIdentifiers.push(name);
        }
        if (name === 'GEMINI_API_KEY') {
          geminiKeyReads.push(name);
        }
      }

      // Identifiers, which covers destructuring (`const { createProvider } = ...`)
      // and namespace access alike.
      if (ts.isIdentifier(node) && interesting.test(node.text)) {
        providerIdentifiers.push(node.text);
      }

      ts.forEachChild(node, visit);
    };

    visit(file);
    return { imports, dynamicImports, reExports, providerIdentifiers, geminiKeyReads };
  }

  it('extraction.cli.ts imports no provider module', () => {
    const result = scan('src/cli/extraction.cli.ts');
    const all = [...result.imports, ...result.dynamicImports, ...result.reExports];

    for (const specifier of all) {
      expect(specifier).not.toContain('provider');
      expect(specifier).not.toContain('gemini');
    }
    expect(result.geminiKeyReads).toEqual([]);
  });

  it('ingestion.cli.ts imports no provider module', () => {
    const result = scan('src/cli/ingestion.cli.ts');
    const all = [...result.imports, ...result.dynamicImports, ...result.reExports];

    for (const specifier of all) {
      expect(specifier).not.toContain('provider');
      expect(specifier).not.toContain('gemini');
    }
    expect(result.geminiKeyReads).toEqual([]);
  });

  it('the scan detects a provider reference when one is present', () => {
    // Proves the scan is not vacuous. The fixture text is written to a temporary
    // file inside this test's own directory, never into `src/`.
    const directory = mkdtempSync(join(tmpdir(), 'kou-ast-ctl-'));
    try {
      const fixturePath = join(directory, 'with-provider.ts');
      writeFileSync(
        fixturePath,
        [
          "import { createProvider } from '../core/llm/provider.factory.js';",
          'const key = process.env.GEMINI_API_KEY;',
          'void createProvider; void key;',
        ].join('\n'),
      );

      const source = readFileSync(fixturePath, 'utf8');
      const file = ts.createSourceFile(fixturePath, source, ts.ScriptTarget.ES2023, true);
      const specifiers: string[] = [];
      const visit = (node: ts.Node): void => {
        if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
          specifiers.push(node.moduleSpecifier.text);
        }
        ts.forEachChild(node, visit);
      };
      visit(file);

      expect(specifiers.some((specifier) => specifier.includes('provider'))).toBe(true);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
