/** The Postgres the test suite connects to.
 *
 *  Defaults to the `test-db` service in the repo-root docker-compose.yml
 *  (`npm run test:db:up`). Override with DATABASE_URL to point at your own
 *  disposable instance. It must be local — globalSetup drops and recreates the
 *  `public` schema on every run, so a production URL would be wiped. */
export const TEST_DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgresql://postgres:postgres@localhost:5433/elim_test';

const LOCAL_HOSTS = ['localhost', '127.0.0.1', '::1', 'postgres', 'test-db'];

/** True when the URL points at something safe to wipe. globalSetup and the test
 *  DB pool both refuse to touch anything else. */
export function isLocalTestDb(url = TEST_DATABASE_URL): boolean {
  try {
    return LOCAL_HOSTS.includes(new URL(url).hostname);
  } catch {
    return false;
  }
}
