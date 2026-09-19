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

// ---------- fixtures ----------
const F = (await one("INSERT INTO factories(name) VALUES ('F') RETURNING id")).id;
const uid = async () => (await one("INSERT INTO auth.users(id) VALUES (gen_random_uuid()) RETURNING id")).id;
const admin = await uid(), cashier = await uid(), maker = await uid(), accountant = await uid(), stranger = await uid();
await db.exec(`INSERT INTO user_roles VALUES ('${admin}','chairman'),('${cashier}','cashier'),('${maker}','sales'),('${accountant}','accountant')`);
await db.exec(`INSERT INTO role_permissions VALUES
  ('cashier','sales','write'),('cashier','sales','view'),('cashier','payments','write'),('cashier','customers','view'),
  ('sales','sales','write'),('sales','sales','view'),('sales','customers','view'),
  ('accountant','customers','view'),('accountant','payments','write'),('accountant','sales','view')`);
const product = (await one("INSERT INTO products(factory_id, name, current_stock) VALUES ($1,'Carton',10000) RETURNING id", [F])).id;
const cust = async (name, credit = 0, debt = 0) =>
  (await one("INSERT INTO customers(factory_id,name,credit_balance,outstanding_balance) VALUES ($1,$2,$3,$4) RETURNING id", [F, name, credit, debt])).id;

// ---------- legacy data that must survive untouched (Test 10) ----------
const legacyCust = await cust("Legacy Ltd", 1000, 300);
const legacySale = (await one(`INSERT INTO sales(factory_id,invoice_number,customer_id,grand_total,amount_paid,balance,status,created_by)
  VALUES ($1,'LEG-1',$2,500,200,300,'posted',$3) RETURNING id`, [F, legacyCust, cashier])).id;
await db.query(`INSERT INTO debts(factory_id,customer_id,sale_id,total_amount,amount_paid,outstanding,status) VALUES ($1,$2,$3,500,200,300,'partial')`, [F, legacyCust, legacySale]);
await db.query(`INSERT INTO payments_received(factory_id,receipt_number,customer_id,sale_id,amount) VALUES ($1,'LEG-RCP-1',$2,$3,200)`, [F, legacyCust, legacySale]);
const legacyFingerprint = async () =>
  (await one(`SELECT md5(
    (SELECT string_agg(s::text, '|' ORDER BY id) FROM sales s) || (SELECT string_agg(p::text, '|' ORDER BY id) FROM payments_received p)
    || (SELECT string_agg(d::text, '|' ORDER BY id) FROM debts d))  AS h`)).h;
const before = await legacyFingerprint();

// ---------- apply the migration under test ----------
for (const m of MIGRATIONS) await db.exec(fs.readFileSync(m, "utf8"));
console.log(`${MIGRATIONS.length} migration(s) applied`);

// ---------- helpers ----------
let n = 0;
const newSale = async (customer, total, paid = 0, method = "cash") => {
  const id = (await one(
    `INSERT INTO sales(factory_id,invoice_number,customer_id,grand_total,amount_paid,balance,payment_method,status,created_by,pending_payments)
     VALUES ($1,$2,$3,$4,$5,$6,$7,'pending_approval',$8,$9) RETURNING id`,
    [F, `INV-${++n}`, customer, total, paid, total - paid, method, cashier,
     paid > 0 ? JSON.stringify([{ amount: paid, method }]) : null])).id;
  await db.query("INSERT INTO sale_items(sale_id,product_id,quantity,unit_price) VALUES ($1,$2,1,$3)", [id, product, total]);
  return id;
};
const approve = async (saleId) => { await as(admin); return (await one("SELECT approve_sale($1) r", [saleId])).r; };
const advance = async (customer, amount, extra = {}) => {
  await as(cashier);
  return (await one("SELECT record_customer_advance($1::jsonb) r", [JSON.stringify({ factory_id: F, customer_id: customer, amount, payment_method: "cash", ...extra })])).r;
};
const pay = async (customer, amount, extra = {}) => {
  await as(cashier);
  return (await one("SELECT record_payment($1::jsonb) r", [JSON.stringify({ factory_id: F, customer_id: customer, amount, payment_method: "transfer", ...extra })])).r;
};
const acct = async (c) => {
  const cu = await one("SELECT credit_balance, outstanding_balance FROM customers WHERE id=$1", [c]);
  const l = await one("SELECT credit_after, debt_after FROM customer_account_transactions WHERE customer_id=$1 ORDER BY seq DESC LIMIT 1", [c]);
  return { cacheCredit: num(cu.credit_balance), cacheDebt: num(cu.outstanding_balance), ledgerCredit: num(l?.credit_after ?? 0), ledgerDebt: num(l?.debt_after ?? 0) };
};
const inSync = (a) => a.cacheCredit === a.ledgerCredit && a.cacheDebt === a.ledgerDebt;
const saleRow = async (id) => one("SELECT * FROM sales WHERE id=$1", [id]);

// ---------- Test 10: legacy data ----------
console.log("Test 10: history preserved");
ok("legacy sales/payments/debts rows byte-identical after migration", (await legacyFingerprint()) === before);
const opening = await q("SELECT * FROM customer_account_transactions WHERE customer_id=$1", [legacyCust]);
ok("one OPENING_BALANCE row for legacy customer", opening.length === 1 && opening[0].txn_type === "OPENING_BALANCE");
ok("opening row equals stored credit 1000 / debt 300", num(opening[0].credit_after) === 1000 && num(opening[0].debt_after) === 300);
ok("customers with no balance get no row", (await q("SELECT 1 FROM customer_account_transactions WHERE txn_type='OPENING_BALANCE'")).length === 1);

// ---------- Test 1 ----------
console.log("Test 1: advance 500k, sale 120k");
{
  const c = await cust("T1");
  await advance(c, 500000);
  const s = await newSale(c, 120000);
  const r = await approve(s);
  const a = await acct(c);
  ok("advance applied 120k", num(r.credit_applied) === 120000);
  ok("remaining advance 380k", a.cacheCredit === 380000 && a.ledgerCredit === 380000);
  ok("debt 0", a.cacheDebt === 0 && a.ledgerDebt === 0);
  ok("no debt row", (await q("SELECT 1 FROM debts WHERE sale_id=$1", [s])).length === 0);
  const rows = await q("SELECT txn_type, credit_delta, credit_after FROM customer_account_transactions WHERE customer_id=$1 ORDER BY seq", [c]);
  ok("ledger sequence ADVANCE_PAYMENT, SALE, ADVANCE_APPLIED", rows.map((x) => x.txn_type).join() === "ADVANCE_PAYMENT,SALE,ADVANCE_APPLIED", rows.map((x) => x.txn_type).join());
  ok("running balance 500k then 380k", num(rows[0].credit_after) === 500000 && num(rows[2].credit_after) === 380000);
  const st = await one("SELECT sale_payment_status(status,is_pr,amount_paid,credit_applied,balance) s FROM sales WHERE id=$1", [s]);
  ok("status PAID VIA CUSTOMER ADVANCE", st.s === "PAID VIA CUSTOMER ADVANCE", st.s);
}

// ---------- Test 2 ----------
console.log("Test 2: advance 120k, sale 120k");
{
  const c = await cust("T2");
  await advance(c, 120000);
  await approve(await newSale(c, 120000));
  const a = await acct(c);
  ok("advance exhausted, debt 0", a.cacheCredit === 0 && a.cacheDebt === 0 && inSync(a));
  const s = await one("SELECT account_status FROM customer_account_summary WHERE customer_id=$1", [c]);
  ok("status BALANCED", s.account_status === "BALANCED", s.account_status);
}

// ---------- Test 3 ----------
console.log("Test 3: advance 100k, sale 150k");
{
  const c = await cust("T3");
  await advance(c, 100000);
  const sid = await newSale(c, 150000);
  const r = await approve(sid);
  const a = await acct(c);
  ok("advance used 100k", num(r.credit_applied) === 100000);
  ok("debt 50k, credit 0", a.cacheDebt === 50000 && a.cacheCredit === 0 && inSync(a));
  const d = await one("SELECT * FROM debts WHERE sale_id=$1", [sid]);
  ok("debt row 50k partial", num(d.outstanding) === 50000 && d.status === "partial");
  const sm = await one("SELECT account_status FROM customer_account_summary WHERE customer_id=$1", [c]);
  ok("status OUTSTANDING DEBT", sm.account_status === "OUTSTANDING DEBT");
  const st = await one("SELECT sale_payment_status(status,is_pr,amount_paid,credit_applied,balance) s FROM sales WHERE id=$1", [sid]);
  ok("status PARTIALLY PAID", st.s === "PARTIALLY PAID", st.s);
}

// ---------- Test 4 ----------
console.log("Test 4: no advance, sale 150k");
{
  const c = await cust("T4");
  const sid = await newSale(c, 150000);
  await approve(sid);
  const a = await acct(c);
  ok("debt 150k, no credit", a.cacheDebt === 150000 && a.cacheCredit === 0 && inSync(a));
  const st = await one("SELECT sale_payment_status(status,is_pr,amount_paid,credit_applied,balance) s FROM sales WHERE id=$1", [sid]);
  ok("status UNPAID", st.s === "UNPAID", st.s);
}

// ---------- Test 5 ----------
console.log("Test 5: advance 500k, sales 100k/150k/50k");
{
  const c = await cust("T5");
  await advance(c, 500000);
  for (const t of [100000, 150000, 50000]) await approve(await newSale(c, t));
  const a = await acct(c);
  ok("remaining 200k", a.cacheCredit === 200000 && inSync(a));
  const sm = await one("SELECT * FROM customer_account_summary WHERE customer_id=$1", [c]);
  ok("summary: advance paid 500k, used 300k, goods 300k", num(sm.total_advance_paid) === 500000 && num(sm.advance_used) === 300000 && num(sm.goods_collected) === 300000, JSON.stringify(sm));
  ok("summary: available 200k, status CREDIT BALANCE", num(sm.available_advance) === 200000 && sm.account_status === "CREDIT BALANCE");
}

// ---------- Test 6 + spec section 11 ----------
console.log("Test 6: debt 50k, customer pays 100k");
{
  const c = await cust("T6");
  const sid = await newSale(c, 50000);
  await approve(sid);
  const r = await pay(c, 100000);
  const a = await acct(c);
  ok("debt cleared 50k, credit 50k", num(r.settled_debt) === 50000 && num(r.credit_added) === 50000);
  ok("balances debt 0 credit 50k, in sync", a.cacheDebt === 0 && a.cacheCredit === 50000 && inSync(a));
  const d = await one("SELECT * FROM debts WHERE sale_id=$1", [sid]);
  ok("debt row paid", d.status === "paid" && num(d.outstanding) === 0);
  const sale = await saleRow(sid);
  ok("sale amount_paid 50k, balance 0", num(sale.amount_paid) === 50000 && num(sale.balance) === 0);
  const rows = await q("SELECT txn_type FROM customer_account_transactions WHERE customer_id=$1 ORDER BY seq", [c]);
  ok("ledger SALE, DEBT_SETTLEMENT, CUSTOMER_PAYMENT", rows.map((x) => x.txn_type).join() === "SALE,DEBT_SETTLEMENT,CUSTOMER_PAYMENT", rows.map((x) => x.txn_type).join());
}
console.log("Spec section 11: 500k advance, 120k, 150k, 300k, then pays 100k");
{
  const c = await cust("S11");
  await advance(c, 500000);
  await approve(await newSale(c, 120000));
  await approve(await newSale(c, 150000));
  const s3 = await newSale(c, 300000);
  const r = await approve(s3);
  let a = await acct(c);
  ok("third sale uses 230k, debt 70k", num(r.credit_applied) === 230000 && a.cacheDebt === 70000 && a.cacheCredit === 0 && inSync(a));
  await advance(c, 100000);
  a = await acct(c);
  ok("advance 100k clears 70k debt, leaves 30k credit", a.cacheDebt === 0 && a.cacheCredit === 30000 && inSync(a));
}
console.log("Oldest debt first");
{
  const c = await cust("OLD");
  const a1 = await newSale(c, 10000); await approve(a1);
  const a2 = await newSale(c, 20000); await approve(a2);
  await pay(c, 15000);
  const d1 = await one("SELECT outstanding FROM debts WHERE sale_id=$1", [a1]);
  const d2 = await one("SELECT outstanding FROM debts WHERE sale_id=$1", [a2]);
  ok("oldest fully paid, remainder on next", num(d1.outstanding) === 0 && num(d2.outstanding) === 15000);
  ok("in sync", inSync(await acct(c)));
}
console.log("Targeted debt jumps the queue");
{
  const c = await cust("TGT");
  const a1 = await newSale(c, 10000); await approve(a1);
  const a2 = await newSale(c, 20000); await approve(a2);
  const d2 = await one("SELECT id FROM debts WHERE sale_id=$1", [a2]);
  await pay(c, 20000, { debt_id: d2.id, sale_id: a2 });
  const r1 = await one("SELECT outstanding FROM debts WHERE sale_id=$1", [a1]);
  const r2 = await one("SELECT outstanding FROM debts WHERE sale_id=$1", [a2]);
  ok("chosen invoice settled first", num(r2.outstanding) === 0 && num(r1.outstanding) === 10000);
}
console.log("Legacy customer with credit AND debt: nothing netted silently");
{
  const a = await acct(legacyCust);
  ok("both sides still shown", a.cacheCredit === 1000 && a.cacheDebt === 300);
  const sm = await one("SELECT account_status FROM customer_account_summary WHERE customer_id=$1", [legacyCust]);
  ok("status CREDIT AND DEBT", sm.account_status === "CREDIT AND DEBT", sm.account_status);
}

// ---------- overpayment at register ----------
console.log("Overpayment at the register becomes credit");
{
  const c = await cust("OVER");
  const sid = await newSale(c, 10000, 15000);
  await approve(sid);
  const a = await acct(c);
  ok("5k excess held as credit", a.cacheCredit === 5000 && a.cacheDebt === 0 && inSync(a));
}

// ---------- idempotency / duplicates ----------
console.log("Duplicate posting protection");
{
  const c = await cust("IDEM");
  const key = "11111111-1111-1111-1111-111111111111";
  const r1 = await advance(c, 1000, { idempotency_key: key });
  const r2 = await advance(c, 1000, { idempotency_key: key });
  ok("second submit flagged duplicate, same payment", r2.duplicate === true && r2.payment_id === r1.payment_id);
  ok("only one payment / 1000 credit", (await q("SELECT 1 FROM payments_received WHERE customer_id=$1", [c])).length === 1 && (await acct(c)).cacheCredit === 1000);
  const sid = await newSale(c, 100);
  await approve(sid);
  const e = await fails(() => approve(sid));
  ok("cannot approve the same sale twice", !!e, e);
  ok("still consistent after failed double approval", inSync(await acct(c)) && (await acct(c)).cacheCredit === 900);
}

// ---------- Test 7: reversal ----------
console.log("Test 7: reverse a sale that used advance");
{
  const c = await cust("T7");
  await advance(c, 500000);
  const sid = await newSale(c, 100000);
  await approve(sid);
  const stockBefore = num((await one("SELECT current_stock FROM products WHERE id=$1", [product])).current_stock);
  const dr = (await one("INSERT INTO delete_requests(factory_id,table_name,entity_id,entity_label,reason,requested_by) VALUES ($1,'sales',$2,'INV','entered in error',$3) RETURNING id", [F, sid, cashier])).id;
  await as(admin);
  await one("SELECT approve_delete($1)", [dr]);
  const a = await acct(c);
  ok("advance restored to 500k", a.cacheCredit === 500000 && inSync(a), JSON.stringify(a));
  const rows = await q("SELECT txn_type, reverses_id FROM customer_account_transactions WHERE customer_id=$1 ORDER BY seq", [c]);
  ok("originals kept, compensating rows appended", rows.map((x) => x.txn_type).join() === "ADVANCE_PAYMENT,SALE,ADVANCE_APPLIED,REVERSAL,ADVANCE_RESTORED", rows.map((x) => x.txn_type).join());
  ok("REVERSAL points at the original SALE row", !!rows[3].reverses_id);
  ok("stock returned", num((await one("SELECT current_stock FROM products WHERE id=$1", [product])).current_stock) === stockBefore + 1);
  const aud = await q("SELECT action, old_value, new_value FROM audit_logs WHERE entity='customers' AND entity_id=$1 AND action IN ('customer_ledger_reversal','customer_advance_restored') ORDER BY created_at", [c]);
  ok("reversal audited with restored advance", aud.some((a) => a.action === "customer_advance_restored" && Number(a.new_value.amount) === 100000), JSON.stringify(aud));
  const restored = aud.find((a) => a.action === "customer_advance_restored");
  ok("audit carries previous and new balances", restored && Number(restored.old_value.advance) === 400000 && Number(restored.new_value.advance) === 500000, JSON.stringify(restored));
  ok("audit carries the reason", restored && restored.new_value.reason === "entered in error", JSON.stringify(restored?.new_value));
  const upd = await fails(() => db.query("UPDATE customer_account_transactions SET amount = 1 WHERE customer_id=$1", [c]));
  const del = await fails(() => db.query("DELETE FROM customer_account_transactions WHERE customer_id=$1", [c]));
  ok("ledger rows cannot be edited or deleted", !!upd && !!del);
}
console.log("Reverse a sale that carried debt");
{
  const c = await cust("T7b");
  const sid = await newSale(c, 80000);
  await approve(sid);
  const dr = (await one("INSERT INTO delete_requests(factory_id,table_name,entity_id,entity_label,reason,requested_by) VALUES ($1,'sales',$2,'INV','dup',$3) RETURNING id", [F, sid, cashier])).id;
  await as(admin);
  await one("SELECT approve_delete($1)", [dr]);
  const a = await acct(c);
  ok("debt removed, in sync", a.cacheDebt === 0 && a.ledgerDebt === 0 && inSync(a), JSON.stringify(a));
}

// ---------- payment reversal ----------
console.log("Reverse payments");
{
  const c = await cust("REV");
  const sid = await newSale(c, 50000);
  await approve(sid);
  const r = await pay(c, 80000); // 50k settles debt, 30k credit
  await db.query("UPDATE payments_received SET status='confirmed' WHERE id=$1", [r.payment_id]);
  await as(admin);
  await one("SELECT reverse_payment($1,'wrong customer')", [r.payment_id]);
  const a = await acct(c);
  ok("debt back to 50k, credit 0", a.cacheDebt === 50000 && a.cacheCredit === 0 && inSync(a), JSON.stringify(a));
  const d = await one("SELECT * FROM debts WHERE sale_id=$1", [sid]);
  ok("debt row reopened", num(d.outstanding) === 50000 && d.status === "unpaid");
  ok("sale balance restored", num((await saleRow(sid)).balance) === 50000);
}
console.log("Reversing an advance whose credit is already spent is refused");
{
  const c = await cust("REV2");
  const adv = await advance(c, 10000);
  await approve(await newSale(c, 8000));
  await db.query("UPDATE payments_received SET status='confirmed' WHERE id=$1", [adv.payment_id]);
  await as(admin);
  const e = await fails(() => one("SELECT reverse_payment($1,'oops')", [adv.payment_id]));
  ok("refused with clear message", !!e && /already been used/.test(e), e);
  ok("nothing changed", (await acct(c)).cacheCredit === 2000);
}
console.log("Reversing an unspent advance removes the credit (old code raised the debt instead)");
{
  const c = await cust("REV3");
  const adv = await advance(c, 10000);
  await db.query("UPDATE payments_received SET status='confirmed' WHERE id=$1", [adv.payment_id]);
  await as(admin);
  await one("SELECT reverse_payment($1,'mistake')", [adv.payment_id]);
  const a = await acct(c);
  ok("credit 0, debt 0", a.cacheCredit === 0 && a.cacheDebt === 0 && inSync(a));
}

// ---------- write-off ----------
console.log("Debt write-off keeps the ledger in step");
{
  const c = await cust("WO");
  const sid = await newSale(c, 40000);
  await approve(sid);
  const d = await one("SELECT id FROM debts WHERE sale_id=$1", [sid]);
  await db.query("UPDATE debts SET writeoff_status='pending_approval', writeoff_requested_by=$2 WHERE id=$1", [d.id, cashier]);
  await as(admin);
  await one("SELECT post_debt_writeoff($1,'bad debt')", [d.id]);
  ok("debt cleared in ledger", (await acct(c)).ledgerDebt === 0 && inSync(await acct(c)));
  await one("SELECT reverse_debt_writeoff($1,'recovered')", [d.id]);
  ok("write-off reversed back to 40k", (await acct(c)).ledgerDebt === 40000 && inSync(await acct(c)));
}

// ---------- Test 9: authorization + adjustments ----------
console.log("Test 9: permissions and maker-checker adjustments");
{
  const c = await cust("ADJ");
  await advance(c, 20000);
  const adj = (who, effect, amount, reason = "count correction") =>
    as(who).then(() => one("SELECT request_customer_adjustment($1::jsonb) r", [JSON.stringify({ factory_id: F, customer_id: c, effect, amount, reason })]));

  ok("stranger cannot request", !!(await fails(() => adj(stranger, "credit_up", 100))));
  ok("sales-role user cannot request", !!(await fails(() => adj(maker, "credit_up", 100))));
  ok("reason is mandatory", !!(await fails(() => adj(accountant, "credit_up", 100, ""))));
  const req = (await adj(accountant, "credit_down", 5000)).r;
  ok("accountant can submit", req.status === "pending_approval");
  ok("balance untouched until approved", (await acct(c)).cacheCredit === 20000);
  await as(accountant);
  ok("submitter cannot approve own request", !!(await fails(() => one("SELECT approve_customer_adjustment($1)", [req.adjustment_id]))));
  await as(stranger);
  ok("unauthorised user cannot approve", !!(await fails(() => one("SELECT approve_customer_adjustment($1)", [req.adjustment_id]))));
  await as(admin);
  await one("SELECT approve_customer_adjustment($1,'ok')", [req.adjustment_id]);
  const a = await acct(c);
  ok("approval applies it: credit 15k, in sync", a.cacheCredit === 15000 && inSync(a));
  ok("cannot approve twice", !!(await fails(() => one("SELECT approve_customer_adjustment($1)", [req.adjustment_id]))));
  const led = await one("SELECT txn_type, notes FROM customer_account_transactions WHERE customer_id=$1 ORDER BY seq DESC LIMIT 1", [c]);
  ok("ledger row DEBIT_ADJUSTMENT with the reason", led.txn_type === "DEBIT_ADJUSTMENT" && led.notes === "count correction", JSON.stringify(led));

  const over = (await adj(accountant, "credit_down", 999999)).r;
  await as(admin);
  ok("cannot reduce below available credit", !!(await fails(() => one("SELECT approve_customer_adjustment($1)", [over.adjustment_id]))));
  const rej = (await adj(accountant, "credit_up", 100)).r;
  await as(admin);
  await one("SELECT reject_customer_adjustment($1,'not justified')", [rej.adjustment_id]);
  ok("rejected adjustment leaves balance alone", (await acct(c)).cacheCredit === 15000);
  const debtUp = (await adj(accountant, "debt_up", 7000)).r;
  await as(admin);
  await one("SELECT approve_customer_adjustment($1)", [debtUp.adjustment_id]);
  const b = await acct(c);
  ok("debt_up creates matching invoice-level debt", b.cacheDebt === 7000 && inSync(b));
  const debtDown = (await adj(accountant, "debt_down", 7000)).r;
  await as(admin);
  await one("SELECT approve_customer_adjustment($1)", [debtDown.adjustment_id]);
  const c2 = await acct(c);
  ok("debt_down clears it", c2.cacheDebt === 0 && inSync(c2));
  ok("per-invoice debts agree with cache", (await q("SELECT * FROM reconcile_customer_account($1)", [c])).length === 0);

  // direct writes cannot bypass the RPCs (authenticated has no INSERT/UPDATE on the ledger)
  await db.exec("SET ROLE authenticated");
  const direct = await fails(() => db.query("INSERT INTO customer_account_transactions(factory_id,customer_id,txn_type,credit_after,debt_after) VALUES ($1,$2,'CREDIT_ADJUSTMENT',999,0)", [F, c]));
  await db.exec("RESET ROLE");
  ok("direct INSERT into the ledger is denied", !!direct, direct);
}

// ---------- reconciliation ----------
console.log("Reconciliation");
{
  await as(admin);
  const diffs = await q("SELECT * FROM reconcile_customer_account()");
  const names = diffs.map((d) => d.customer_name);
  // The legacy customer's stored debt (300) matches its debt row, so it must be clean too.
  ok("no customer out of sync after all of the above", diffs.length === 0, JSON.stringify(names));
  await db.query("UPDATE customers SET credit_balance = credit_balance + 5 WHERE id=$1", [legacyCust]);
  ok("a manual edit to the cached balance is detected", (await q("SELECT * FROM reconcile_customer_account()")).some((d) => d.customer_name === "Legacy Ltd"));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
