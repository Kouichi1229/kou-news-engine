import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    globals: true,
    env: {
      // Points every test at a path outside the repository. The project database
      // is the operator's data, not a fixture: a test that forgets to inject its
      // own path must fail to find a database rather than open the real one.
      DATABASE_PATH: join(tmpdir(), 'kou-news-engine-test-never-created.db'),
    },
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'lcov'],
      reportsDirectory: 'coverage',
      include: ['src/**/*.ts'],
      // Process entry points: they run on import, so no test can require them.
      exclude: ['src/index.ts', 'src/cli/ingest.ts', 'src/types/**'],
    },
  },
});
