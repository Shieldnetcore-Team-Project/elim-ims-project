// Security + concurrency tests against REAL Postgres (docker, port 55432): real roles
// (anon / authenticated), real row-level security, many parallel sessions.
import pg from "pg";
import fs from "node:fs";

const MIGRATIONS = process.argv.slice(2);
const CONN = { host: "127.0.0.1", port: 55432, user: "postgres", password: "pw", database: "postgres" };

let pass = 0, fail = 0;
const ok = (name, cond, extra = "") => {
  if (cond) { pass++; console.log("  PASS", name); } else { fail++; console.log("  FAIL", name, extra); }
};
const connect = async () => { const c = new pg.Client(CONN); await c.connect(); return c; };
const admin = await connect();
const q = async (sql, p) => (await admin.query(sql, p)).rows;
const one = async (sql, p) => (await q(sql, p))[0];
const num = (v) => Number(v);

// ---------- fresh database ----------
await admin.query("DROP SCHEMA IF EXISTS public CASCADE; DROP SCHEMA IF EXISTS auth CASCADE; CREATE SCHEMA public;");
try { await admin.query("DROP PUBLICATION IF EXISTS supabase_realtime"); } catch {}
await admin.query(fs.readFileSync(new URL("./stub.sql", import.meta.url), "utf8"));
// the parts of the real schema's access model the stub lacks: table grants + RLS on customers
await admin.query(`
  GRANT USAGE ON SCHEMA public, auth TO anon, authenticated;
  GRANT SELECT ON ALL TABLES IN SCHEMA public TO authenticated;
  GRANT EXECUTE ON FUNCTION auth.uid() TO anon, authenticated;
  ALTER TABLE customers ENABLE ROW LEVEL SECURITY;
  CREATE POLICY customers_read ON customers FOR SELECT TO authenticated
    USING (public.has_permission(auth.uid(),'customers','view') OR public.has_permission(auth.uid(),'sales','view'));
`);

const F = (await one("INSERT INTO factories(name) VALUES ('A') RETURNING id")).id;
const F2 = (await one("INSERT INTO factories(name) VALUES ('B') RETURNING id")).id;
const mk = async () => (await one("INSERT INTO auth.users(id) VALUES (gen_random_uuid()) RETURNING id")).id;
const [chair, cashier, sales, acct, nobody] = [await mk(), await mk(), await mk(), await mk(), await mk()];
await admin.query(`INSERT INTO user_roles VALUES ('${chair}','chairman'),('${cashier}','cashier'),('${sales}','sales'),('${acct}','accountant')`);
await admin.query(`INSERT INTO role_permissions VALUES
  ('cashier','sales','write'),('cashier','sales','view'),('cashier','payments','write'),('cashier','customers','view'),
  ('sales','sales','write'),('sales','sales','view'),('sales','customers','view'),
  ('accountant','customers','view'),('accountant','payments','write'),('accountant','sales','view')`);
const product = (await one("INSERT INTO products(factory_id,name,current_stock) VALUES ($1,'Carton',1000000) RETURNING id", [F])).id;
const legacy = (await one("INSERT INTO customers(factory_id,name,credit_balance,outstanding_balance) VALUES ($1,'Legacy',500,100) RETURNING id", [F])).id;
await admin.query("INSERT INTO debts(factory_id,customer_id,total_amount,amount_paid,outstanding,status) VALUES ($1,$2,100,0,100,'unpaid')", [F, legacy]);

for (const m of MIGRATIONS) await admin.query(fs.readFileSync(m, "utf8"));
await admin.query("GRANT SELECT ON ALL TABLES IN SCHEMA public TO authenticated"); // views/tables created by the migration
console.log(`${MIGRATIONS.length} migration(s) applied on real Postgres ${(await one("SHOW server_version")).server_version}`);

// ---------- helpers ----------
const newCust = async (name, fac = F) => (await one("INSERT INTO customers(factory_id,name) VALUES ($1,$2) RETURNING id", [fac, name])).id;
let inv = 0;
const newSale = async (customer, total, paid = 0) => {
  const id = (await one(`INSERT INTO sales(factory_id,invoice_number,customer_id,grand_total,amount_paid,balance,status,created_by,pending_payments)
    VALUES ($1,$2,$3,$4,$5,$6,'pending_approval',$7,$8) RETURNING id`,
    [F, `INV-${++inv}`, customer, total, paid, total - paid, cashier, paid > 0 ? JSON.stringify([{ amount: paid, method: "cash" }]) : null])).id;
  await admin.query("INSERT INTO sale_items(sale_id,product_id,quantity,unit_price) VALUES ($1,$2,1,$3)", [id, product, total]);
  return id;
};
// run a statement as a given user/role on its own connection
const asUser = async (uid, role, sql, params) => {
  const c = await connect();
  try {
    await c.query(`SET ROLE ${role}`);
    await c.query("SELECT set_config('app.uid',$1,false)", [uid ?? ""]);
    return { rows: (await c.query(sql, params)).rows, err: null };
  } catch (e) { return { rows: [], err: e.message }; } finally { await c.end(); }
};
const rpc = (uid, fn, args, role = "authenticated") =>
  asUser(uid, role, `SELECT ${fn}(${args.map((_, i) => `$${i + 1}`).join(",")}) r`, args);
const advPayload = (customer, amount, extra = {}, fac = F) => JSON.stringify({ factory_id: fac, customer_id: customer, amount, payment_method: "cash", ...extra });
const acctState = async (c) => {
  const cu = await one("SELECT credit_balance, outstanding_balance FROM customers WHERE id=$1", [c]);
  const l = await one("SELECT credit_after, debt_after FROM customer_account_transactions WHERE customer_id=$1 ORDER BY seq DESC LIMIT 1", [c]);
  const d = await one("SELECT COALESCE(SUM(outstanding),0) s FROM debts WHERE customer_id=$1", [c]);
  return { credit: num(cu.credit_balance), debt: num(cu.outstanding_balance), lCredit: num(l?.credit_after ?? 0), lDebt: num(l?.debt_after ?? 0), invoiceDebts: num(d.s) };
};
const consistent = (s) => s.credit === s.lCredit && s.debt === s.lDebt && s.debt === s.invoiceDebts && s.credit >= 0 && s.debt >= 0;

// ======================= SECURITY =======================
console.log("Security: anonymous access");
{
  let r = await asUser(null, "anon", "SELECT * FROM customer_account_transactions");
  ok("anon cannot read the ledger", !!r.err && /permission denied/i.test(r.err), r.err);
  r = await asUser(null, "anon", "SELECT * FROM customer_account_adjustments");
  ok("anon cannot read adjustments", !!r.err && /permission denied/i.test(r.err), r.err);
  r = await asUser(null, "anon", "SELECT * FROM customer_account_summary");
  ok("anon cannot read the summary view", !!r.err && /permission denied/i.test(r.err), r.err);
  for (const fn of ["record_customer_advance(jsonb)", "record_payment(jsonb)", "request_customer_adjustment(jsonb)", "approve_customer_adjustment(uuid,text)", "reject_customer_adjustment(uuid,text)", "cancel_customer_adjustment(uuid,text)", "reconcile_customer_account(uuid)"]) {
    const p = await one("SELECT has_function_privilege('anon', $1, 'EXECUTE') a, has_function_privilege('authenticated', $1, 'EXECUTE') u", ["public." + fn]);
    if (p.a || !p.u) ok("execute rights " + fn, false, JSON.stringify(p));
  }
  ok("anon has no EXECUTE on any of the customer-account RPCs; signed-in users keep it", true);
  const c = await newCust("Anon target");
  r = await rpc(null, "record_customer_advance", [advPayload(c, 1000)], "anon");
  ok("anon cannot even reach record_customer_advance (permission denied for function)", !!r.err && /permission denied for function/i.test(r.err), r.err);
  r = await rpc(null, "request_customer_adjustment", [JSON.stringify({ factory_id: F, customer_id: c, effect: "credit_up", amount: 1, reason: "x" })], "anon");
  ok("anon cannot request an adjustment", !!r.err, r.err);
  ok("nothing was written", num((await one("SELECT COUNT(*) n FROM customer_account_transactions WHERE customer_id=$1", [c])).n) === 0);
}

console.log("Security: signed-in users and row-level security");
{
  const c = await newCust("RLS customer");
  await rpc(cashier, "record_customer_advance", [advPayload(c, 5000)]);
  let r = await asUser(nobody, "authenticated", "SELECT COUNT(*) n FROM customer_account_transactions");
  ok("a user with no permissions sees zero ledger rows", !r.err && num(r.rows[0].n) === 0, r.err);
  r = await asUser(cashier, "authenticated", "SELECT COUNT(*) n FROM customer_account_transactions");
  ok("a cashier (customers:view) can read the ledger", !r.err && num(r.rows[0].n) > 0, r.err);
  r = await asUser(nobody, "authenticated", "SELECT COUNT(*) n FROM customer_account_summary");
  ok("summary view respects the caller's rights (no customers visible)", !r.err && num(r.rows[0].n) === 0, r.err);
  r = await asUser(cashier, "authenticated", "SELECT available_advance FROM customer_account_summary WHERE customer_id=$1", [c]);
  ok("summary view shows the balance to a permitted user", !r.err && num(r.rows[0]?.available_advance) === 5000, r.err);

  for (const [label, sql] of [
    ["INSERT into the ledger", "INSERT INTO customer_account_transactions(factory_id,customer_id,txn_type,credit_after,debt_after) SELECT factory_id,id,'CREDIT_ADJUSTMENT',999999,0 FROM customers LIMIT 1"],
    ["UPDATE the ledger", "UPDATE customer_account_transactions SET credit_after = 999999"],
    ["DELETE from the ledger", "DELETE FROM customer_account_transactions"],
    ["INSERT an adjustment", "INSERT INTO customer_account_adjustments(factory_id,customer_id,effect,amount,reason,submitted_by,status) SELECT factory_id,id,'credit_up',1,'x',id,'posted' FROM customers LIMIT 1"],
    ["UPDATE an adjustment", "UPDATE customer_account_adjustments SET status='posted'"],
  ]) {
    for (const who of [chair, cashier, acct]) {
      r = await asUser(who, "authenticated", sql);
      if (!r.err || !/permission denied/i.test(r.err)) { ok(`direct ${label} is denied`, false, `${who === chair ? "chairman" : who === cashier ? "cashier" : "accountant"}: ${r.err}`); }
    }
    ok(`direct ${label} is denied for chairman, cashier and accountant`, true);
  }
  const before = await acctState(c);
  r = await asUser(cashier, "authenticated", "UPDATE customers SET credit_balance = 1000000 WHERE id=$1", [c]);
  ok("a client cannot edit a customer's cached balance either", !!r.err && /permission denied/i.test(r.err), r.err);
  ok("balance unchanged", (await acctState(c)).credit === before.credit);
}

console.log("Security: internal functions are not callable by clients");
{
  const c = await newCust("Internal fn");
  for (const [name, sql, args] of [
    ["_customer_ledger_post", "SELECT _customer_ledger_post($1,$2,'CREDIT_ADJUSTMENT','x',NULL,NULL,NULL,NULL,0,0,0,999999,0,NULL,'x',NULL,NULL,NULL,NULL)", [F, c]],
    ["_customer_receive_money", "SELECT _customer_receive_money($1,$2,999999,'cash',current_date,NULL,NULL,gen_random_uuid(),'x',NULL,'advance',NULL)", [F, c]],
    ["_next_receipt_number", "SELECT _next_receipt_number($1)", [F]],
  ]) {
    for (const who of [chair, cashier]) {
      const r = await asUser(who, "authenticated", sql, args);
      if (!r.err || !/permission denied for function/i.test(r.err)) ok(`${name} blocked`, false, r.err);
    }
    ok(`${name} cannot be called by authenticated users (even the chairman)`, true);
  }
  ok("no balance was created", num((await acctState(c)).credit) === 0);
}

console.log("Security: who may do what");
{
  const c = await newCust("Perm customer");
  const adjArgs = (effect = "credit_up", amount = 100, reason = "test") => [JSON.stringify({ factory_id: F, customer_id: c, effect, amount, reason })];
  let r = await rpc(sales, "record_customer_advance", [advPayload(c, 2000)]);
  ok("sales role CAN record an advance (kept as decided)", !r.err, r.err);
  r = await rpc(cashier, "record_customer_advance", [advPayload(c, 2000)]);
  ok("cashier can record an advance", !r.err, r.err);
  r = await rpc(nobody, "record_customer_advance", [advPayload(c, 2000)]);
  ok("a user with no role cannot", !!r.err && /Insufficient permissions/.test(r.err), r.err);
  r = await rpc(sales, "request_customer_adjustment", adjArgs());
  ok("sales role cannot request an adjustment", !!r.err && /Insufficient permissions/.test(r.err), r.err);
  r = await rpc(cashier, "request_customer_adjustment", adjArgs());
  ok("cashier cannot request an adjustment", !!r.err && /Insufficient permissions/.test(r.err), r.err);
  r = await rpc(acct, "request_customer_adjustment", adjArgs());
  ok("accountant can request an adjustment", !r.err, r.err);
  const id = r.rows[0]?.r?.adjustment_id;
  for (const [label, who] of [["accountant", acct], ["cashier", cashier], ["sales role", sales], ["no-role user", nobody]]) {
    r = await rpc(who, "approve_customer_adjustment", [id]);
    ok(`${label} cannot approve`, !!r.err, r.err);
  }
  r = await rpc(acct, "reject_customer_adjustment", [id, "no"]);
  ok("accountant cannot reject", !!r.err, r.err);
  r = await rpc(chair, "approve_customer_adjustment", [id, "ok"]);
  ok("chairman can approve", !r.err, r.err);
  r = await rpc(chair, "approve_customer_adjustment", [id, "again"]);
  ok("cannot be approved twice", !!r.err, r.err);
  const own = (await rpc(chair, "request_customer_adjustment", adjArgs("credit_up", 5))).rows[0].r.adjustment_id;
  r = await rpc(chair, "approve_customer_adjustment", [own]);
  ok("chairman may approve their own (same as the rest of the app)", !r.err, r.err);
  const other = (await rpc(acct, "request_customer_adjustment", adjArgs("credit_up", 7))).rows[0].r.adjustment_id;
  r = await rpc(acct, "cancel_customer_adjustment", [other]);
  ok("submitter can cancel their own pending request", !r.err, r.err);
  const st = await one("SELECT status FROM customer_account_adjustments WHERE id=$1", [other]);
  ok("…and it stays cancelled (cannot then be approved)", st.status === "cancelled" && !!(await rpc(chair, "approve_customer_adjustment", [other])).err);
  r = await rpc(cashier, "reconcile_customer_account", [null]);
  ok("reconcile is limited to users who can view customers", !r.err, r.err);
  r = await rpc(nobody, "reconcile_customer_account", [null]);
  ok("…and refused to others", !!r.err && /Insufficient permissions/.test(r.err), r.err);
}

console.log("Security: tenant isolation and input validation");
{
  const cB = await newCust("Other factory", F2);
  let r = await rpc(cashier, "record_customer_advance", [advPayload(cB, 1000)]);
  ok("cannot post to another factory's customer", !!r.err && /not found for this factory/i.test(r.err), r.err);
  r = await rpc(acct, "request_customer_adjustment", [JSON.stringify({ factory_id: F, customer_id: cB, effect: "credit_up", amount: 1, reason: "x" })]);
  ok("cannot adjust another factory's customer", !!r.err && /not found for this factory/i.test(r.err), r.err);
  const c = await newCust("Validation");
  for (const [label, payload, re] of [
    ["zero amount", advPayload(c, 0), /Amount must be/],
    ["negative amount", advPayload(c, -50), /Amount must be/],
    ["non-numeric amount", JSON.stringify({ factory_id: F, customer_id: c, amount: "abc" }), /invalid input syntax|numeric/i],
    ["amount too large for the column", advPayload(c, 1e20), /numeric|overflow|out of range/i],
    ["unknown payment method", advPayload(c, 10, { payment_method: "bitcoin" }), /invalid input value|enum/i],
    ["no customer", JSON.stringify({ factory_id: F, amount: 10 }), /registered customer is required/],
    ["no factory", JSON.stringify({ customer_id: c, amount: 10 }), /factory_id required/],
  ]) {
    r = await rpc(cashier, "record_customer_advance", [payload]);
    ok(`rejects ${label}`, !!r.err && re.test(r.err), r.err);
  }
  ok("none of the rejected calls left a trace", num((await one("SELECT COUNT(*) n FROM customer_account_transactions WHERE customer_id=$1", [c])).n) === 0 && (await acctState(c)).credit === 0);
  for (const [label, args] of [
    ["zero", [JSON.stringify({ factory_id: F, customer_id: c, effect: "credit_up", amount: 0, reason: "x" })]],
    ["blank reason", [JSON.stringify({ factory_id: F, customer_id: c, effect: "credit_up", amount: 5, reason: "   " })]],
    ["bad type", [JSON.stringify({ factory_id: F, customer_id: c, effect: "erase_debt", amount: 5, reason: "x" })]],
    ["refund with no method", [JSON.stringify({ factory_id: F, customer_id: c, effect: "refund", amount: 5, reason: "x" })]],
  ]) {
    r = await rpc(acct, "request_customer_adjustment", args);
    ok(`adjustment rejected: ${label}`, !!r.err, r.err);
  }
}

console.log("Integrity: a failed sale leaves no partial effects (atomicity)");
{
  const c = await newCust("Atomic");
  await rpc(cashier, "record_customer_advance", [advPayload(c, 80000)]);
  const big = (await one(`INSERT INTO sales(factory_id,invoice_number,customer_id,grand_total,balance,status,created_by) VALUES ($1,$2,$3,50000,50000,'pending_approval',$4) RETURNING id`, [F, `INV-A${++inv}`, c, cashier])).id;
  await admin.query("INSERT INTO sale_items(sale_id,product_id,quantity,unit_price) VALUES ($1,$2,999999999,1)", [big, product]); // more than the stock
  const stockBefore = num((await one("SELECT current_stock FROM products WHERE id=$1", [product])).current_stock);
  const rowsBefore = num((await one("SELECT COUNT(*) n FROM customer_account_transactions WHERE customer_id=$1", [c])).n);
  const r = await rpc(chair, "approve_sale", [big]);
  ok("approval fails on insufficient stock", !!r.err && /Insufficient stock/i.test(r.err), r.err);
  const s = await acctState(c);
  ok("advance untouched", s.credit === 80000 && s.lCredit === 80000);
  ok("no ledger rows added", num((await one("SELECT COUNT(*) n FROM customer_account_transactions WHERE customer_id=$1", [c])).n) === rowsBefore);
  ok("no debt created", s.invoiceDebts === 0 && s.debt === 0);
  ok("stock unchanged", num((await one("SELECT current_stock FROM products WHERE id=$1", [product])).current_stock) === stockBefore);
  ok("sale is still pending", (await one("SELECT status FROM sales WHERE id=$1", [big])).status === "pending_approval");
}

// ======================= CONCURRENCY =======================
const parallel = (fns) => Promise.all(fns.map((f) => f().then((v) => ({ ok: true, v }), (e) => ({ ok: false, e: (f.tag ? `[${f.tag}] ` : '') + e.message }))));
const tag = (name, f) => { f.tag = name; return f; };
const callOn = async (uid, sql, params) => {
  const c = await connect();
  try { await c.query("SELECT set_config('app.uid',$1,false)", [uid]); return (await c.query(sql, params)).rows[0]; } finally { await c.end(); }
};

console.log("Concurrency: 12 simultaneous sales against one advance");
{
  const c = await newCust("Race12");
  await rpc(cashier, "record_customer_advance", [advPayload(c, 250000)]);
  const sales12 = [];
  for (let i = 0; i < 12; i++) sales12.push(await newSale(c, 100000));
  const res = await parallel(sales12.map((sid) => () => callOn(chair, "SELECT approve_sale($1) r", [sid])));
  ok("all 12 approvals completed without error", res.every((r) => r.ok), JSON.stringify(res.filter((r) => !r.ok)));
  const applied = num((await one("SELECT COALESCE(SUM(credit_applied),0) s FROM sales WHERE customer_id=$1", [c])).s);
  ok("advance applied is exactly 250,000 — never more than was there", applied === 250000, `applied=${applied}`);
  const s = await acctState(c);
  ok("advance left is 0, debt is 12×100k − 250k = 950k", s.credit === 0 && s.debt === 950000, JSON.stringify(s));
  ok("cache = ledger = per-invoice debts", consistent(s), JSON.stringify(s));
  const dup = await q("SELECT sale_id, COUNT(*) n FROM customer_account_transactions WHERE customer_id=$1 AND txn_type='SALE' GROUP BY sale_id HAVING COUNT(*)>1", [c]);
  ok("no sale posted twice", dup.length === 0);
}

console.log("Concurrency: the same sale approved 8 times at once");
{
  const c = await newCust("SameSale");
  await rpc(cashier, "record_customer_advance", [advPayload(c, 60000)]);
  const sid = await newSale(c, 40000);
  const res = await parallel(Array.from({ length: 8 }, () => () => callOn(chair, "SELECT approve_sale($1) r", [sid])));
  ok("exactly one approval succeeds", res.filter((r) => r.ok).length === 1, JSON.stringify(res.map((r) => r.ok || r.e)));
  const s = await acctState(c);
  ok("advance reduced once (20k left), stock taken once", s.credit === 20000 && consistent(s), JSON.stringify(s));
  ok("one debt row at most", num((await one("SELECT COUNT(*) n FROM debts WHERE sale_id=$1", [sid])).n) === 0);
}

console.log("Concurrency: duplicate submit of one advance (same idempotency key)");
{
  const c = await newCust("Idem");
  const key = "aaaaaaaa-0000-4000-8000-000000000001";
  const res = await parallel(Array.from({ length: 8 }, () => () => callOn(cashier, "SELECT record_customer_advance($1::jsonb) r", [advPayload(c, 7000, { idempotency_key: key })])));
  ok("no call errored", res.every((r) => r.ok), JSON.stringify(res.filter((r) => !r.ok)));
  ok("exactly one was recorded, the rest reported as duplicates", res.filter((r) => r.ok && !r.v.r.duplicate).length === 1 && res.filter((r) => r.ok && r.v.r.duplicate).length === 7);
  ok("one payment row, advance = 7,000", num((await one("SELECT COUNT(*) n FROM payments_received WHERE customer_id=$1", [c])).n) === 1 && (await acctState(c)).credit === 7000);
}

console.log("Concurrency: deposits, sales and payments mixed, 40 operations at once");
{
  const c = await newCust("Mixed");
  const ops = [];
  for (let i = 0; i < 12; i++) ops.push(() => callOn(cashier, "SELECT record_customer_advance($1::jsonb) r", [advPayload(c, 10000 + i * 100, { idempotency_key: `bbbbbbbb-0000-4000-8000-${String(i).padStart(12, "0")}` })]));
  const mixSales = [];
  for (let i = 0; i < 14; i++) mixSales.push(await newSale(c, 25000 + i * 500));
  mixSales.forEach((sid) => ops.push(() => callOn(chair, "SELECT approve_sale($1) r", [sid])));
  for (let i = 0; i < 14; i++) ops.push(() => callOn(cashier, "SELECT record_payment($1::jsonb) r", [JSON.stringify({ factory_id: F, customer_id: c, amount: 4000, payment_method: "transfer" })]));
  ops.sort(() => Math.random() - 0.5);
  const res = await parallel(ops);
  ok("no operation errored (no deadlock, no lock timeout)", res.every((r) => r.ok), JSON.stringify(res.filter((r) => !r.ok).map((r) => r.e)));
  const s = await acctState(c);
  ok("balances non-negative and cache = ledger = per-invoice debts", consistent(s), JSON.stringify(s));
  const money = await one(`SELECT
     (SELECT COALESCE(SUM(amount),0) FROM payments_received WHERE customer_id=$1) received,
     (SELECT COALESCE(SUM(grand_total),0) FROM sales WHERE customer_id=$1 AND status='posted') goods`, [c]);
  // money in − goods out = advance − debt, whatever order things happened in
  ok("money conserved: received − goods = advance − debt", num(money.received) - num(money.goods) === s.credit - s.debt, `${money.received} - ${money.goods} vs ${s.credit} - ${s.debt}`);
  const rc = await callOn(cashier, "SELECT COUNT(*) n FROM reconcile_customer_account($1)", [c]).catch(() => null);
  ok("the built-in reconcile function reports this customer clean", rc && num(rc.n) === 0, JSON.stringify(rc));
  const dupKeys = await q("SELECT idempotency_key FROM customer_account_transactions WHERE customer_id=$1 AND idempotency_key IS NOT NULL GROUP BY 1 HAVING COUNT(*)>1", [c]);
  ok("no duplicate ledger keys", dupKeys.length === 0);
}

console.log("Concurrency: approvals, payments, reversals and write-offs on one customer (deadlock probe)");
{
  const c = await newCust("Deadlock");
  await rpc(cashier, "record_customer_advance", [advPayload(c, 30000)]);
  const errors = [];
  for (let round = 0; round < 6; round++) {
    const s1 = await newSale(c, 60000), s2 = await newSale(c, 45000);
    const ops = [
      tag("approve_sale#1", () => callOn(chair, "SELECT approve_sale($1) r", [s1])),
      tag("approve_sale#2", () => callOn(chair, "SELECT approve_sale($1) r", [s2])),
      tag("record_payment", () => callOn(cashier, "SELECT record_payment($1::jsonb) r", [JSON.stringify({ factory_id: F, customer_id: c, amount: 20000, payment_method: "cash" })])),
      tag("record_customer_advance", () => callOn(cashier, "SELECT record_customer_advance($1::jsonb) r", [advPayload(c, 15000)])),
      tag("request_adjustment", () => callOn(acct, "SELECT request_customer_adjustment($1::jsonb) r", [JSON.stringify({ factory_id: F, customer_id: c, effect: "credit_up", amount: 100, reason: "probe" })])),
    ];
    const debts = await q("SELECT id FROM debts WHERE customer_id=$1 AND outstanding>0 AND writeoff_status IS NULL LIMIT 1", [c]);
    if (debts.length) {
      await admin.query("UPDATE debts SET writeoff_status='pending_approval', writeoff_requested_by=$2 WHERE id=$1", [debts[0].id, cashier]);
      ops.push(tag("post_debt_writeoff", () => callOn(chair, "SELECT post_debt_writeoff($1,'probe') r", [debts[0].id])));
    }
    ops.push(tag("reverse_payment", async () => {
      const pays = await q("SELECT id FROM payments_received WHERE customer_id=$1 AND status='pending_confirmation' LIMIT 1", [c]);
      if (!pays.length) return null;
      await admin.query("UPDATE payments_received SET status='confirmed' WHERE id=$1", [pays[0].id]);
      return callOn(chair, "SELECT reverse_payment($1,'probe') r", [pays[0].id]);
    }));
    const res = await parallel(ops.sort(() => Math.random() - 0.5));
    res.filter((r) => !r.ok).forEach((r) => errors.push(r.e));
  }
  const deadlocks = errors.filter((e) => /deadlock/i.test(e));
  ok("no deadlock in any round", deadlocks.length === 0, deadlocks.join(" | "));
  const unexpected = errors.filter((e) => !/deadlock/i.test(e) && !/already been used|Invalid status transition|Insufficient|not found|No recorded write-off/.test(e));
  ok("only expected business refusals otherwise", unexpected.length === 0, unexpected.join(" | "));
  const s = await acctState(c);
  ok("still consistent afterwards", consistent(s), JSON.stringify(s));
}

console.log("Concurrency: independent customers do not block each other");
{
  const cs = [];
  for (let i = 0; i < 10; i++) { const c = await newCust(`Indep${i}`); await rpc(cashier, "record_customer_advance", [advPayload(c, 100000)]); cs.push(c); }
  const sids = [];
  for (const c of cs) sids.push(await newSale(c, 40000));
  const t0 = Date.now();
  const res = await parallel(sids.map((sid) => () => callOn(chair, "SELECT approve_sale($1) r", [sid])));
  ok("10 different customers approved in parallel, all fine", res.every((r) => r.ok), JSON.stringify(res.filter((r) => !r.ok)));
  ok("each customer's advance is 60,000", (await Promise.all(cs.map(acctState))).every((s) => s.credit === 60000 && consistent(s)));
  console.log(`  (took ${Date.now() - t0} ms)`);
}

console.log("Whole-database check");
{
  const diffs = await q(`
    SELECT c.name FROM customers c
    LEFT JOIN LATERAL (SELECT credit_after, debt_after FROM customer_account_transactions t WHERE t.customer_id=c.id ORDER BY seq DESC LIMIT 1) l ON true
    WHERE c.credit_balance <> COALESCE(l.credit_after,0) OR c.outstanding_balance <> COALESCE(l.debt_after,0)
       OR c.outstanding_balance <> COALESCE((SELECT SUM(outstanding) FROM debts d WHERE d.customer_id=c.id),0)`);
  ok("every customer: cache = ledger = per-invoice debts (after everything above)", diffs.length === 0, diffs.map((d) => d.name).join(", "));
  const neg = await q("SELECT 1 FROM customer_account_transactions WHERE credit_after<0 OR debt_after<0");
  ok("no ledger row ever went negative", neg.length === 0);
  const gaps = await q(`SELECT customer_id FROM (
      SELECT customer_id, credit_after - (credit_delta + COALESCE(LAG(credit_after) OVER (PARTITION BY customer_id ORDER BY seq),0)) AS gap
      FROM customer_account_transactions) x WHERE gap <> 0 LIMIT 1`);
  ok("every ledger row's balance = previous balance + its change (chain unbroken)", gaps.length === 0);
}

await admin.end();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
