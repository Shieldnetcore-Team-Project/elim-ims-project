// Applies every migration in supabase/migrations to a fresh PGlite database
// (with supabase-stub.sql standing in for Supabase's auth/storage/realtime),
// then runs each SQL test file given. A test file's setup is everything
// before its first "-- @@" line; each "-- @@ name" block after it is one test.
//
//   cd <scratch dir> && npm i @electric-sql/pglite
//   node <repo>/supabase/tests/pglite/run.mjs <repo>/supabase/tests/preform_production_test.sql
//
// Exit code 1 if any migration or test fails.
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// Resolve PGlite from the current directory, so it need not be installed in the repo.
const require = createRequire(path.join(process.cwd(), "noop.js"));
const { PGlite } = await import(pathToFileURL(require.resolve("@electric-sql/pglite")).href);
const { pgcrypto } = await import(pathToFileURL(require.resolve("@electric-sql/pglite/contrib/pgcrypto")).href);

const here = path.dirname(fileURLToPath(import.meta.url));
const migrationsDir = path.resolve(here, "../../migrations");
const read = (f) => fs.readFileSync(f, "utf8").replace(/\uFEFF/g, "");

const db = new PGlite({ extensions: { pgcrypto } });
await db.exec(read(path.join(here, "supabase-stub.sql")));
const migrations = fs.readdirSync(migrationsDir).filter((f) => f.endsWith(".sql")).sort();
for (const f of migrations) {
  try {
    await db.exec(read(path.join(migrationsDir, f)));
  } catch (e) {
    console.log(`MIGRATION FAILED ${f}: ${e.message}`);
    process.exit(1);
  }
}
console.log(`${migrations.length} migrations applied`);

let pass = 0, fail = 0;
for (const file of process.argv.slice(2)) {
  console.log(`\n${path.basename(file)}`);
  const parts = read(file).split(/^-- @@ /m);
  // Each file starts signed out, with no temp tables / helpers left from the
  // previous file, as if run on its own.
  await db.exec("DISCARD TEMP; SELECT set_config('test.uid', '', false);");
  try {
    await db.exec(parts[0]);
  } catch (e) {
    console.log(`  SETUP FAILED: ${e.message}`);
    fail++;
    continue;
  }
  for (const block of parts.slice(1)) {
    const name = block.split("\n")[0].trim();
    try {
      await db.exec(block.slice(block.indexOf("\n") + 1));
      pass++;
      console.log(`  PASS ${name}`);
    } catch (e) {
      fail++;
      console.log(`  FAIL ${name}\n       ${e.message}`);
    }
  }
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
