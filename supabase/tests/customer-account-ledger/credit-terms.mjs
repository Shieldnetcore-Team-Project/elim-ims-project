// Credit terms (20260928120000_customer_credit_terms.sql) on PGlite, applied on
// top of the customer-account migrations. Usage:
//   node credit-terms.mjs <ledger.sql> <audit.sql> <hardening.sql> <gaps.sql> <credit-terms.sql>
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
const today = () => new Date().toISOString().slice(0, 10);
const plusDays = (n) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);
const day = (v) => (v instanceof Date ? v.toISOString().slice(0, 10) : String(v).slice(0, 10));

await db.exec(fs.readFileSync(new URL("./stub.sql", import.meta.url), "utf8"));
// The original schema's blanket grant, which the migration narrows.
await db.exec("GRANT USAGE ON SCHEMA public TO authenticated; GRANT SELECT, INSERT, UPDATE, DELETE ON public.customers TO authenticated;");
for (const m of MIGRATIONS) await db.exec(fs.readFileSync(m, "utf8"));

const F = (await one("INSERT INTO factories(name) VALUES ('F') RETURNING id")).id;
const uid = async () => (await one("INSERT INTO auth.users(id) VALUES (gen_random_uuid()) RETURNING id")).id;
const admin = await uid(), cashier = await uid(), manager = await uid();
await db.exec(`INSERT INTO user_roles VALUES ('${admin}','chairman'),('${cashier}','cashier'),('${manager}','manager')`);
await db.exec(`INSERT INTO role_permissions VALUES
  ('cashier','sales','write'),('cashier','sales','view'),('cashier','payments','write'),('cashier','customers','view'),
  ('manager','sales','approve'),('manager','sales','view'),('manager','customers','approve'),('manager','customers','view'),
  ('manager','payments','reverse')`);
const product = (await one("INSERT INTO products(factory_id, name, current_stock) VALUES ($1,'Carton',10000) RETURNING id", [F])).id;
const cust = async (name) => (await one("INSERT INTO customers(factory_id,name) VALUES ($1,$2) RETURNING id", [F, name])).id;
let n = 0;
const newSale = async (customer, total, paid = 0) => {
  const id = (await one(
    `INSERT INTO sales(factory_id,invoice_number,customer_id,grand_total,amount_paid,balance,status,created_by,pending_payments)
     VALUES ($1,$2,$3,$4,$5,$6,'pending_approval',$7,$8) RETURNING id`,
    [F, `INV-${++n}`, customer, total, paid, total - paid, cashier, paid > 0 ? JSON.stringify([{ amount: paid, method: "cash" }]) : null])).id;
  await db.query("INSERT INTO sale_items(sale_id,product_id,quantity,unit_price) VALUES ($1,$2,1,$3)", [id, product, total]);
  return id;
};
const approveAs = async (user, saleId) => { await as(user); return (await one("SELECT approve_sale($1) r", [saleId])).r; };
const terms = async (user, c, limit, days) => { await as(user); return (await one("SELECT set_customer_credit_terms($1,$2,$3,'test') r", [c, limit, days])).r; };
const pay = async (c, amount) => {
  await as(cashier);
  return (await one("SELECT record_payment($1::jsonb) r", [JSON.stringify({ factory_id: F, customer_id: c, amount, payment_method: "cash" })])).r;
};
const debtOf = (saleId) => one("SELECT * FROM debts WHERE sale_id=$1", [saleId]);

console.log("Due dates");
{
  const c = await cust("DUE30");
  const s = await newSale(c, 1000);
  await approveAs(manager, s);
  ok("default terms: due 30 days after the debt is raised", day((await debtOf(s)).due_date) === plusDays(30), day((await debtOf(s)).due_date));

  const c7 = await cust("DUE7");
  await terms(manager, c7, null, 7);
  const s7 = await newSale(c7, 1000);
  await approveAs(manager, s7);
  ok("customer on 7-day terms: due in 7 days", day((await debtOf(s7)).due_date) === plusDays(7));
  ok("open debt has no recovery date", (await debtOf(s7)).paid_at === null);
}

console.log("Recovery date follows the debt's status");
{
  const c = await cust("RECOVER");
  const s = await newSale(c, 500);
  await approveAs(manager, s);
  const p = await pay(c, 500);
  ok("paid in full: recovery date stamped", (await debtOf(s)).status === "paid" && (await debtOf(s)).paid_at !== null);
  await db.query("UPDATE payments_received SET status='confirmed' WHERE id=$1", [p.payment_id]);
  await as(manager);
  await one("SELECT reverse_payment($1,'bounced')", [p.payment_id]);
  ok("payment reversed: debt reopened, recovery date cleared", (await debtOf(s)).status !== "paid" && (await debtOf(s)).paid_at === null);
}

console.log("Credit limit");
{
  const c = await cust("LIMIT");
  await terms(manager, c, 1000, 30);
  const s1 = await newSale(c, 600);
  await approveAs(manager, s1);
  ok("600 on credit, within the 1000 limit", num((await one("SELECT outstanding_balance o FROM customers WHERE id=$1", [c])).o) === 600);

  const s2 = await newSale(c, 500);
  const e = await fails(() => approveAs(manager, s2));
  ok("a further 500 on credit (1100 owed) is refused", !!e && /Over credit limit/.test(e), e);
  ok("refused sale left untouched", (await one("SELECT status FROM sales WHERE id=$1", [s2])).status === "pending_approval" && !(await debtOf(s2)));

  const s3 = await newSale(c, 500, 200);
  await approveAs(manager, s3);
  ok("500 with 200 paid (900 owed) is allowed", num((await one("SELECT outstanding_balance o FROM customers WHERE id=$1", [c])).o) === 900);

  await approveAs(admin, s2);
  ok("chairman can approve over the limit", (await one("SELECT status FROM sales WHERE id=$1", [s2])).status === "posted");

  const c0 = await cust("NOCREDIT");
  await terms(manager, c0, 0, 30);
  const cashSale = await newSale(c0, 300, 300);
  await approveAs(manager, cashSale);
  ok("limit 0: a fully paid sale still goes through", (await one("SELECT status FROM sales WHERE id=$1", [cashSale])).status === "posted");
  const creditSale = await newSale(c0, 300);
  ok("limit 0: any credit is refused", !!(await fails(() => approveAs(manager, creditSale))));

  const cNone = await cust("NOLIMIT");
  const big = await newSale(cNone, 1000000);
  await approveAs(manager, big);
  ok("no limit set: unlimited credit as before", (await one("SELECT status FROM sales WHERE id=$1", [big])).status === "posted");
}

console.log("Setting credit terms");
{
  const c = await cust("TERMS");
  ok("cashier cannot set credit terms", /Insufficient permissions/.test(await fails(() => terms(cashier, c, 5000, 14))));
  ok("negative limit refused", !!(await fails(() => terms(manager, c, -1, 14))));
  ok("terms over 365 days refused", !!(await fails(() => terms(manager, c, 5000, 400))));
  await terms(manager, c, 5000, 14);
  const row = await one("SELECT credit_limit, credit_days FROM customers WHERE id=$1", [c]);
  ok("manager sets limit and terms", num(row.credit_limit) === 5000 && row.credit_days === 14);
  const aud = await one("SELECT old_value, new_value FROM audit_logs WHERE action='set_customer_credit_terms' AND entity_id=$1", [c]);
  ok("change audited with before and after", aud && aud.old_value.credit_days === 30 && num(aud.new_value.credit_limit) === 5000);
}

console.log("Customer columns are locked against direct writes");
{
  const c = await cust("LOCK");
  await db.exec("SET ROLE authenticated");
  const bal = await fails(() => db.query("UPDATE customers SET credit_balance = 1000000 WHERE id=$1", [c]));
  const debt = await fails(() => db.query("UPDATE customers SET outstanding_balance = 0 WHERE id=$1", [c]));
  const lim = await fails(() => db.query("UPDATE customers SET credit_limit = 1000000 WHERE id=$1", [c]));
  const ins = await fails(() => db.query("INSERT INTO customers(factory_id,name,credit_balance) VALUES ($1,'X',999)", [F]));
  const okEdit = await fails(() => db.query("UPDATE customers SET phone = '0800', name = 'LOCK2' WHERE id=$1", [c]));
  const okIns = await fails(() => db.query("INSERT INTO customers(factory_id,name,phone,registered) VALUES ($1,'NEW','1',true)", [F]));
  await db.exec("RESET ROLE");
  ok("credit balance not directly writable", !!bal && /permission denied/.test(bal), bal);
  ok("outstanding balance not directly writable", !!debt && /permission denied/.test(debt), debt);
  ok("credit limit not directly writable", !!lim && /permission denied/.test(lim), lim);
  ok("a customer can't be created with a balance", !!ins && /permission denied/.test(ins), ins);
  ok("name and phone still editable", okEdit === null, okEdit);
  ok("customers can still be created from the form's fields", okIns === null, okIns);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
