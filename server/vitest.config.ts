import { defineConfig } from 'vitest/config';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { TEST_DATABASE_URL } from './src/test/testDbUrl.js';

const dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  test: {
    environment: 'node',
    // The whole suite shares one Postgres schema, laid down once in globalSetup.
    // Tests namespace their rows with uniqueId() so they don't collide, so there
    // is no per-test reset. Run serially and in a single module context so the
    // one pg Pool (and the migrate() guard in fixtures) is shared, not recreated
    // per file.
    fileParallelism: false,
    isolate: false,
    env: { DATABASE_URL: TEST_DATABASE_URL },
    globalSetup: path.join(dirname, 'vitest.globalSetup.ts'),
  },
});
