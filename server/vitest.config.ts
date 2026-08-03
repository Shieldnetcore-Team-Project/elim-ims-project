import { defineConfig } from 'vitest/config';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dirname = path.dirname(fileURLToPath(import.meta.url));
const testDbPath = path.join(dirname, '.vitest-tmp', 'test.db');

export default defineConfig({
  test: {
    environment: 'node',
    // One shared temp SQLite file for the whole run (reset in globalSetup) —
    // tests run sequentially so there's no cross-file contention over it.
    fileParallelism: false,
    env: { ELIM_DB_PATH: testDbPath },
    globalSetup: path.join(dirname, 'vitest.globalSetup.ts'),
  },
});
