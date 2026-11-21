/**
 * Child-process probe for CLI module-loading behaviour.
 *
 * Runs in its own Node process so module evaluation is observed from outside the
 * test runner, whose environment is already valid. The environment is supplied by
 * the caller, so an invalid configuration can be reproduced without touching the
 * runner's own process.
 *
 * Usage: node --import tsx cli-config-probe.ts <library|entry>
 *
 * `globalThis.fetch` is replaced before the target is imported, so any attempt to
 * reach the network is counted rather than performed. The count is reported on
 * `exit`, which also runs after `process.exit` is called from the target.
 */
const target = process.argv[2];

let fetchCalls = 0;
globalThis.fetch = ((): never => {
  fetchCalls += 1;
  throw new Error('network access is forbidden in this probe');
}) as unknown as typeof globalThis.fetch;

process.on('exit', () => {
  process.stderr.write(`PROBE_FETCH_CALLS=${String(fetchCalls)}\n`);
});

const modules: Record<string, string> = {
  library: '../../src/cli/ingestion.cli.js',
  entry: '../../src/cli/ingest.js',
};

const specifier = modules[target ?? ''];
if (specifier === undefined) {
  process.stderr.write(`PROBE_UNKNOWN_TARGET=${String(target)}\n`);
  process.exit(64);
}

try {
  await import(specifier);
  process.stderr.write('PROBE_IMPORT_OK\n');
} catch (error) {
  process.stderr.write(
    `PROBE_IMPORT_FAILED=${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exit(65);
}
