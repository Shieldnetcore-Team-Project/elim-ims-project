import { db } from '../db/client.js';
import { nextBusinessId } from '../db/ids.js';
import * as activityLog from './activityLog.js';
import * as marketerStock from './marketerStock.js';
import * as finance from './finance.js';
import * as sales from './sales.js';

export interface MarketerCustomer {
  id: string; marketer_id: string; name: string; phone: string | null; location: string | null;
  route: string | null; credit_limit: number; status: 'ACTIVE' | 'INACTIVE'; created_at: string;
}
export interface CustomerBalance { invoiced: number; paid: number; outstanding: number }

export async function createCustomer(params: {
  marketerId: string; name: string; phone?: string; location?: string; route?: string; creditLimit?: number; actor?: string;
}): Promise<MarketerCustomer> {
  await marketerStock.assertMarketer(params.marketerId);
  const id = await nextBusinessId('marketer_customers', 'MCU-', 4);
  await db.prepare('INSERT INTO marketer_customers (id, marketer_id, name, phone, location, route, credit_limit) VALUES (?,?,?,?,?,?,?)')
    .run(id, params.marketerId, params.name, params.phone ?? null, params.location ?? null, params.route ?? null, params.creditLimit ?? 0);
  await activityLog.record(params.actor ?? 'System Administrator', 'added customer for', 'marketer', params.marketerId, `${id}: ${params.name}`);
  return (await getCustomer(id))!;
}

export async function updateCustomer(id: string, patch: {
  phone?: string; location?: string; route?: string; creditLimit?: number; status?: 'ACTIVE' | 'INACTIVE';
}, actor?: string): Promise<MarketerCustomer> {
  const existing = await getCustomer(id);
  if (!existing) throw new Error(`Unknown customer ${id}`);
  await db.prepare('UPDATE marketer_customers SET phone = ?, location = ?, route = ?, credit_limit = ?, status = ? WHERE id = ?').run(
    patch.phone ?? existing.phone, patch.location ?? existing.location, patch.route ?? existing.route,
    patch.creditLimit ?? existing.credit_limit, patch.status ?? existing.status, id,
  );
  await activityLog.record(actor ?? 'System Administrator', 'updated customer', 'marketer_customer', id, `${id} profile updated`);
  return (await getCustomer(id))!;
}

export async function getCustomer(id: string): Promise<MarketerCustomer | undefined> {
  return await db.prepare('SELECT * FROM marketer_customers WHERE id = ?').get(id) as MarketerCustomer | undefined;
}

export async function listCustomers(marketerId?: string): Promise<(MarketerCustomer & { outstanding: number })[]> {
  const rows = (marketerId
    ? await db.prepare('SELECT * FROM marketer_customers WHERE marketer_id = ? ORDER BY name').all(marketerId)
    : await db.prepare('SELECT * FROM marketer_customers ORDER BY name').all()) as unknown as MarketerCustomer[];
  const out: (MarketerCustomer & { outstanding: number })[] = [];
  for (const c of rows) out.push({ ...c, outstanding: (await customerBalance(c.id)).outstanding });
  return out;
}

/** invoiced/paid/outstanding for one customer's own sub-ledger — same
 *  debit=invoiced/credit=paid convention as finance.customerBalance, just
 *  scoped to marketer_customer_ledger instead of the company ledger. */
export async function customerBalance(customerId: string): Promise<CustomerBalance> {
  const row = await db.prepare(
    `SELECT COALESCE(SUM(debit), 0) AS invoiced, COALESCE(SUM(credit), 0) AS paid FROM marketer_customer_ledger WHERE customer_id = ?`,
  ).get(customerId) as { invoiced: number; paid: number };
  return { invoiced: row.invoiced, paid: row.paid, outstanding: row.invoiced - row.paid };
}

export async function customerStatement(customerId: string) {
  return await db.prepare(`
    SELECT id, entry_date, debit, credit, description, reference_id,
      SUM(debit - credit) OVER (ORDER BY entry_date, id) AS running_balance
    FROM marketer_customer_ledger
    WHERE customer_id = ?
    ORDER BY entry_date, id
  `).all(customerId);
}

export async function productsPurchased(customerId: string) {
  return await db.prepare(`
    SELECT mcsi.item_id, i.name AS item_name, SUM(mcsi.quantity) AS total_quantity, SUM(mcsi.quantity * mcsi.unit_price) AS total_value
    FROM marketer_customer_sale_items mcsi
    JOIN marketer_customer_sales mcs ON mcs.id = mcsi.sale_id
    JOIN items i ON i.id = mcsi.item_id
    WHERE mcs.customer_id = ?
    GROUP BY mcsi.item_id, i.name
    ORDER BY total_value DESC
  `).all(customerId);
}

export async function listSales(customerId: string) {
  return await db.prepare('SELECT * FROM marketer_customer_sales WHERE customer_id = ? ORDER BY id DESC').all(customerId);
}

export async function listPayments(customerId: string) {
  return await db.prepare('SELECT * FROM marketer_customer_payments WHERE customer_id = ? ORDER BY id DESC').all(customerId);
}

/** A sale attributed to one of a marketer's own customers — physically the
 *  same event marketerStock.recordSale already models (see postFieldSale),
 *  plus the credit-limit/cash-in-full rule this module adds real teeth to:
 *  credit_limit = 0 requires full payment; credit_limit > 0 caps how far
 *  this sale can push the customer's outstanding balance. Rolls back the
 *  shared stock/company-AR posting too if that rule is violated — nothing
 *  commits until every check has passed. */
export async function recordCustomerSale(params: {
  marketerId: string; customerId: string; items: { itemId: string; quantity: number }[]; cashReceived: number; actor: string;
}): Promise<{ id: string }> {
  await marketerStock.assertMarketer(params.marketerId);
  const customer = await getCustomer(params.customerId);
  if (!customer) throw new Error(`Unknown customer ${params.customerId}`);
  if (customer.marketer_id !== params.marketerId) throw new Error(`${params.customerId} does not belong to marketer ${params.marketerId}`);
  if (customer.status !== 'ACTIVE') throw new Error(`${customer.name} is not an active customer`);

  const id = await nextBusinessId('marketer_customer_sales', 'MCS-', 4);
  await db.transaction(async () => {
    await db.prepare('INSERT INTO marketer_customer_sales (id, marketer_id, customer_id, cash_received, created_by) VALUES (?,?,?,?,?)')
      .run(id, params.marketerId, params.customerId, params.cashReceived, params.actor);

    const { totalValue, prices } = await marketerStock.postFieldSale({
      marketerId: params.marketerId, items: params.items, cashReceived: params.cashReceived, actor: params.actor, sourceId: id,
    });

    const currentOutstanding = (await customerBalance(params.customerId)).outstanding;
    const creditGiven = totalValue - params.cashReceived;
    if (customer.credit_limit <= 0) {
      if (params.cashReceived < totalValue) {
        throw new Error(`${customer.name} is a cash customer (no credit limit) — full payment of ₦${totalValue.toLocaleString('en-NG')} is required`);
      }
    } else if (currentOutstanding + creditGiven > customer.credit_limit) {
      throw new Error(`${customer.name}'s credit limit is ₦${customer.credit_limit.toLocaleString('en-NG')} — this sale would push their outstanding balance to ₦${(currentOutstanding + creditGiven).toLocaleString('en-NG')}`);
    }

    const insertItem = db.prepare('INSERT INTO marketer_customer_sale_items (sale_id, item_id, quantity, unit_price) VALUES (?,?,?,?)');
    for (const it of params.items) {
      await insertItem.run(id, it.itemId, it.quantity, prices.get(it.itemId)!);
    }

    if (totalValue > 0) {
      await db.prepare('INSERT INTO marketer_customer_ledger (customer_id, debit, credit, description, reference_id) VALUES (?,?,0,?,?)')
        .run(params.customerId, totalValue, `Sale ${id}`, id);
    }
    if (params.cashReceived > 0) {
      await db.prepare('INSERT INTO marketer_customer_ledger (customer_id, debit, credit, description, reference_id) VALUES (?,0,?,?,?)')
        .run(params.customerId, params.cashReceived, `Payment against sale ${id}`, id);
    }

    await activityLog.record(params.actor, 'recorded sale to', 'marketer_customer', params.customerId,
      `${id}: ₦${totalValue.toLocaleString('en-NG')} sold to ${customer.name}, ₦${params.cashReceived.toLocaleString('en-NG')} cash received`);
  });
  return { id };
}

/** invoice amount minus whatever's been credited against it specifically
 *  (marketer_customer_ledger rows whose reference_id is this sale — both the
 *  at-sale cash recordCustomerSale posts and any later saleId-targeted
 *  recordPayment below use this same convention). */
export async function invoiceBalance(saleId: string): Promise<number> {
  const amount = (await db.prepare(
    `SELECT COALESCE(SUM(quantity * unit_price), 0) AS v FROM marketer_customer_sale_items WHERE sale_id = ?`,
  ).get(saleId) as { v: number }).v;
  const paid = (await db.prepare(
    `SELECT COALESCE(SUM(credit), 0) AS v FROM marketer_customer_ledger WHERE reference_id = ?`,
  ).get(saleId) as { v: number }).v;
  return amount - paid;
}

/** A standalone payment against an existing balance — a customer paying down
 *  credit later, not tied to a new sale. Posts to both this customer's own
 *  sub-ledger AND the company-level Accounts receivable for their marketer
 *  (finance.recordReceipt, same as the cash portion of recordCustomerSale
 *  already does via postFieldSale) — otherwise the company would keep
 *  showing the marketer as owing money a customer already paid down.
 *  Optionally targets one specific invoice (saleId) — a collector settling
 *  "invoice MCS-0002" rather than a vague lump sum against the customer as a
 *  whole; when given, the ledger entry is tagged to that invoice (so
 *  invoiceBalance/invoiceFollowUps can see it) and validated against just
 *  that invoice's remaining balance. Omitted, this is unchanged from before
 *  Module 10 — a general payment against the customer's overall balance. */
export async function recordPayment(params: {
  customerId: string; amount: number; method: string; actor: string; referenceId?: string; saleId?: string;
}): Promise<void> {
  const customer = await getCustomer(params.customerId);
  if (!customer) throw new Error(`Unknown customer ${params.customerId}`);
  if (params.amount <= 0) throw new Error('amount must be positive');

  if (params.saleId) {
    const sale = await db.prepare('SELECT customer_id FROM marketer_customer_sales WHERE id = ?').get(params.saleId) as { customer_id: string } | undefined;
    if (!sale) throw new Error(`Unknown invoice ${params.saleId}`);
    if (sale.customer_id !== params.customerId) throw new Error(`${params.saleId} does not belong to ${customer.name}`);
    const cap = await invoiceBalance(params.saleId);
    if (params.amount > cap) {
      throw new Error(`Cannot pay ₦${params.amount.toLocaleString('en-NG')} against ${params.saleId} — only ₦${cap.toLocaleString('en-NG')} is outstanding on that invoice`);
    }
  } else {
    const { outstanding } = await customerBalance(params.customerId);
    if (params.amount > outstanding) {
      throw new Error(`Cannot pay ₦${params.amount.toLocaleString('en-NG')} — only ₦${outstanding.toLocaleString('en-NG')} is outstanding for ${customer.name}`);
    }
  }

  const id = await nextBusinessId('marketer_customer_payments', 'MCP-', 4);
  const ledgerRef = params.saleId ?? id;
  await db.transaction(async () => {
    await db.prepare('INSERT INTO marketer_customer_payments (id, customer_id, amount, method, reference_id, actor) VALUES (?,?,?,?,?,?)')
      .run(id, params.customerId, params.amount, params.method, params.saleId ?? params.referenceId ?? null, params.actor);
    await db.prepare('INSERT INTO marketer_customer_ledger (customer_id, debit, credit, description, reference_id) VALUES (?,0,?,?,?)')
      .run(params.customerId, params.amount, params.saleId ? `Payment against ${params.saleId}` : `Payment ${id}`, ledgerRef);
    await finance.recordReceipt({
      receivedFrom: customer.marketer_id, amount: params.amount, method: params.method,
      referenceType: 'sales', referenceId: id, actor: params.actor, customerId: customer.marketer_id,
    });
    await activityLog.record(params.actor, 'recorded payment from', 'marketer_customer', params.customerId,
      `${id}: ₦${params.amount.toLocaleString('en-NG')} from ${customer.name}${params.saleId ? ` against ${params.saleId}` : ''}`);
  });
}

/** Partial update — only overwrites whichever of dueDate/collector was
 *  actually provided. */
export async function assignFollowUp(saleId: string, params: { dueDate?: string; collector?: string; actor?: string }): Promise<void> {
  const existing = await db.prepare('SELECT due_date, collector FROM marketer_customer_sales WHERE id = ?').get(saleId) as { due_date: string | null; collector: string | null } | undefined;
  if (!existing) throw new Error(`Unknown invoice ${saleId}`);
  const dueDate = params.dueDate ?? existing.due_date;
  const collector = params.collector ?? existing.collector;
  await db.prepare('UPDATE marketer_customer_sales SET due_date = ?, collector = ? WHERE id = ?').run(dueDate, collector, saleId);
  await activityLog.record(params.actor ?? 'System Administrator', 'assigned follow-up for', 'marketer_customer_sale', saleId,
    `Due ${dueDate ?? 'not set'}, collector ${collector ?? 'unassigned'}`);
}

export async function addRemark(saleId: string, params: { remark: string; actor: string }): Promise<void> {
  const exists = await db.prepare('SELECT id FROM marketer_customer_sales WHERE id = ?').get(saleId);
  if (!exists) throw new Error(`Unknown invoice ${saleId}`);
  if (!params.remark.trim()) throw new Error('remark cannot be empty');
  await db.prepare('INSERT INTO marketer_customer_sale_remarks (sale_id, remark, actor) VALUES (?,?,?)').run(saleId, params.remark.trim(), params.actor);
  await activityLog.record(params.actor, 'added remark to', 'marketer_customer_sale', saleId, params.remark.trim());
}

export async function listRemarks(saleId: string) {
  return await db.prepare('SELECT * FROM marketer_customer_sale_remarks WHERE sale_id = ? ORDER BY id DESC').all(saleId);
}

export interface InvoiceFollowUp {
  id: string; customer_id: string; created_at: string; due_date: string | null; collector: string | null;
  products: string; quantity: number; amount: number; balance: number;
  last_payment_date: string | null; last_payment_method: string | null; remarks_count: number;
}

/** The follow-up sheet for one customer's invoices — Invoice/Product/
 *  Quantity/Amount/Due Date/Balance/Collector/Payment Date/Payment Method,
 *  everything Module 10 asks to track, in one row per invoice. */
export async function invoiceFollowUps(customerId: string): Promise<InvoiceFollowUp[]> {
  const salesRows = await db.prepare(
    `SELECT id, customer_id, created_at, due_date, collector, cash_received FROM marketer_customer_sales WHERE customer_id = ? ORDER BY id DESC`,
  ).all(customerId) as { id: string; customer_id: string; created_at: string; due_date: string | null; collector: string | null; cash_received: number }[];

  const out: InvoiceFollowUp[] = [];
  for (const s of salesRows) {
    const items = await db.prepare(
      `SELECT i.name, mcsi.quantity, mcsi.unit_price FROM marketer_customer_sale_items mcsi JOIN items i ON i.id = mcsi.item_id WHERE mcsi.sale_id = ?`,
    ).all(s.id) as { name: string; quantity: number; unit_price: number }[];
    const amount = items.reduce((sum, it) => sum + it.quantity * it.unit_price, 0);
    const quantity = items.reduce((sum, it) => sum + it.quantity, 0);
    const products = items.map(it => it.name).join(', ');
    const paid = (await db.prepare(`SELECT COALESCE(SUM(credit), 0) AS v FROM marketer_customer_ledger WHERE reference_id = ?`).get(s.id) as { v: number }).v;
    const targetedPayment = await db.prepare(
      `SELECT paid_at, method FROM marketer_customer_payments WHERE reference_id = ? ORDER BY paid_at DESC LIMIT 1`,
    ).get(s.id) as { paid_at: string; method: string } | undefined;
    const remarksCount = (await db.prepare(`SELECT COUNT(*) AS n FROM marketer_customer_sale_remarks WHERE sale_id = ?`).get(s.id) as { n: number }).n;

    out.push({
      id: s.id, customer_id: s.customer_id, created_at: s.created_at, due_date: s.due_date, collector: s.collector,
      products, quantity, amount, balance: amount - paid,
      last_payment_date: targetedPayment?.paid_at ?? (s.cash_received > 0 ? s.created_at : null),
      last_payment_method: targetedPayment?.method ?? (s.cash_received > 0 ? 'Cash' : null),
      remarks_count: remarksCount,
    });
  }
  return out;
}

export type ReminderBucket = 'OVERDUE' | 'DUE_SOON' | 'NO_DUE_DATE' | 'ON_TRACK';
export interface CollectionRow extends InvoiceFollowUp { customer_name: string; marketer_id: string; marketer_name: string; bucket: ReminderBucket }

/** Every outstanding invoice across every marketer's customers, bucketed for
 *  reminder follow-up — due dates/buckets are computed live against today,
 *  never stored. */
export async function collectionsReport(): Promise<CollectionRow[]> {
  const customers = await db.prepare(`SELECT id, name, marketer_id FROM marketer_customers`).all() as { id: string; name: string; marketer_id: string }[];
  const now = Date.now();
  const DAY = 24 * 60 * 60 * 1000;
  const rows: CollectionRow[] = [];

  for (const c of customers) {
    const marketer = await sales.getCustomer(c.marketer_id);
    for (const inv of await invoiceFollowUps(c.id)) {
      if (inv.balance <= 0) continue;
      let bucket: ReminderBucket;
      if (!inv.due_date) {
        bucket = 'NO_DUE_DATE';
      } else {
        const daysUntil = (new Date(inv.due_date).getTime() - now) / DAY;
        bucket = daysUntil < 0 ? 'OVERDUE' : daysUntil <= 7 ? 'DUE_SOON' : 'ON_TRACK';
      }
      rows.push({ ...inv, customer_name: c.name, marketer_id: c.marketer_id, marketer_name: marketer?.name ?? c.marketer_id, bucket });
    }
  }

  return rows.sort((a, b) => (a.due_date ?? '9999-99-99').localeCompare(b.due_date ?? '9999-99-99'));
}

export type RecoveryStatus = 'CREDIT' | 'PARTIALLY_PAID' | 'FULLY_PAID' | 'OVERDUE';
export interface CreditTransaction extends InvoiceFollowUp {
  customer_name: string; marketer_id: string; marketer_name: string;
  credit_limit: number; amount_paid: number; recovery_status: RecoveryStatus;
}

/** Section 15: every credit transaction ever raised against a marketer's
 *  field customer, tracked as its own row — unlike collectionsReport() below
 *  (built for the reminders queue, so it only lists what's still
 *  outstanding), this keeps a FULLY_PAID invoice visible too, since "tracked
 *  separately" means the whole lifecycle, not just what's still owed.
 *  recovery_status: OVERDUE takes precedence over a partial payment (an
 *  invoice can be both partially paid and overdue at once — overdue is the
 *  more actionable fact); CREDIT means nothing has been recovered yet and
 *  it isn't overdue. */
export async function creditTransactions(): Promise<CreditTransaction[]> {
  const customers = await db.prepare(`SELECT id, name, marketer_id, credit_limit FROM marketer_customers`).all() as
    { id: string; name: string; marketer_id: string; credit_limit: number }[];
  const now = Date.now();
  const rows: CreditTransaction[] = [];

  for (const c of customers) {
    const marketer = await sales.getCustomer(c.marketer_id);
    for (const inv of await invoiceFollowUps(c.id)) {
      const amountPaid = inv.amount - inv.balance;
      let status: RecoveryStatus;
      if (inv.balance <= 0) status = 'FULLY_PAID';
      else if (inv.due_date && new Date(inv.due_date).getTime() < now) status = 'OVERDUE';
      else if (amountPaid > 0) status = 'PARTIALLY_PAID';
      else status = 'CREDIT';

      rows.push({
        ...inv, customer_name: c.name, marketer_id: c.marketer_id, marketer_name: marketer?.name ?? c.marketer_id,
        credit_limit: c.credit_limit, amount_paid: amountPaid, recovery_status: status,
      });
    }
  }
  return rows.sort((a, b) => b.created_at.localeCompare(a.created_at));
}

/** Same FIFO cash-application-by-invoice-age algorithm as finance.agingReport,
 *  over marketer_customers/marketer_customer_ledger instead of suppliers/ledger. */
export async function agingReport() {
  const customers = await db.prepare(
    `SELECT DISTINCT mc.id, mc.name FROM marketer_customers mc JOIN marketer_customer_ledger l ON l.customer_id = mc.id`,
  ).all() as { id: string; name: string }[];
  const now = Date.now();
  const DAY = 24 * 60 * 60 * 1000;

  const rows: { customerId: string; customerName: string; current: number; d31to60: number; d61to90: number; d90plus: number; total: number }[] = [];
  for (const c of customers) {
    const invoices = (await db.prepare(
      `SELECT entry_date, debit AS amount FROM marketer_customer_ledger WHERE customer_id = ? AND debit > 0 ORDER BY entry_date, id`,
    ).all(c.id) as { entry_date: string; amount: number }[]).map(inv => ({ ...inv, remaining: inv.amount }));
    const payments = await db.prepare(
      `SELECT credit AS amount FROM marketer_customer_ledger WHERE customer_id = ? AND credit > 0 ORDER BY entry_date, id`,
    ).all(c.id) as { amount: number }[];

    for (const payment of payments) {
      let remainingPayment = payment.amount;
      for (const inv of invoices) {
        if (remainingPayment <= 0) break;
        const applied = Math.min(inv.remaining, remainingPayment);
        inv.remaining -= applied;
        remainingPayment -= applied;
      }
    }

    const buckets = { current: 0, d31to60: 0, d61to90: 0, d90plus: 0 };
    for (const inv of invoices) {
      if (inv.remaining <= 0) continue;
      const ageDays = (now - new Date(inv.entry_date).getTime()) / DAY;
      if (ageDays <= 30) buckets.current += inv.remaining;
      else if (ageDays <= 60) buckets.d31to60 += inv.remaining;
      else if (ageDays <= 90) buckets.d61to90 += inv.remaining;
      else buckets.d90plus += inv.remaining;
    }

    const total = buckets.current + buckets.d31to60 + buckets.d61to90 + buckets.d90plus;
    if (total > 0) rows.push({ customerId: c.id, customerName: c.name, ...buckets, total });
  }
  return rows;
}

// SQLite's datetime('now', '-N days') has no Postgres equivalent — computed
// here instead, in the same 'YYYY-MM-DD HH:MM:SS' UTC text shape schema.ts's
// created_at DEFAULT already uses, so it stays a plain lexicographic text
// comparison against the column.
function isoCutoff(days: number): string {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString().slice(0, 19).replace('T', ' ');
}

/** Behaviorally quiet, not administratively deactivated: ACTIVE, existed for
 *  at least `days`, and no sale within that window (or ever). Distinct from
 *  inactiveCustomers() below, which is the deliberate status flag. */
export async function dormantCustomers(days = 60): Promise<(MarketerCustomer & { last_sale_at: string | null })[]> {
  const cutoff = isoCutoff(days);
  return await db.prepare(`
    SELECT mc.*, (SELECT MAX(created_at) FROM marketer_customer_sales WHERE customer_id = mc.id) AS last_sale_at
    FROM marketer_customers mc
    WHERE mc.status = 'ACTIVE'
      AND mc.created_at < ?
      AND (
        (SELECT MAX(created_at) FROM marketer_customer_sales WHERE customer_id = mc.id) IS NULL
        OR (SELECT MAX(created_at) FROM marketer_customer_sales WHERE customer_id = mc.id) < ?
      )
    ORDER BY mc.name
  `).all(cutoff, cutoff) as unknown as (MarketerCustomer & { last_sale_at: string | null })[];
}

export async function inactiveCustomers(): Promise<MarketerCustomer[]> {
  return await db.prepare(`SELECT * FROM marketer_customers WHERE status = 'INACTIVE' ORDER BY name`).all() as unknown as MarketerCustomer[];
}

export async function creditCustomers(): Promise<MarketerCustomer[]> {
  return await db.prepare(`SELECT * FROM marketer_customers WHERE credit_limit > 0 ORDER BY name`).all() as unknown as MarketerCustomer[];
}

export async function cashCustomers(): Promise<MarketerCustomer[]> {
  return await db.prepare(`SELECT * FROM marketer_customers WHERE credit_limit <= 0 ORDER BY name`).all() as unknown as MarketerCustomer[];
}
