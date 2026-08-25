import { db } from '../db/client.js';
import { nextBusinessId } from '../db/ids.js';
import * as activityLog from './activityLog.js';
import * as inventory from './inventory.js';
import * as finance from './finance.js';
import * as reversals from './reversals.js';
import * as retailStock from './retailStock.js';

export type CustomerType = 'RETAIL' | 'MARKETER' | 'DISTRIBUTOR';
export type PaymentTerms = 'CASH' | 'ADVANCE' | 'CREDIT';

/** How long since a Retail customer's last purchase before they're flagged for follow-up. */
const RETAIL_FOLLOW_UP_DAYS = 30;

export interface Customer { id: string; name: string; location: string | null; phone: string | null; customer_type: CustomerType }
export interface SalesOrder {
  id: string; customer_id: string | null; channel: 'INVOICE' | 'POS'; rep: string | null;
  status: string; payment_terms: PaymentTerms; approved_by: string | null; approved_at: string | null;
  total_amount: number; created_at: string; branch_id: string | null; manual_invoice_number: string | null;
}
export interface SalesItem { id: number; sales_id: string; item_id: string; quantity: number; unit_price: number; line_total: number }
export interface SalesPayment { id: number; sales_id: string; method: PosPaymentMethod; amount: number }

export async function listCustomers(): Promise<Customer[]> {
  return await db.prepare('SELECT * FROM customers ORDER BY name').all() as unknown as Customer[];
}
export async function getCustomer(id: string): Promise<Customer | undefined> {
  return await db.prepare('SELECT * FROM customers WHERE id = ?').get(id) as Customer | undefined;
}
export async function createCustomer(c: Customer): Promise<void> {
  await db.prepare('INSERT INTO customers (id, name, location, phone, customer_type) VALUES (?,?,?,?,?)').run(c.id, c.name, c.location, c.phone, c.customer_type);
}

/** One row per customer with any Retail (POS) purchase history, live-aggregated —
 *  drives the Retail "Customers" tab and its follow-up flag. needs_follow_up mirrors
 *  the same threshold routes/pendingCounts.ts uses for the sidebar badge.
 *  Only PAID sales count — a CANCELLED retail sale (a reversed/voided
 *  transaction) shouldn't reset a customer's follow-up clock or inflate spend. */
export interface RetailCustomerActivity {
  id: string; name: string; location: string | null; phone: string | null;
  purchase_count: number; total_spent: number; last_purchase_at: string; needs_follow_up: 0 | 1;
}
export async function retailCustomerActivity(): Promise<RetailCustomerActivity[]> {
  return await db.prepare(`
    SELECT c.id, c.name, c.location, c.phone,
      COUNT(s.id) AS purchase_count, COALESCE(SUM(s.total_amount), 0) AS total_spent,
      MAX(s.created_at) AS last_purchase_at,
      CASE WHEN EXTRACT(EPOCH FROM (now() - MAX(s.created_at)::timestamp)) / 86400 > ? THEN 1 ELSE 0 END AS needs_follow_up
    FROM customers c
    JOIN sales s ON s.customer_id = c.id AND s.channel = 'POS' AND s.status = 'PAID'
    GROUP BY c.id
    ORDER BY last_purchase_at DESC
  `).all(RETAIL_FOLLOW_UP_DAYS) as unknown as RetailCustomerActivity[];
}

/** Three customer categories, three different workflows:
 *  - RETAIL (POS channel): always cash, and posts immediately — select
 *    product, sell, receive payment, stock and the ledger update in the same
 *    call, no approval step (Section 9: "Retail sales should support
 *    immediate transaction posting"). Every Retail (POS) sale must still
 *    carry a real customerId (Module 20) — createOrder rejects a POS sale
 *    with none, so purchase history/follow-up can actually be tracked.
 *  - MARKETER: sells on credit exactly like today's INVOICE flow, no gate.
 *  - DISTRIBUTOR on CREDIT terms: requires approval before anything posts to
 *    inventory or the ledger (see approveCreditSale/rejectCreditSale below) —
 *    a Distributor paying CASH or in ADVANCE settles immediately instead,
 *    same as Retail. */
export type PosPaymentMethod = 'Cash' | 'Transfer' | 'POS Terminal';

export async function createOrder(params: {
  customerId?: string; channel: 'INVOICE' | 'POS'; rep: string; paymentTerms?: PaymentTerms;
  items: { itemId: string; quantity: number; unitPrice: number }[]; actor?: string;
  branchId?: string; manualInvoiceNumber?: string; payments?: { method: PosPaymentMethod; amount: number }[];
}): Promise<SalesOrder> {
  // Every Retail sale needs a real customer record now — the one hard rule
  // the spec states outright rather than leaving to caller discretion.
  if (params.channel === 'POS' && !params.customerId) {
    throw new Error('A customer is required for every retail sale');
  }
  const customerType: CustomerType = params.customerId ? ((await getCustomer(params.customerId))?.customer_type ?? 'RETAIL') : 'RETAIL';
  // Retail POS is always cash, regardless of what's sent — the one hard rule
  // the spec states outright rather than leaving to caller discretion.
  const paymentTerms: PaymentTerms = params.channel === 'POS' ? 'CASH' : (params.paymentTerms ?? 'CREDIT');
  const requiresApproval = customerType === 'DISTRIBUTOR' && paymentTerms === 'CREDIT';
  const settledImmediately = paymentTerms === 'CASH' || paymentTerms === 'ADVANCE';

  if (params.branchId) {
    const branch = await db.prepare('SELECT company_id FROM distributor_branches WHERE id = ?').get(params.branchId) as { company_id: string } | undefined;
    if (!branch) throw new Error(`Unknown branch ${params.branchId}`);
    if (branch.company_id !== params.customerId) throw new Error(`${params.branchId} does not belong to ${params.customerId}`);
  }

  // POS sells out of Retail's own bounded stock (already transferred in from
  // the central warehouse at intake time — see services/retailStock.ts), not
  // the shared central ledger, so the constraint here is what Retail itself
  // is holding.
  if (params.channel === 'POS') {
    for (const it of params.items) {
      const onHand = await retailStock.getBalance(it.itemId);
      if (it.quantity > onHand) throw new Error(`Only ${onHand} of ${it.itemId} available in Retail stock — post an intake from the warehouse first`);
    }
  }

  const id = await nextBusinessId('sales', 'SO-2026-', 5);
  const total = params.items.reduce((sum, it) => sum + it.quantity * it.unitPrice, 0);
  const actor = params.actor ?? params.rep;
  const status = requiresApproval ? 'AWAITING_APPROVAL' : settledImmediately ? 'PAID' : 'PENDING';

  // Split payment (Module 13) — optional, POS-only in practice: one or more
  // named methods (no duplicates) that must sum to exactly the order total.
  // Omitted, behavior is unchanged from before this module.
  if (params.payments) {
    const validMethods: PosPaymentMethod[] = ['Cash', 'Transfer', 'POS Terminal'];
    if (params.payments.length === 0) throw new Error('payments must have at least one line if provided');
    const seen = new Set<string>();
    let sum = 0;
    for (const p of params.payments) {
      if (!validMethods.includes(p.method)) throw new Error(`Invalid payment method "${p.method}"`);
      if (seen.has(p.method)) throw new Error(`Duplicate payment method "${p.method}"`);
      seen.add(p.method);
      if (p.amount <= 0) throw new Error(`${p.method}: amount must be positive`);
      sum += p.amount;
    }
    if (Math.abs(sum - total) > 0.01) {
      throw new Error(`Payment lines total ₦${sum.toLocaleString('en-NG')} does not match the order total ₦${total.toLocaleString('en-NG')}`);
    }
  }

  await db.prepare('INSERT INTO sales (id, customer_id, channel, rep, status, payment_terms, total_amount, branch_id, manual_invoice_number) VALUES (?,?,?,?,?,?,?,?,?)')
    .run(id, params.customerId ?? null, params.channel, params.rep, status, paymentTerms, total, params.branchId ?? null, params.manualInvoiceNumber ?? null);

  const insertItem = db.prepare('INSERT INTO sales_items (sales_id, item_id, quantity, unit_price, line_total) VALUES (?,?,?,?,?)');
  for (const it of params.items) await insertItem.run(id, it.itemId, it.quantity, it.unitPrice, it.quantity * it.unitPrice);

  // Payment lines (Module 13) — kept as an audit trail of exactly what the
  // cashier collected regardless of channel, even though POS's own receipt
  // below is what actually settles the ledger.
  if (params.payments) {
    const insertPayment = db.prepare('INSERT INTO sales_payments (sales_id, method, amount) VALUES (?,?,?)');
    for (const p of params.payments) await insertPayment.run(id, p.method, p.amount);
  }

  if (requiresApproval) {
    // Deferred: what was ordered is recorded (sales_items above), but nothing
    // touches inventory_transactions or the ledger until approveCreditSale —
    // otherwise stock would be committed to an order that might get rejected.
    await activityLog.record(actor, 'created', 'sales', id, `Sales order ${id} awaiting credit approval — ₦${total.toLocaleString('en-NG')}`);
    return (await getOrder(id))!;
  }

  // POS sells straight out of Retail's own bounded stock (see
  // services/retailStock.ts); every other channel posts against the central
  // Finished Goods Warehouse ledger.
  for (const it of params.items) {
    if (params.channel === 'POS') {
      await retailStock.postSale({ itemId: it.itemId, quantity: it.quantity, unitCost: it.unitPrice, salesId: id, actor });
    } else {
      await inventory.postTransaction({
        itemId: it.itemId, direction: 'OUT', quantity: it.quantity, unitCost: it.unitPrice,
        sourceType: 'SALES', sourceId: id, actor,
        fromLocation: 'Finished Goods Warehouse', toLocation: 'Customer',
        note: `Sold on ${id}`,
      });
    }
  }
  await finance.postLedger({ account: 'Accounts receivable', debit: total, credit: 0, referenceType: 'sales', referenceId: id, description: `Sales order ${id}`, actor, customerId: params.customerId, branchId: params.branchId });
  await finance.postLedger({ account: 'Sales revenue', debit: 0, credit: total, referenceType: 'sales', referenceId: id, description: `Sales order ${id}`, actor });
  if (settledImmediately) {
    if (params.payments) {
      for (const p of params.payments) {
        await finance.recordReceipt({
          receivedFrom: params.customerId ?? 'Walk-in customer', amount: p.amount, method: p.method,
          referenceType: 'sales', referenceId: id, actor,
        });
      }
    } else {
      await finance.recordReceipt({
        receivedFrom: params.customerId ?? 'Walk-in customer', amount: total,
        method: params.channel === 'POS' ? 'Cash' : paymentTerms === 'ADVANCE' ? 'Advance payment' : 'Cash',
        referenceType: 'sales', referenceId: id, actor,
      });
    }
  }
  await activityLog.record(actor, 'created', 'sales', id, `Sales order ${id} (${params.channel}) — ₦${total.toLocaleString('en-NG')}`);
  return (await getOrder(id))!;
}

/** Posts the inventory/ledger effect createOrder deferred for an
 *  AWAITING_APPROVAL Distributor credit order, then hands it back into the
 *  normal PENDING lifecycle — mirrors receiving.inspectGoodsReceived's
 *  transaction shape. Retail (POS) never reaches AWAITING_APPROVAL (Section
 *  9: posts immediately), so this is Distributor-credit-only. */
export async function approveCreditSale(salesId: string, actor = 'System Administrator'): Promise<SalesOrder> {
  const order = await getOrder(salesId);
  if (!order) throw new Error(`Unknown sales order ${salesId}`);
  if (order.status !== 'AWAITING_APPROVAL') throw new Error(`${salesId} is not awaiting approval (status ${order.status})`);

  await db.transaction(async () => {
    for (const it of await listItemsFor(salesId)) {
      await inventory.postTransaction({
        itemId: it.item_id, direction: 'OUT', quantity: it.quantity, unitCost: it.unit_price,
        sourceType: 'SALES', sourceId: salesId, actor,
        fromLocation: 'Finished Goods Warehouse', toLocation: 'Customer',
        note: `Sold on ${salesId} (credit approved)`,
      });
    }
    await finance.postLedger({ account: 'Accounts receivable', debit: order.total_amount, credit: 0, referenceType: 'sales', referenceId: salesId, description: `Sales order ${salesId}`, actor, customerId: order.customer_id ?? undefined, branchId: order.branch_id ?? undefined });
    await finance.postLedger({ account: 'Sales revenue', debit: 0, credit: order.total_amount, referenceType: 'sales', referenceId: salesId, description: `Sales order ${salesId}`, actor });
    await db.prepare(`UPDATE sales SET status='PENDING', approved_by=?, approved_at=now() WHERE id=?`).run(actor, salesId);
    await activityLog.record(actor, 'approved credit for', 'sales', salesId, `Sales order ${salesId} credit approved — ₦${order.total_amount.toLocaleString('en-NG')}`);
  });
  return (await getOrder(salesId))!;
}

/** Nothing was ever posted for an AWAITING_APPROVAL order, so rejecting it is
 *  just a status change — there's nothing to reverse. */
export async function rejectCreditSale(salesId: string, actor = 'System Administrator'): Promise<SalesOrder> {
  const order = await getOrder(salesId);
  if (!order) throw new Error(`Unknown sales order ${salesId}`);
  if (order.status !== 'AWAITING_APPROVAL') throw new Error(`${salesId} is not awaiting approval (status ${order.status})`);
  await db.prepare(`UPDATE sales SET status='CANCELLED', approved_by=?, approved_at=now() WHERE id=?`).run(actor, salesId);
  await activityLog.record(actor, 'rejected credit for', 'sales', salesId, `Sales order ${salesId} credit rejected`);
  return (await getOrder(salesId))!;
}

/** Module 17 reversal: undoes the inventory OUT and AR/Revenue ledger lines
 *  createOrder (or approveCreditSale) posted — status is never mutated (see
 *  reversals.ts). AWAITING_APPROVAL orders never posted anything in the first
 *  place; rejectCreditSale is the correct "undo" for those, not this. */
export async function reverseOrder(salesId: string, params: { reason: string; actor: string }): Promise<{ reversal: reversals.Reversal; order: SalesOrder }> {
  const order = await getOrder(salesId);
  if (!order) throw new Error(`Unknown sales order ${salesId}`);
  if (order.status === 'AWAITING_APPROVAL') throw new Error(`${salesId} hasn't posted yet — reject it instead of reversing it`);
  await reversals.assertNotReversed('sales', salesId);

  return await db.transaction(async () => {
    for (const it of await listItemsFor(salesId)) {
      if (order.channel === 'POS') {
        await retailStock.reverseSale({ itemId: it.item_id, quantity: it.quantity, unitCost: it.unit_price, salesId, actor: params.actor });
      } else {
        await inventory.postTransaction({
          itemId: it.item_id, direction: 'IN', quantity: it.quantity, unitCost: it.unit_price,
          sourceType: 'SALES', sourceId: salesId, actor: params.actor,
          fromLocation: 'Customer', toLocation: 'Finished Goods Warehouse',
          note: `Reversal of ${salesId}`,
        });
      }
    }
    await finance.postLedger({ account: 'Accounts receivable', debit: 0, credit: order.total_amount, referenceType: 'sales_reversal', referenceId: salesId, description: `Reversal of sales order ${salesId}`, actor: params.actor, customerId: order.customer_id ?? undefined, branchId: order.branch_id ?? undefined });
    await finance.postLedger({ account: 'Sales revenue', debit: order.total_amount, credit: 0, referenceType: 'sales_reversal', referenceId: salesId, description: `Reversal of sales order ${salesId}`, actor: params.actor });

    const reversal = await reversals.create({
      entityType: 'sales', entityId: salesId, reversedBy: params.actor, reason: params.reason,
      oldValue: JSON.stringify({ total_amount: order.total_amount }), newValue: JSON.stringify({ total_amount: 0 }),
    });
    await activityLog.record(
      params.actor, 'reversed', 'sales', salesId,
      `Sales order ${salesId} (₦${order.total_amount.toLocaleString('en-NG')}) reversed`,
      { oldValue: reversal.old_value, newValue: reversal.new_value, reason: reversal.reason },
    );
    return { reversal, order: (await getOrder(salesId))! };
  });
}

export async function pendingCreditApproval() {
  return await db.prepare(`
    SELECT s.*, COALESCE(c.name, 'Walk-in customer') AS customer_name, c.location AS customer_location
    FROM sales s LEFT JOIN customers c ON c.id = s.customer_id
    WHERE s.status = 'AWAITING_APPROVAL'
    ORDER BY s.id DESC
  `).all();
}

/** The only writer of sales.status besides createOrder/approveCreditSale — Fleet & delivery calls this. */
export async function setStatus(id: string, status: string, actor = 'System Administrator'): Promise<void> {
  await db.prepare('UPDATE sales SET status = ? WHERE id = ?').run(status, id);
  await activityLog.record(actor, 'updated status of', 'sales', id, `Sales order ${id} → ${status}`);
}

export async function getOrder(id: string): Promise<SalesOrder | undefined> {
  return await db.prepare('SELECT * FROM sales WHERE id = ?').get(id) as SalesOrder | undefined;
}

export async function listItemsFor(salesId: string): Promise<SalesItem[]> {
  return await db.prepare('SELECT * FROM sales_items WHERE sales_id = ?').all(salesId) as unknown as SalesItem[];
}

export async function listPaymentsFor(salesId: string): Promise<SalesPayment[]> {
  return await db.prepare('SELECT * FROM sales_payments WHERE sales_id = ?').all(salesId) as unknown as SalesPayment[];
}

export async function listOrders(channel?: 'INVOICE' | 'POS') {
  // LEFT JOIN: a Retail walk-in sale has no customer_id — an INNER JOIN would
  // silently drop it from every listing.
  const base = `SELECT s.*, COALESCE(c.name, 'Walk-in customer') AS customer_name, c.location AS customer_location, c.customer_type
    FROM sales s LEFT JOIN customers c ON c.id = s.customer_id`;
  if (channel) return await db.prepare(`${base} WHERE s.channel = ? ORDER BY s.id DESC`).all(channel);
  return await db.prepare(`${base} ORDER BY s.id DESC`).all();
}
