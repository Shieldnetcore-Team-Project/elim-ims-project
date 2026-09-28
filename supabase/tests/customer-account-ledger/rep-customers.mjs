// Marketer's customers (20260928150000_rep_customer_accounts.sql) on PGlite.
// Usage: node rep-customers.mjs <ledger> <audit> <hardening> <gaps> <credit-terms> <rep-customers>
import { PGlite } from "@electric-sql/pglite";
import fs from "node:fs";

const MIGRATIONS = process.argv.slice(2);
const db = new PGlite();
let pass = 0, fail = 0;
const ok = (name, cond, extra = "") => {
  if (cond) { pass++; console.log("  PASS", name); }
  else { fail++; console.log("  FAIL", name, extra); }
};
const q = async (sql, params) => (await db.query(sql, params)).rows;
const one = async (sql, params) => (await q(sql, params))[0];
const num = (v) => Number(v);
const as = (uid) => db.query("SELECT set_config('app.uid', $1, false)", [uid ?? ""]);
const fails = async (fn) => { try { await fn(); return null; } catch (e) { return e.message; } };

await db.exec(fs.readFileSync(new URL("./stub.sql", import.meta.url), "utf8"));
await db.exec(`
  GRANT USAGE ON SCHEMA public TO authenticated;
  GRANT SELECT, INSERT, UPDATE, DELETE ON public.customers TO authenticated;
  ALTER TABLE public.sales ADD COLUMN customer_name text, ADD COLUMN customer_phone text;
  CREATE TABLE public.sales_reps (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), factory_id uuid NOT NULL, full_name text NOT NULL, status text NOT NULL DEFAULT 'active');
`);
for (const m of MIGRATIONS) await db.exec(fs.readFileSync(m, "utf8"));

const F = (await one("INSERT INTO factories(name) VALUES ('F') RETURNING id")).id;
const uid = async () => (await one("INSERT INTO auth.users(id) VALUES (gen_random_uuid()) RETURNING id")).id;
const admin = await uid(), cashier = await uid(), keeper = await uid();
await db.exec(`INSERT INTO user_roles VALUES ('${admin}','chairman'),('${cashier}','cashier'),('${keeper}','store_officer')`);
await db.exec(`INSERT INTO role_permissions VALUES
  ('cashier','sales','write'),('cashier','sales','view'),('cashier','payments','write'),('cashier','customers','view'),
  ('store_officer','distribution','view')`);
const product = (await one("INSERT INTO products(factory_id,name,current_stock) VALUES ($1,'Bag',100000) RETURNING id", [F])).id;
const ada = (await one("INSERT INTO sales_reps(factory_id,full_name) VALUES ($1,'Ada') RETURNING id", [F])).id;
const bayo = (await one("INSERT INTO sales_reps(factory_id,full_name) VALUES ($1,'Bayo') RETURNING id", [F])).id;
await db.query("INSERT INTO rep_stock VALUES ($1,$3,100000,now()),($2,$3,100000,now())", [ada, bayo, product]);
const A = (await one("INSERT INTO customers(factory_id,name,phone) VALUES ($1,'Shop A','0801') RETURNING id", [F])).id;
const B = (await one("INSERT INTO customers(factory_id,name) VALUES ($1,'Shop B') RETURNING id", [F])).id;

let n = 0;
const sale = async ({ rep = null, customer = null, total, paid = 0, name = null, date = null }) => {
  const id = (await one(
    `INSERT INTO sales(factory_id,invoice_number,sales_rep_id,customer_id,customer_name,grand_total,amount_paid,balance,status,created_by,pending_payments,sale_date)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'pending_approval',$9,$10,COALESCE($11::date,current_date)) RETURNING id`,
    [F, `INV-${++n}`, rep, customer, name, total, paid, total - paid, cashier,
     paid > 0 ? JSON.stringify([{ amount: paid, method: "cash" }]) : null, date])).id;
  await db.query("INSERT INTO sale_items(sale_id,product_id,quantity,unit_price) VALUES ($1,$2,1,$3)", [id, product, total]);
  await as(admin);
  await one("SELECT approve_sale($1)", [id]);
  return id;
};
const invoices = async (user, rep, from = null, to = null) => {
  await as(user);
  return q("SELECT * FROM rep_customer_invoices($1,$2,$3)", [rep, from, to]);
};

await sale({ rep: ada, customer: A, total: 1000, paid: 400 });
await sale({ rep: ada, customer: A, total: 500, paid: 500 });
await sale({ rep: ada, customer: B, total: 800 });
await as(cashier);
await one("SELECT record_payment($1::jsonb)", [JSON.stringify({ factory_id: F, customer_id: B, amount: 300, payment_method: "cash" })]);
await sale({ rep: ada, total: 200, paid: 200, name: "Joe (walk-in)" });
await sale({ rep: bayo, customer: A, total: 999 });
await sale({ customer: A, total: 777 });
await as(cashier);
await one("SELECT record_customer_advance($1::jsonb)", [JSON.stringify({ factory_id: F, customer_id: A, amount: 100, payment_method: "cash" })]);
// Shop A owed 600 (INV-1) + 999 (Bayo) + 777 (no rep): the 100 advance settles
// the oldest debt first -- INV-1, which is Ada's.
await sale({ rep: ada, customer: A, total: 300, date: "2020-06-01" });

console.log("A marketer's customers");
{
  const rows = await invoices(keeper, ada);
  ok("only Ada's approved sales (5 invoices)", rows.length === 5, rows.map((r) => r.invoice_number).join());
  const byCust = (id) => rows.filter((r) => r.customer_id === id);
  const sum = (rs, k) => rs.reduce((s, r) => s + num(r[k]), 0);
  const a = byCust(A);
  ok("Shop A: goods 1800 across 3 invoices", a.length === 3 && sum(a, "grand_total") === 1800);
  ok("Shop A: paid 1000 (400 + 500 + 100 from advance settling INV-1)", sum(a, "cash_paid") === 1000, String(sum(a, "cash_paid")));
  ok("Shop A: owes 800 on Ada's invoices (500 + 300)", sum(a, "outstanding") === 800, String(sum(a, "outstanding")));
  const inv1 = a.find((r) => r.invoice_number === "INV-1");
  ok("INV-1 partly paid, due date carried", num(inv1.outstanding) === 500 && inv1.debt_status === "partial" && !!inv1.due_date);
  const b = byCust(B);
  ok("Shop B: later payment counts as paid", b.length === 1 && num(b[0].cash_paid) === 300 && num(b[0].outstanding) === 500);
  const walk = rows.find((r) => r.customer_id === null);
  ok("walk-in sale keeps the name typed at the till", walk && walk.customer_name === "Joe (walk-in)" && num(walk.outstanding) === 0);
  ok("customer phone included", a[0].customer_phone === "0801");
}

console.log("Advance, period, deletion and access");
{
  const c = (await one("INSERT INTO customers(factory_id,name) VALUES ($1,'Shop C') RETURNING id", [F])).id;
  await as(cashier);
  await one("SELECT record_customer_advance($1::jsonb)", [JSON.stringify({ factory_id: F, customer_id: c, amount: 250, payment_method: "cash" })]);
  await sale({ rep: ada, customer: c, total: 400 });
  const row = (await invoices(keeper, ada)).find((r) => r.customer_id === c);
  ok("advance drawn at approval shows separately", num(row.advance_applied) === 250 && num(row.outstanding) === 150);

  const june = await invoices(keeper, ada, "2020-06-01", "2020-06-30");
  ok("period filter", june.length === 1 && num(june[0].grand_total) === 300);

  const gone = await sale({ rep: ada, customer: B, total: 50 });
  await db.query("UPDATE sales SET deleted_at = now() WHERE id=$1", [gone]);
  ok("deleted sale left out", !(await invoices(keeper, ada)).some((r) => r.sale_id === gone));
  ok("no distribution access: refused", /Insufficient permissions/.test(await fails(() => invoices(cashier, ada))));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
