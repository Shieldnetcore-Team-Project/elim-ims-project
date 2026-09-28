// Bottle tracking (20260928140000_container_tracking.sql) on PGlite, on top of
// the customer-account, credit-terms and commission migrations. Usage:
//   node containers.mjs <ledger> <audit> <hardening> <gaps> <credit-terms> <commission> <containers>
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
  CREATE TABLE public.sales_returns (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), factory_id uuid NOT NULL, return_number text NOT NULL, sale_id uuid, customer_id uuid, product_id uuid NOT NULL, quantity_returned numeric NOT NULL, accepted_quantity numeric, status text NOT NULL DEFAULT 'received');
  CREATE TABLE public.stock_dispatches (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), factory_id uuid NOT NULL, dispatch_number text NOT NULL, sales_rep_id uuid NOT NULL, status text NOT NULL DEFAULT 'posted');
  CREATE TABLE public.stock_dispatch_items (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), dispatch_id uuid NOT NULL REFERENCES public.stock_dispatches(id), product_id uuid NOT NULL, quantity numeric NOT NULL);
  CREATE TABLE public.rep_returns (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), factory_id uuid NOT NULL, return_number text NOT NULL, sales_rep_id uuid NOT NULL, status text NOT NULL DEFAULT 'received');
  CREATE TABLE public.rep_return_items (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), rep_return_id uuid NOT NULL REFERENCES public.rep_returns(id), product_id uuid NOT NULL, quantity_returned numeric NOT NULL);
`);
for (const m of MIGRATIONS) await db.exec(fs.readFileSync(m, "utf8"));

const F = (await one("INSERT INTO factories(name) VALUES ('F') RETURNING id")).id;
const uid = async () => (await one("INSERT INTO auth.users(id) VALUES (gen_random_uuid()) RETURNING id")).id;
const admin = await uid(), cashier = await uid(), keeper = await uid(), outsider = await uid();
await db.exec(`INSERT INTO user_roles VALUES ('${admin}','chairman'),('${cashier}','cashier'),('${keeper}','store_officer'),('${outsider}','hr')`);
await db.exec(`INSERT INTO role_permissions VALUES
  ('cashier','sales','write'),('cashier','sales','view'),
  ('store_officer','distribution','view'),('store_officer','distribution','create')`);

const refill = (await one("INSERT INTO products(factory_id,name,current_stock) VALUES ($1,'19L refill',10000) RETURNING id", [F])).id;
const crateOf12 = (await one("INSERT INTO products(factory_id,name,current_stock) VALUES ($1,'75cl x12',10000) RETURNING id", [F])).id;
const sachet = (await one("INSERT INTO products(factory_id,name,current_stock) VALUES ($1,'Sachet bag',10000) RETURNING id", [F])).id;
const rep = (await one("INSERT INTO sales_reps(factory_id,full_name) VALUES ($1,'Ada') RETURNING id", [F])).id;
const cust = (await one("INSERT INTO customers(factory_id,name) VALUES ($1,'Mama Put') RETURNING id", [F])).id;
await db.query("INSERT INTO rep_stock VALUES ($1,$2,1000,now()),($1,$3,1000,now())", [rep, refill, crateOf12]);

const bal = async (holderType, holderId, typeId) =>
  num((await one(
    "SELECT COALESCE(SUM(balance),0) b FROM container_balances WHERE container_type_id=$1 AND holder_type=$2 AND holder_id IS NOT DISTINCT FROM $3",
    [typeId, holderType, holderId ?? null])).b);
let n = 0;
const sale = async ({ salesRep = null, customer = null, lines }) => {
  const total = lines.reduce((s, l) => s + l.qty * 100, 0);
  const id = (await one(
    `INSERT INTO sales(factory_id,invoice_number,sales_rep_id,customer_id,grand_total,amount_paid,balance,status,created_by)
     VALUES ($1,$2,$3,$4,$5,$5,0,'pending_approval',$6) RETURNING id`,
    [F, `INV-${++n}`, salesRep, customer, total, cashier])).id;
  for (const l of lines) await db.query("INSERT INTO sale_items(sale_id,product_id,quantity,unit_price,line_total) VALUES ($1,$2,$3,100,$4)", [id, l.product, l.qty, l.qty * 100]);
  await as(admin);
  await one("SELECT approve_sale($1)", [id]);
  return id;
};

console.log("Setup");
let bottle, crate;
{
  ok("store officer cannot create container types", /Insufficient permissions/.test(await fails(async () => { await as(keeper); await one("SELECT save_container_type($1,NULL,'19L bottle')", [F]); })));
  await as(admin);
  bottle = (await one("SELECT save_container_type($1,NULL,'19L bottle') id", [F])).id;
  crate = (await one("SELECT save_container_type($1,NULL,'Crate') id", [F])).id;
  await one("SELECT set_product_container($1,$2,1)", [refill, bottle]);
  await one("SELECT set_product_container($1,$2,1)", [crateOf12, crate]);
  ok("types and product links saved", (await q("SELECT 1 FROM product_containers")).length === 2);
  await one("SELECT record_container_movement($1::jsonb)", [JSON.stringify({ factory_id: F, container_type_id: bottle, kind: "purchase", quantity: 500, notes: "new stock" })]);
  ok("purchase puts containers in the warehouse", (await bal("warehouse", null, bottle)) === 500);
}

console.log("Direct sales");
{
  await sale({ customer: cust, lines: [{ product: refill, qty: 10 }, { product: sachet, qty: 50 }] });
  ok("sale to a customer: 10 bottles out to them", (await bal("customer", cust, bottle)) === 10 && (await bal("warehouse", null, bottle)) === 490);
  ok("products without containers move none", (await q("SELECT 1 FROM container_movements WHERE source='sale'")).length === 1);
  await sale({ lines: [{ product: refill, qty: 3 }] });
  ok("walk-in sale: 3 bottles out with walk-ins", (await bal("walk_in", null, bottle)) === 3);
}

console.log("Marketers");
{
  const d = (await one("INSERT INTO stock_dispatches(factory_id,dispatch_number,sales_rep_id) VALUES ($1,'DSP-1',$2) RETURNING id", [F, rep])).id;
  await db.query("INSERT INTO stock_dispatch_items(dispatch_id,product_id,quantity) VALUES ($1,$2,40),($1,$3,6)", [d, refill, crateOf12]);
  ok("dispatch: 40 bottles and 6 crates to the marketer", (await bal("sales_rep", rep, bottle)) === 40 && (await bal("sales_rep", rep, crate)) === 6);
  await sale({ salesRep: rep, customer: cust, lines: [{ product: refill, qty: 15 }] });
  ok("marketer sale moves bottles from marketer to customer", (await bal("sales_rep", rep, bottle)) === 25 && (await bal("customer", cust, bottle)) === 25);

  const rr = (await one("INSERT INTO rep_returns(factory_id,return_number,sales_rep_id) VALUES ($1,'RR-1',$2) RETURNING id", [F, rep])).id;
  await db.query("INSERT INTO rep_return_items(rep_return_id,product_id,quantity_returned) VALUES ($1,$2,5)", [rr, refill]);
  ok("rep returns 5 unsold refills: 5 bottles back", (await bal("sales_rep", rep, bottle)) === 20);
  await db.query("UPDATE rep_returns SET status='cancelled' WHERE id=$1", [rr]);
  ok("cancelled rep return is undone", (await bal("sales_rep", rep, bottle)) === 25);

  const d2 = (await one("INSERT INTO stock_dispatches(factory_id,dispatch_number,sales_rep_id) VALUES ($1,'DSP-2',$2) RETURNING id", [F, rep])).id;
  await db.query("INSERT INTO stock_dispatch_items(dispatch_id,product_id,quantity) VALUES ($1,$2,10)", [d2, refill]);
  await db.query("UPDATE stock_dispatches SET status='reversed' WHERE id=$1", [d2]);
  ok("reversed dispatch is undone", (await bal("sales_rep", rep, bottle)) === 25);
}

console.log("Returns, deletions and manual moves");
{
  const before = await bal("customer", cust, bottle);
  const sr = (await one("INSERT INTO sales_returns(factory_id,return_number,customer_id,product_id,quantity_returned) VALUES ($1,'SR-1',$2,$3,2) RETURNING id", [F, cust, refill])).id;
  ok("customer product return brings 2 bottles back", (await bal("customer", cust, bottle)) === before - 2);
  await db.query("UPDATE sales_returns SET status='cancelled' WHERE id=$1", [sr]);
  ok("cancelled customer return is undone", (await bal("customer", cust, bottle)) === before);

  const s = await sale({ customer: cust, lines: [{ product: refill, qty: 4 }] });
  const dr = (await one("INSERT INTO delete_requests(factory_id,table_name,entity_id,entity_label,reason,requested_by) VALUES ($1,'sales',$2,'INV','error',$3) RETURNING id", [F, s, cashier])).id;
  await as(admin);
  await one("SELECT approve_delete($1)", [dr]);
  ok("deleted sale's bottles come back off the customer", (await bal("customer", cust, bottle)) === before);

  const move = (user, body) => fails(async () => { await as(user); await one("SELECT record_container_movement($1::jsonb)", [JSON.stringify({ factory_id: F, container_type_id: bottle, ...body })]); });
  ok("empties returned by the customer", (await move(keeper, { kind: "return", holder_type: "customer", holder_id: cust, quantity: 20 })) === null && (await bal("customer", cust, bottle)) === before - 20);
  ok("store officer can't write containers off", /Insufficient permissions/.test(await move(keeper, { kind: "lost", holder_type: "customer", holder_id: cust, quantity: 1, notes: "x" })));
  ok("write-off needs a note", !!(await move(admin, { kind: "lost", holder_type: "customer", holder_id: cust, quantity: 1 })));
  await move(admin, { kind: "lost", holder_type: "customer", holder_id: cust, quantity: 2, notes: "broken at shop" });
  ok("lost containers leave the customer's balance", (await bal("customer", cust, bottle)) === before - 22 && (await bal("external", null, bottle)) === -498, String(await bal("external", null, bottle)));
  ok("issue needs a customer or marketer", !!(await move(keeper, { kind: "issue", holder_type: "walk_in", quantity: 1 })));
  ok("outsider can't record movements", /Insufficient permissions/.test(await move(outsider, { kind: "return", holder_type: "walk_in", quantity: 1 })));

  const total = num((await one("SELECT SUM(balance) s FROM container_balances WHERE container_type_id=$1", [bottle])).s);
  ok("every bottle is accounted for (balances sum to zero)", total === 0, String(total));
  const upd = await fails(() => db.query("UPDATE container_movements SET quantity = 1"));
  ok("movements can't be edited", !!upd);
  await db.exec("SET ROLE authenticated");
  const direct = await fails(() => db.query("INSERT INTO container_movements(factory_id,container_type_id,from_type,to_type,quantity,source) VALUES ($1,$2,'warehouse','walk_in',1,'issue')", [F, bottle]));
  await db.exec("RESET ROLE");
  ok("no direct writes to movements", !!direct && /permission denied/.test(direct), direct);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
