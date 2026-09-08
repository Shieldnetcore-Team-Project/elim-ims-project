import pg from 'pg';
import { TEST_DATABASE_URL, isLocalTestDb } from './src/test/testDbUrl.js';
import { SCHEMA_SQL, FOREIGN_KEYS_SQL, REFERENCE_DATA_SQL } from './src/db/schema.js';

// Runs once before the whole suite, in its own process. Gives every run a clean
// database: drop the public schema, recreate it, apply the current schema. Tests
// then add uniqueId()-namespaced rows on top.
export default async function setup() {
  const host = safeHost(TEST_DATABASE_URL);
  if (!isLocalTestDb()) {
    throw new Error(
      `vitest globalSetup refuses to reset a non-local database (host: ${host}). ` +
        `Point DATABASE_URL at a disposable local Postgres, or run \`npm run test:db:up\`.`,
    );
  }

  const client = await connectWithRetry();
  try {
    await client.query('DROP SCHEMA IF EXISTS public CASCADE');
    await client.query('CREATE SCHEMA public');
    await client.query(SCHEMA_SQL);
    await client.query(FOREIGN_KEYS_SQL);
    await client.query(REFERENCE_DATA_SQL);
  } finally {
    await client.end();
  }
}

function safeHost(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return '(unparseable)';
  }
}

/** Postgres in a freshly-started container can take a second or two to accept
 *  connections. A rejected connect() leaves the Client unusable, so retry with a
 *  new one each time. */
async function connectWithRetry(attempts = 30): Promise<pg.Client> {
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const client = new pg.Client({ connectionString: TEST_DATABASE_URL });
    try {
      await client.connect();
      return client;
    } catch (err) {
      await client.end().catch(() => {});
      if (attempt === attempts) {
        throw new Error(
          `Could not connect to the test Postgres at ${safeHost(TEST_DATABASE_URL)} after ${attempts} attempts. ` +
            `Is it running? Try \`npm run test:db:up\`.\n${(err as Error).message}`,
        );
      }
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
  throw new Error('unreachable');
}
