// Marketer commission (20260928130000_marketer_commission.sql) on PGlite, on
// top of the customer-account + credit-terms migrations. Usage:
//   node commission.mjs <ledger> <audit> <hardening> <gaps> <credit-terms> <commission>
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
// Distribution tables the stub doesn't carry (columns as in the real schema).
await db.exec(`
  GRANT USAGE ON SCHEMA public TO authenticated;
  GRANT SELECT, INSERT, UPDATE, DELETE ON public.customers TO authenticated;
  ALTER TABLE public.sale_items ADD COLUMN line_total numeric(14,2) NOT NULL DEFAULT 0;
  CREATE TABLE public.sales_reps (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), factory_id uuid NOT NULL, full_name text NOT NULL, status text NOT NULL DEFAULT 'active');
  CREATE TABLE public.rep_remittances (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), factory_id uuid NOT NULL, sales_rep_id uuid NOT NULL, amount numeric NOT NULL, remittance_date date NOT NULL DEFAULT current_date);
  CREATE TABLE public.sales_returns (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), factory_id uuid, sale_id uuid, product_id uuid, quantity_returned numeric, accepted_quantity numeric, status text NOT NULL DEFAULT 'received');
`);
for (const m of MIGRATIONS) await db.exec(fs.readFileSync(m, "utf8"));

const F = (await one("INSERT INTO factories(name) VALUES ('F') RETURNING id")).id;
const uid = async () => (await one("INSERT INTO auth.users(id) VALUES (gen_random_uuid()) RETURNING id")).id;
const admin = await uid(), cashier = await uid(), keeper = await uid(), viewer = await uid();
await db.exec(`INSERT INTO user_roles VALUES ('${admin}','chairman'),('${cashier}','cashier'),('${keeper}','store_officer'),('${viewer}','accountant')`);
await db.exec(`INSERT INTO role_permissions VALUES
  ('cashier','sales','write'),('cashier','sales','view'),
  ('store_officer','distribution','view'),('store_officer','distribution','create'),
  ('accountant','distribution','view')`);
const water = (await one("INSERT INTO products(factory_id,name,current_stock) VALUES ($1,'Sachet bag',100000) RETURNING id", [F])).id;
const bottle = (await one("INSERT INTO products(factory_id,name,current_stock) VALUES ($1,'75cl pack',100000) RETURNING id", [F])).id;
const rep = (await one("INSERT INTO sales_reps(factory_id,full_name) VALUES ($1,'Ada') RETURNING id", [F])).id;
const rep2 = (await one("INSERT INTO sales_reps(factory_id,full_name) VALUES ($1,'Bayo') RETURNING id", [F])).id;
const idle = (await one("INSERT INTO sales_reps(factory_id,full_name,status) VALUES ($1,'Gone','inactive') RETURNING id", [F])).id;
await db.query("INSERT INTO rep_stock VALUES ($1,$2,100000,now()),($1,$3,100000,now()),($4,$2,100000,now())", [rep, water, bottle, rep2]);

let n = 0;
const repSale = async (salesRep, lines, date = null) => {
  const total = lines.reduce((s, l) => s + l.qty * l.price, 0);
  const id = (await one(
    `INSERT INTO sales(factory_id,invoice_number,sales_rep_id,grand_total,amount_paid,balance,status,created_by,sale_date)
     VALUES ($1,$2,$3,$4,$4,0,'pending_approval',$5,COALESCE($6::date,current_date)) RETURNING id`,
    [F, `INV-${++n}`, salesRep, total, cashier, date])).id;
  for (const l of lines)
    await db.query("INSERT INTO sale_items(sale_id,product_id,quantity,unit_price,line_total) VALUES ($1,$2,$3,$4,$5)", [id, l.product, l.qty, l.price, l.qty * l.price]);
  return id;
};
const approve = async (id) => { await as(admin); await one("SELECT approve_sale($1)", [id]); };
const setRate = async (user, product, amount) => { await as(user); return one("SELECT set_product_commission($1,$2,'test') r", [product, amount]); };
const perf = async (user = viewer, from = "2000-01-01", to = "2100-01-01") => {
  await as(user);
  return q("SELECT * FROM marketer_performance($1,$2,$3)", [F, from, to]);
};
const row = (rows, id) => rows.find((r) => r.sales_rep_id === id);

console.log("Setting rates");
{
  ok("store officer (no approve) cannot set a rate", /Insufficient permissions/.test(await fails(() => setRate(keeper, water, 5))));
  ok("negative rate refused", !!(await fails(() => setRate(admin, water, -1))));
  await setRate(admin, water, 5);
  await setRate(admin, bottle, 20);
  ok("rates stored", num((await one("SELECT amount_per_unit a FROM product_commission_rates WHERE product_id=$1", [water])).a) === 5);
  const aud = await one("SELECT old_value, new_value FROM audit_logs WHERE action='set_product_commission' AND entity_id=$1", [water]);
  ok("rate change audited", aud && num(aud.old_value.commission_per_unit) === 0 && num(aud.new_value.commission_per_unit) === 5);
  await db.exec("SET ROLE authenticated");
  const direct = await fails(() => db.query("INSERT INTO product_commission_rates(product_id,factory_id,amount_per_unit) VALUES ($1,$2,999) ON CONFLICT (product_id) DO UPDATE SET amount_per_unit=999", [water, F]));
  await db.exec("RESET ROLE");
  ok("rates can't be written directly", !!direct && /permission denied/.test(direct), direct);
}

console.log("Commission is captured at approval");
{
  const s = await repSale(rep, [{ product: water, qty: 100, price: 200 }, { product: bottle, qty: 10, price: 1500 }]);
  ok("nothing captured while pending", num((await one("SELECT SUM(commission_per_unit) c FROM sale_items WHERE sale_id=$1", [s])).c) === 0);
  await approve(s);
  const items = await q("SELECT product_id, commission_per_unit c FROM sale_items WHERE sale_id=$1", [s]);
  ok("rate per line captured on approval", num(items.find((i) => i.product_id === water).c) === 5 && num(items.find((i) => i.product_id === bottle).c) === 20);

  const p = row(await perf(), rep);
  ok("units, value and commission for Ada", num(p.units_sold) === 110 && num(p.sales_value) === 35000 && num(p.commission_earned) === 700, JSON.stringify(p));

  await setRate(admin, water, 8);
  ok("changing the rate later doesn't rewrite earned commission", num(row(await perf(), rep).commission_earned) === 700);
  const s2 = await repSale(rep, [{ product: water, qty: 10, price: 200 }]);
  await approve(s2);
  ok("new sales use the new rate", num(row(await perf(), rep).commission_earned) === 780);
}

console.log("Returns, deletions and non-rep sales");
{
  const before = num(row(await perf(), rep2).net_commission);
  const s = await repSale(rep2, [{ product: water, qty: 50, price: 200 }]);
  await approve(s); // 50 x 8 = 400
  await db.query("INSERT INTO sales_returns(factory_id,sale_id,product_id,quantity_returned,accepted_quantity,status) VALUES ($1,$2,$3,10,10,'completed')", [F, s, water]);
  await db.query("INSERT INTO sales_returns(factory_id,sale_id,product_id,quantity_returned,accepted_quantity,status) VALUES ($1,$2,$3,5,5,'received')", [F, s, water]);
  const p = row(await perf(), rep2);
  ok("accepted return takes back its commission (10 x 8)", num(p.commission_reversed) === 80 && num(p.units_returned) === 10, JSON.stringify(p));
  ok("return still being inspected doesn't count", num(p.net_commission) === before + 320);

  const walkIn = (await one(`INSERT INTO sales(factory_id,invoice_number,grand_total,amount_paid,balance,status,created_by) VALUES ($1,'INV-X',1000,1000,0,'pending_approval',$2) RETURNING id`, [F, cashier])).id;
  await db.query("INSERT INTO sale_items(sale_id,product_id,quantity,unit_price,line_total) VALUES ($1,$2,5,200,1000)", [walkIn, water]);
  await approve(walkIn);
  ok("a sale without a rep earns no commission", num((await one("SELECT commission_per_unit c FROM sale_items WHERE sale_id=$1", [walkIn])).c) === 0);

  const gone = await repSale(rep2, [{ product: water, qty: 20, price: 200 }]);
  await approve(gone);
  const withIt = num(row(await perf(), rep2).commission_earned);
  await db.query("UPDATE sales SET deleted_at = now() WHERE id=$1", [gone]);
  ok("a deleted sale drops out of commission", num(row(await perf(), rep2).commission_earned) === withIt - 160);
}

console.log("Periods, remittances and access");
{
  const old = await repSale(rep, [{ product: bottle, qty: 5, price: 1500 }], "2020-01-15");
  await approve(old);
  await db.query("INSERT INTO rep_remittances(factory_id,sales_rep_id,amount,remittance_date) VALUES ($1,$2,30000,current_date),($1,$2,999,'2020-01-20')", [F, rep]);
  const jan2020 = row(await perf(viewer, "2020-01-01", "2020-01-31"), rep);
  ok("period filter: only January 2020's sale and remittance", num(jan2020.units_sold) === 5 && num(jan2020.commission_earned) === 100 && num(jan2020.cash_remitted) === 999, JSON.stringify(jan2020));
  const all = await perf();
  ok("remittances in range summed", num(row(all, rep).cash_remitted) === 30999);
  ok("inactive rep with no activity is left out", !row(all, idle));
  ok("user without distribution access refused", /Insufficient permissions/.test(await fails(() => perf(cashier))));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
