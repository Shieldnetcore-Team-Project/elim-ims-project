// Assigned customers and marketer collections
// (20260928160000_rep_customer_assignment_and_collections.sql) on PGlite.
// Usage: node rep-collections.mjs <ledger> <audit> <hardening> <gaps> <credit-terms> <rep-customers> <collections>
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
  ALTER TABLE public.products ADD COLUMN unit_price numeric NOT NULL DEFAULT 0;
  CREATE TABLE public.sales_reps (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), factory_id uuid NOT NULL, full_name text NOT NULL, status text NOT NULL DEFAULT 'active');
  CREATE TABLE public.rep_remittances (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), factory_id uuid NOT NULL, sales_rep_id uuid NOT NULL, amount numeric NOT NULL, remittance_date date NOT NULL DEFAULT current_date);
  CREATE TABLE public.stock_dispatches (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), factory_id uuid NOT NULL, sales_rep_id uuid NOT NULL, dispatch_date date NOT NULL DEFAULT current_date, status text NOT NULL DEFAULT 'posted');
  CREATE TABLE public.stock_dispatch_items (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), dispatch_id uuid NOT NULL, product_id uuid, quantity numeric, line_value numeric NOT NULL);
  CREATE TABLE public.rep_returns (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), sales_rep_id uuid NOT NULL, return_date date NOT NULL DEFAULT current_date, status text NOT NULL DEFAULT 'received');
  CREATE TABLE public.rep_return_items (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), rep_return_id uuid NOT NULL, accepted_quantity numeric, unit_price numeric, charge_rep boolean NOT NULL DEFAULT false, damaged_quantity numeric NOT NULL DEFAULT 0, rejected_quantity numeric NOT NULL DEFAULT 0);
`);
for (const m of MIGRATIONS) await db.exec(fs.readFileSync(m, "utf8"));

const F = (await one("INSERT INTO factories(name) VALUES ('F') RETURNING id")).id;
const F2 = (await one("INSERT INTO factories(name) VALUES ('G') RETURNING id")).id;
const uid = async () => (await one("INSERT INTO auth.users(id) VALUES (gen_random_uuid()) RETURNING id")).id;
const admin = await uid(), cashier = await uid(), keeper = await uid();
await db.exec(`INSERT INTO user_roles VALUES ('${admin}','chairman'),('${cashier}','cashier'),('${keeper}','store_officer')`);
await db.exec(`INSERT INTO role_permissions VALUES
  ('cashier','sales','write'),('cashier','sales','view'),('cashier','payments','write'),('cashier','customers','view'),
  ('store_officer','distribution','view')`);
const product = (await one("INSERT INTO products(factory_id,name,current_stock,unit_price) VALUES ($1,'Bag',100000,100) RETURNING id", [F])).id;
const ada = (await one("INSERT INTO sales_reps(factory_id,full_name) VALUES ($1,'Ada') RETURNING id", [F])).id;
const other = (await one("INSERT INTO sales_reps(factory_id,full_name) VALUES ($1,'Elsewhere') RETURNING id", [F2])).id;
await db.query("INSERT INTO rep_stock VALUES ($1,$2,100000,now())", [ada, product]);
const A = (await one("INSERT INTO customers(factory_id,name) VALUES ($1,'Shop A') RETURNING id", [F])).id;
const B = (await one("INSERT INTO customers(factory_id,name) VALUES ($1,'Shop B') RETURNING id", [F])).id;

// Ada took 5000 of goods out.
const d = (await one("INSERT INTO stock_dispatches(factory_id,sales_rep_id) VALUES ($1,$2) RETURNING id", [F, ada])).id;
await db.query("INSERT INTO stock_dispatch_items(dispatch_id,product_id,quantity,line_value) VALUES ($1,$2,50,5000)", [d, product]);

let n = 0;
const sale = async ({ rep = null, customer = null, total, paid = 0, name = null }) => {
  const id = (await one(
    `INSERT INTO sales(factory_id,invoice_number,sales_rep_id,customer_id,customer_name,grand_total,amount_paid,balance,status,created_by,pending_payments)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'pending_approval',$9,$10) RETURNING id`,
    [F, `INV-${++n}`, rep, customer, name, total, paid, total - paid, cashier, paid > 0 ? JSON.stringify([{ amount: paid, method: "cash" }]) : null])).id;
  await db.query("INSERT INTO sale_items(sale_id,product_id,quantity,unit_price) VALUES ($1,$2,1,$3)", [id, product, total]);
  await as(admin);
  await one("SELECT approve_sale($1)", [id]);
  return id;
};
const pay = async (body) => { await as(cashier); return (await one("SELECT record_payment($1::jsonb) r", [JSON.stringify({ factory_id: F, payment_method: "cash", ...body })])).r; };
const account = async () => { await as(keeper); return (await one("SELECT rep_account_summary($1) r", [ada])).r; };

console.log("Assigning customers");
{
  await db.exec("SET ROLE authenticated");
  const e1 = await fails(() => db.query("UPDATE customers SET sales_rep_id=$1 WHERE id=$2", [ada, B]));
  const e2 = await fails(() => db.query("UPDATE customers SET sales_rep_id=$1 WHERE id=$2", [other, A]));
  await db.exec("RESET ROLE");
  ok("Customers form can assign a marketer", e1 === null, e1);
  ok("another factory's marketer refused", !!e2 && /does not belong/.test(e2), e2);
  await as(keeper);
  const list = await q("SELECT * FROM rep_customers($1)", [ada]);
  ok("assigned customer listed before any sale", list.length === 1 && list[0].customer_id === B && list[0].assigned === true);
}

console.log("Collections and the marketer's balance");
{
  await sale({ rep: ada, customer: A, total: 3000, paid: 1000 }); // 1000 cash with Ada, 2000 credit
  await as(admin);
  await db.query("INSERT INTO rep_remittances(factory_id,sales_rep_id,amount) VALUES ($1,$2,1000)", [F, ada]);
  let a = await account();
  ok("set-up: 5000 out, 1000 remitted, 2000 on credit, 2000 still with Ada as stock", num(a.net_balance_owed) === 2000 && num(a.credit_outstanding) === 2000, JSON.stringify(a));

  const p = await pay({ customer_id: A, amount: 1500, collected_by_rep: ada });
  const row = await one("SELECT collected_by_rep FROM payments_received WHERE id=$1", [p.payment_id]);
  ok("payment records the marketer who collected it", row.collected_by_rep === ada);
  a = await account();
  ok("collection doesn't change what Ada owes (credit -1500, collected +1500)", num(a.net_balance_owed) === 2000 && num(a.credit_collected) === 1500 && num(a.credit_outstanding) === 500, JSON.stringify(a));

  await pay({ customer_id: A, amount: 200 });
  a = await account();
  ok("payment made at the office on Ada's sale also isn't charged to Ada", num(a.net_balance_owed) === 2000 && num(a.credit_collected) === 1700, JSON.stringify(a));

  await db.query("UPDATE payments_received SET status='confirmed' WHERE id=$1", [p.payment_id]);
  await as(admin);
  await one("SELECT reverse_payment($1,'bounced')", [p.payment_id]);
  a = await account();
  ok("reversed payment: credit back, collected back, balance unchanged", num(a.credit_collected) === 200 && num(a.credit_outstanding) === 1800 && num(a.net_balance_owed) === 2000, JSON.stringify(a));

  const w = await sale({ rep: ada, total: 400, name: "Joe" }); // walk-in on credit
  a = await account();
  const before = num(a.net_balance_owed);
  await pay({ sale_id: w, amount: 150, collected_by_rep: ada });
  a = await account();
  ok("walk-in credit collected counts too", num(a.net_balance_owed) === before, JSON.stringify(a));

  const e = await fails(() => pay({ customer_id: A, amount: 10, collected_by_rep: other }));
  ok("collector from another factory refused", !!e && /Marketer not found/.test(e), e);
}

console.log("Assigned customer's other invoices");
{
  const direct = await sale({ customer: B, total: 900 }); // bought at the warehouse, no rep
  await as(keeper);
  const inv = await q("SELECT * FROM rep_customer_invoices($1)", [ada]);
  const r = inv.find((x) => x.sale_id === direct);
  ok("shown on Ada's list, marked not sold by her", r && r.sold_by_rep === false && num(r.outstanding) === 900);
  const before = num((await account()).net_balance_owed);
  await pay({ customer_id: B, amount: 900, collected_by_rep: ada });
  ok("Ada collecting on it doesn't change her balance (not her credit)", num((await account()).net_balance_owed) === before);
  const cust = (await q("SELECT * FROM rep_customers($1)", [ada])).find((c) => c.customer_id === B);
  ok("collected by Ada shown on the customer", num(cust.collected_by_rep) === 900 && num(cust.total_owed) === 0, JSON.stringify(cust));
}

console.log("Sales counted");
{
  await one(`INSERT INTO sales(factory_id,invoice_number,sales_rep_id,grand_total,amount_paid,balance,status,created_by) VALUES ($1,'INV-P',$2,777,0,777,'pending_approval',$3)`, [F, ada, cashier]);
  const a = await account();
  ok("pending sale not counted in sales booked", num(a.sales_value) === 3400 && a.sales_count === 2, JSON.stringify(a));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
