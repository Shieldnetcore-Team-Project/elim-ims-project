# SQL acceptance tests on PGlite

`run.mjs` applies **every** migration in `supabase/migrations` (in order) to a fresh in-process
Postgres (PGlite), with `supabase-stub.sql` standing in for what Supabase provides first:
`anon` / `authenticated` / `service_role` roles, `auth.users`, `auth.uid()` (reads the
`test.uid` setting), `storage.buckets` / `storage.objects`, pgcrypto and the `supabase_realtime`
publication. It then runs each SQL test file you pass. No Docker needed.

    mkdir -p /tmp/pgt && cd /tmp/pgt && npm i @electric-sql/pglite
    node <repo>/supabase/tests/pglite/run.mjs <repo>/supabase/tests/preform_production_test.sql

A test file's setup is everything before its first `-- @@` line; each `-- @@ name` block is one
test, reported PASS/FAIL. Blocks run in order and share state. Exit code 1 on any failure.

The other `supabase/tests/*.sql` files use the same conventions and run the same way.

PGlite is a single connection, so these files cannot test truly concurrent requests; the
functions under test rely on row locks (`SELECT … FOR UPDATE`), status checks after locking and
unique client references for that.
