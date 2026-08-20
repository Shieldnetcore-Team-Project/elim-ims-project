import { db } from '../db/client.js';
import { nextBusinessId } from '../db/ids.js';
import * as activityLog from './activityLog.js';
import * as inventory from './inventory.js';
import * as finance from './finance.js';
import * as sales from './sales.js';
import * as accessControl from './accessControl.js';

const WAREHOUSE_MANAGER_ROLE = 'Warehouse Manager';

export interface MarketerStockBalance { item_id: string; item_name: string; on_hand: number; unit_price: number }
export interface DailyStatement {
  date: string; expectedAmount: number; returnedGoods: number;
  cashReceived: number; creditGiven: number; outstandingBalance: number;
}
export interface MarketerReturn {
  id: string; marketer_id: string; marketer_name: string; status: string;
  created_by: string | null; created_at: string; verified_by: string | null; verified_at: string | null;
}
export interface MarketerReturnItem {
  item_id: string; item_name: string; quantity: number; unit_price: number; verified_quantity: number | null;
}
export interface PendingVerification { item_id: string; item_name: string; pending_quantity: number }
export interface PendingAssignment { item_id: string; item_name: string; assigned_quantity: number }
export interface StockAssignment {
  id: string; marketer_id: string; issued_by: string | null; status: string;
  verified_by: string | null; verified_at: string | null; issued_at: string;
}

export function assertMarketer(marketerId: string) {
  const customer = sales.getCustomer(marketerId);
  if (!customer) throw new Error(`Unknown customer ${marketerId}`);
  if (customer.customer_type !== 'MARKETER') throw new Error(`${marketerId} is not a Marketer (${customer.customer_type})`);
  return customer;
}

/** Current balance for one item — SUM(IN) - SUM(OUT), same derivation as
 *  inventory.getBalance, just scoped to this marketer's mobile inventory. */
export function getBalance(marketerId: string, itemId: string): number {
  const row = db.prepare(
    `SELECT COALESCE(SUM(CASE WHEN direction='IN' THEN quantity ELSE -quantity END), 0) AS q
     FROM marketer_stock_transactions WHERE marketer_id = ? AND item_id = ?`,
  ).get(marketerId, itemId) as { q: number };
  return row.q;
}

export function listBalances(marketerId: string): MarketerStockBalance[] {
  return db.prepare(`
    SELECT i.id AS item_id, i.name AS item_name,
      COALESCE(SUM(CASE WHEN mst.direction='IN' THEN mst.quantity ELSE -mst.quantity END), 0) AS on_hand,
      (SELECT unit_price FROM marketer_stock_transactions WHERE marketer_id = ? AND item_id = i.id ORDER BY id DESC LIMIT 1) AS unit_price
    FROM marketer_stock_transactions mst JOIN items i ON i.id = mst.item_id
    WHERE mst.marketer_id = ?
    GROUP BY i.id, i.name
    HAVING on_hand > 0
    ORDER BY i.name
  `).all(marketerId, marketerId) as unknown as MarketerStockBalance[];
}

/** A return/sale is valued at whatever this marketer was last issued that
 *  item for — this app has no per-lot/FIFO cost tracking anywhere, so this
 *  is the simplest convention consistent with that. */
function latestIssuePrice(marketerId: string, itemId: string): number {
  const row = db.prepare(
    `SELECT unit_price FROM marketer_stock_transactions WHERE marketer_id = ? AND item_id = ? AND source_type = 'ISSUE' ORDER BY id DESC LIMIT 1`,
  ).get(marketerId, itemId) as { unit_price: number } | undefined;
  return row?.unit_price ?? 0;
}

/** Claimed-but-unverified return quantity for one marketer, grouped by item —
 *  this is the sole source of truth both issueStock's block and the client's
 *  pre-flight banner read from, so the two can never disagree. */
export function pendingVerification(marketerId: string): PendingVerification[] {
  return db.prepare(`
    SELECT mri.item_id AS item_id, i.name AS item_name, SUM(mri.quantity) AS pending_quantity
    FROM marketer_return_items mri
    JOIN marketer_returns mr ON mr.id = mri.return_id
    JOIN items i ON i.id = mri.item_id
    WHERE mr.marketer_id = ? AND mr.status = 'PENDING_VERIFICATION'
    GROUP BY mri.item_id, i.name
    HAVING pending_quantity > 0
  `).all(marketerId) as unknown as PendingVerification[];
}

/** Assigned-but-not-yet-verified quantity for one marketer, grouped by item —
 *  what Section 12 means by "Jerry sees: Assigned: 200": physically posted
 *  out of the warehouse (see issueStock), but not yet in the marketer's own
 *  held balance (marketer_stock_transactions) until verifyAssignment runs. */
export function pendingAssignments(marketerId: string): PendingAssignment[] {
  return db.prepare(`
    SELECT msii.item_id AS item_id, i.name AS item_name, SUM(msii.quantity) AS assigned_quantity
    FROM marketer_stock_issue_items msii
    JOIN marketer_stock_issues msi ON msi.id = msii.issue_id
    JOIN items i ON i.id = msii.item_id
    WHERE msi.marketer_id = ? AND msi.status = 'ASSIGNED'
    GROUP BY msii.item_id, i.name
    HAVING assigned_quantity > 0
  `).all(marketerId) as unknown as PendingAssignment[];
}

export function listAssignments(marketerId?: string): (StockAssignment & { marketer_name: string })[] {
  const base = `
    SELECT msi.*, c.name AS marketer_name
    FROM marketer_stock_issues msi JOIN customers c ON c.id = msi.marketer_id
  `;
  if (marketerId) return db.prepare(`${base} WHERE msi.marketer_id = ? ORDER BY msi.id DESC`).all(marketerId) as unknown as (StockAssignment & { marketer_name: string })[];
  return db.prepare(`${base} ORDER BY msi.id DESC`).all() as unknown as (StockAssignment & { marketer_name: string })[];
}

export function getAssignment(id: string): StockAssignment | undefined {
  return db.prepare('SELECT * FROM marketer_stock_issues WHERE id = ?').get(id) as StockAssignment | undefined;
}

export function listAssignmentItems(issueId: string): { item_id: string; item_name: string; quantity: number; unit_price: number }[] {
  return db.prepare(`
    SELECT msii.item_id, i.name AS item_name, msii.quantity, msii.unit_price
    FROM marketer_stock_issue_items msii JOIN items i ON i.id = msii.item_id
    WHERE msii.issue_id = ?
  `).all(issueId) as unknown as { item_id: string; item_name: string; quantity: number; unit_price: number }[];
}

/** Warehouse -> marketer transfer, step one of two (Section 12: Warehouse/Stock
 *  -> Stock Assignment -> Marketer Verification -> Marketer Holds Stock). Not a
 *  sale — nothing posts to the ledger here, and the physical inventory move
 *  (out of the warehouse) happens now, but the marketer's own held balance
 *  (marketer_stock_transactions) does NOT update until they verify receipt —
 *  see verifyAssignment. Only finished goods make sense to hand a marketer.
 *  Blocked while the marketer has any unverified return outstanding for an
 *  item being issued — a Warehouse Manager (a real users.role, looked up
 *  server-side, not a trusted free-text field) can override. */
export function issueStock(params: {
  marketerId: string; items: { itemId: string; quantity: number; unitPrice?: number }[]; issuedBy: string; actor?: string; overrideUserId?: string;
}): { id: string } {
  assertMarketer(params.marketerId);
  const actor = params.actor ?? params.issuedBy;
  const itemRows = new Map(params.items.map(it => [it.itemId, inventory.getItem(it.itemId)]));
  for (const it of params.items) {
    const item = itemRows.get(it.itemId);
    if (!item) throw new Error(`Unknown item ${it.itemId}`);
    if (item.type !== 'FINISHED_GOOD') throw new Error(`${it.itemId} (${item.name}) is not a finished good — only finished goods can be issued to a marketer`);
    if (it.quantity <= 0) throw new Error(`${it.itemId}: quantity must be positive`);
  }

  const pending = new Map(pendingVerification(params.marketerId).map(p => [p.item_id, p]));
  const blocked = params.items
    .map(it => {
      const p = pending.get(it.itemId);
      if (!p || p.pending_quantity <= 0) return null;
      return { itemName: itemRows.get(it.itemId)!.name, pendingQty: p.pending_quantity, maxIssuable: Math.max(0, it.quantity - p.pending_quantity) };
    })
    .filter((b): b is { itemName: string; pendingQty: number; maxIssuable: number } => b !== null);

  let overrideBy: { id: string; name: string } | null = null;
  if (blocked.length > 0) {
    if (!params.overrideUserId) {
      throw new Error(blocked.map(b => `${b.pendingQty} ${b.itemName} still pending warehouse verification — maximum issuable today is ${b.maxIssuable}.`).join(' '));
    }
    const overrideUser = accessControl.getUser(params.overrideUserId);
    if (!overrideUser || overrideUser.role !== WAREHOUSE_MANAGER_ROLE) {
      throw new Error(`Only a ${WAREHOUSE_MANAGER_ROLE} can override a pending-verification block`);
    }
    overrideBy = overrideUser;
  }

  const id = nextBusinessId('marketer_stock_issues', 'MSI-', 4);
  db.exec('BEGIN');
  try {
    db.prepare(`INSERT INTO marketer_stock_issues (id, marketer_id, issued_by, status) VALUES (?,?,?,'ASSIGNED')`).run(id, params.marketerId, params.issuedBy);
    const insertItem = db.prepare('INSERT INTO marketer_stock_issue_items (issue_id, item_id, quantity, unit_price) VALUES (?,?,?,?)');
    for (const it of params.items) {
      const unitPrice = it.unitPrice ?? itemRows.get(it.itemId)!.unit_cost;
      insertItem.run(id, it.itemId, it.quantity, unitPrice);
      // Physically leaves the Finished Goods Warehouse now — that part is a
      // fact, regardless of when (or whether) the marketer gets around to
      // confirming it. Their own held balance (marketer_stock_transactions)
      // is deliberately NOT posted here — see verifyAssignment.
      inventory.postTransaction({
        itemId: it.itemId, direction: 'OUT', quantity: it.quantity, unitCost: unitPrice,
        sourceType: 'MATERIAL_ISSUE', sourceId: id, actor,
        fromLocation: 'Finished Goods Warehouse', toLocation: 'Marketer Field Stock',
        note: `Issued to marketer ${params.marketerId} on ${id}`,
      });
    }
    activityLog.record(actor, 'assigned stock to', 'marketer', params.marketerId, `${id}: ${params.items.length} line(s) assigned, awaiting the marketer's confirmation`);
    if (overrideBy) {
      activityLog.record(overrideBy.name, 'overrode pending-verification block for', 'marketer', params.marketerId,
        `${id}: ${blocked.map(b => `${b.itemName} (${b.pendingQty} pending)`).join(', ')}`);
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  return { id };
}

/** Step two: the marketer's own confirmation of what was posted to them —
 *  "the purpose of verification is confirmation and reconciliation, not
 *  unnecessary managerial approval," so this needs no role/override check,
 *  unlike issueStock's Warehouse Manager gate above. Only now does the
 *  assignment become the marketer's held stock (marketer_stock_transactions),
 *  matching Section 12's Posted By / Verified By / Date / Time / Quantity /
 *  Product / Reference record — all already on marketer_stock_issues(_items). */
export function verifyAssignment(issueId: string, params: { verifiedBy: string; actor?: string }): StockAssignment {
  const assignment = getAssignment(issueId);
  if (!assignment) throw new Error(`Unknown stock assignment ${issueId}`);
  if (assignment.status !== 'ASSIGNED') throw new Error(`${issueId} is already ${assignment.status}`);
  const actor = params.actor ?? params.verifiedBy;
  const items = listAssignmentItems(issueId);

  db.exec('BEGIN');
  try {
    const insertTxn = db.prepare('INSERT INTO marketer_stock_transactions (marketer_id, item_id, direction, quantity, unit_price, source_type, source_id, actor) VALUES (?,?,?,?,?,?,?,?)');
    for (const it of items) {
      insertTxn.run(assignment.marketer_id, it.item_id, 'IN', it.quantity, it.unit_price, 'ISSUE', issueId, actor);
    }
    db.prepare(`UPDATE marketer_stock_issues SET status = 'VERIFIED', verified_by = ?, verified_at = datetime('now') WHERE id = ?`).run(params.verifiedBy, issueId);
    activityLog.record(actor, 'verified stock receipt for', 'marketer', assignment.marketer_id,
      `${issueId}: ${items.length} line(s) confirmed received by ${params.verifiedBy}`);
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  return getAssignment(issueId)!;
}

/** The marketer's claim that goods are coming back. Immediately shrinks
 *  their mobile-inventory balance (they no longer have it — that alone is
 *  "automatically reduce expected sales amount", since expected amount is
 *  never stored, only ever read live off this ledger) but does **not** post
 *  to warehouse inventory yet, and no ledger/AR posting either (nothing was
 *  ever invoiced for unsold stock). The return sits PENDING_VERIFICATION
 *  until verifyReturn confirms what physically arrived — see Module 5:
 *  "sometimes goods never physically arrive." */
export function recordReturn(params: { marketerId: string; items: { itemId: string; quantity: number }[]; actor: string }): { id: string } {
  assertMarketer(params.marketerId);
  for (const it of params.items) {
    const balance = getBalance(params.marketerId, it.itemId);
    if (it.quantity <= 0 || it.quantity > balance) {
      throw new Error(`${it.itemId}: cannot return ${it.quantity} — marketer only holds ${balance}`);
    }
  }

  const id = nextBusinessId('marketer_returns', 'MRT-', 4);
  db.exec('BEGIN');
  try {
    db.prepare('INSERT INTO marketer_returns (id, marketer_id, created_by) VALUES (?,?,?)').run(id, params.marketerId, params.actor);
    const insertItem = db.prepare('INSERT INTO marketer_return_items (return_id, item_id, quantity, unit_price) VALUES (?,?,?,?)');
    const insertTxn = db.prepare('INSERT INTO marketer_stock_transactions (marketer_id, item_id, direction, quantity, unit_price, source_type, source_id, actor) VALUES (?,?,?,?,?,?,?,?)');
    for (const it of params.items) {
      const unitPrice = latestIssuePrice(params.marketerId, it.itemId);
      insertItem.run(id, it.itemId, it.quantity, unitPrice);
      insertTxn.run(params.marketerId, it.itemId, 'OUT', it.quantity, unitPrice, 'RETURN', id, params.actor);
    }
    activityLog.record(params.actor, 'reported return from', 'marketer', params.marketerId, `${id}: ${params.items.length} line(s) claimed, pending warehouse verification`);
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  return { id };
}

export function listReturns(): MarketerReturn[] {
  return db.prepare(`
    SELECT mr.id, mr.marketer_id, c.name AS marketer_name, mr.status, mr.created_by, mr.created_at, mr.verified_by, mr.verified_at
    FROM marketer_returns mr JOIN customers c ON c.id = mr.marketer_id
    ORDER BY mr.id DESC
  `).all() as unknown as MarketerReturn[];
}

export function getReturn(id: string): MarketerReturn | undefined {
  return db.prepare(`
    SELECT mr.id, mr.marketer_id, c.name AS marketer_name, mr.status, mr.created_by, mr.created_at, mr.verified_by, mr.verified_at
    FROM marketer_returns mr JOIN customers c ON c.id = mr.marketer_id
    WHERE mr.id = ?
  `).get(id) as MarketerReturn | undefined;
}

export function listReturnItems(returnId: string): MarketerReturnItem[] {
  return db.prepare(`
    SELECT mri.item_id, i.name AS item_name, mri.quantity, mri.unit_price, mri.verified_quantity
    FROM marketer_return_items mri JOIN items i ON i.id = mri.item_id
    WHERE mri.return_id = ?
  `).all(returnId) as unknown as MarketerReturnItem[];
}

/** The Warehouse's action: physically count what came back. The verified
 *  quantity — which can differ from claimed either way, a shortage (less) or
 *  an over-count (more, e.g. extra stock mixed in from another route) — is
 *  what posts to warehouse inventory; only that verified figure is ever
 *  trusted, never the claim. Either direction of mismatch feeds
 *  reconciliation.ts's Short/Excess status. Nothing auto-adjusts the
 *  marketer's own balance (no inventory adjustment by editing records — that
 *  would need a separate, deliberate follow-up). */
export function verifyReturn(returnId: string, params: {
  verifiedBy: string; lines: { itemId: string; verifiedQuantity: number }[]; actor?: string;
}): { id: string } {
  const ret = getReturn(returnId);
  if (!ret) throw new Error(`Unknown return ${returnId}`);
  if (ret.status !== 'PENDING_VERIFICATION') throw new Error(`${returnId} is already ${ret.status}`);
  const claimed = listReturnItems(returnId);
  if (params.lines.length !== claimed.length) throw new Error('Every claimed line must be verified');
  for (const line of params.lines) {
    const claimedLine = claimed.find(c => c.item_id === line.itemId);
    if (!claimedLine) throw new Error(`${line.itemId} is not part of ${returnId}`);
    if (line.verifiedQuantity < 0) {
      throw new Error(`${line.itemId}: verified quantity cannot be negative`);
    }
  }

  const actor = params.actor ?? params.verifiedBy;
  db.exec('BEGIN');
  try {
    const updateItem = db.prepare('UPDATE marketer_return_items SET verified_quantity = ? WHERE return_id = ? AND item_id = ?');
    for (const line of params.lines) {
      const claimedLine = claimed.find(c => c.item_id === line.itemId)!;
      updateItem.run(line.verifiedQuantity, returnId, line.itemId);
      if (line.verifiedQuantity > 0) {
        inventory.postTransaction({
          itemId: line.itemId, direction: 'IN', quantity: line.verifiedQuantity, unitCost: claimedLine.unit_price,
          sourceType: 'SALES', sourceId: returnId, actor,
          fromLocation: 'Marketer Field Stock', toLocation: 'Finished Goods Warehouse',
          note: `Verified return from marketer ${ret.marketer_id} on ${returnId}`,
        });
      }
    }
    db.prepare(`UPDATE marketer_returns SET status = 'VERIFIED', verified_by = ?, verified_at = datetime('now') WHERE id = ?`).run(params.verifiedBy, returnId);

    const totalClaimed = claimed.reduce((s, c) => s + c.quantity, 0);
    const totalVerified = params.lines.reduce((s, l) => s + l.verifiedQuantity, 0);
    const mismatchNote = totalVerified < totalClaimed ? ` — shortage of ${totalClaimed - totalVerified}`
      : totalVerified > totalClaimed ? ` — excess of ${totalVerified - totalClaimed}` : '';
    activityLog.record(actor, 'verified return from', 'marketer', ret.marketer_id, `${returnId}: ${totalVerified}/${totalClaimed} verified${mismatchNote}`);
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  return { id: returnId };
}

export interface FieldSaleResult { totalValue: number; prices: Map<string, number> }

/** The shared guts of "a marketer sold X in the field": validate quantities
 *  against their mobile-inventory balance, price at the last-issued-price
 *  convention, post the stock OUT transactions, and post the company-level
 *  Dr Accounts receivable / Cr Sales revenue (+ an optional receipt for
 *  whatever cash was collected). Used by both recordSale below (unattributed)
 *  and marketerCustomers.recordCustomerSale (attributed to one of a
 *  marketer's own customers, services/marketerCustomers.ts) — it's physically
 *  the same event either way, just reported with different detail, so this
 *  posts exactly once regardless of which caller triggered it. Must be
 *  called inside the caller's own transaction — it opens no transaction of
 *  its own, and inserts no sale-document row (callers own that shape). */
export function postFieldSale(params: {
  marketerId: string; items: { itemId: string; quantity: number }[]; cashReceived: number; actor: string; sourceId: string;
}): FieldSaleResult {
  if (params.cashReceived < 0) throw new Error('cashReceived cannot be negative');

  let totalValue = 0;
  const prices = new Map<string, number>();
  for (const it of params.items) {
    const balance = getBalance(params.marketerId, it.itemId);
    if (it.quantity <= 0 || it.quantity > balance) {
      throw new Error(`${it.itemId}: cannot sell ${it.quantity} — marketer only holds ${balance}`);
    }
    const unitPrice = latestIssuePrice(params.marketerId, it.itemId);
    prices.set(it.itemId, unitPrice);
    totalValue += it.quantity * unitPrice;
  }
  if (params.cashReceived > totalValue) {
    throw new Error(`Cash received (${params.cashReceived}) cannot exceed the value sold (${totalValue})`);
  }

  const insertTxn = db.prepare('INSERT INTO marketer_stock_transactions (marketer_id, item_id, direction, quantity, unit_price, source_type, source_id, actor) VALUES (?,?,?,?,?,?,?,?)');
  for (const it of params.items) {
    insertTxn.run(params.marketerId, it.itemId, 'OUT', it.quantity, prices.get(it.itemId)!, 'SOLD', params.sourceId, params.actor);
  }

  if (totalValue > 0) {
    finance.postLedger({ account: 'Accounts receivable', debit: totalValue, credit: 0, referenceType: 'sales', referenceId: params.sourceId, description: `Marketer sale ${params.sourceId}`, actor: params.actor, customerId: params.marketerId });
    finance.postLedger({ account: 'Sales revenue', debit: 0, credit: totalValue, referenceType: 'sales', referenceId: params.sourceId, description: `Marketer sale ${params.sourceId}`, actor: params.actor });
  }
  if (params.cashReceived > 0) {
    finance.recordReceipt({ receivedFrom: params.marketerId, amount: params.cashReceived, method: 'Cash', referenceType: 'sales', referenceId: params.sourceId, actor: params.actor, customerId: params.marketerId });
  }

  return { totalValue, prices };
}

/** What a marketer reports as actually sold in the field. Removes it from
 *  their mobile balance (no warehouse effect — it's gone for good), and only
 *  now does it become real revenue: Dr Accounts receivable / Cr Sales revenue
 *  for the full value, then whatever cash they hand over reduces that
 *  receivable — the uncovered remainder is exactly "Credit Given", and the
 *  customer's running Accounts receivable balance is exactly "Outstanding
 *  Balance", both read off the same ledger Modules 2-3 already built. */
export function recordSale(params: {
  marketerId: string; items: { itemId: string; quantity: number }[]; cashReceived: number; actor: string;
}): { id: string } {
  assertMarketer(params.marketerId);
  const id = nextBusinessId('marketer_sales', 'MSL-', 4);
  db.exec('BEGIN');
  try {
    db.prepare('INSERT INTO marketer_sales (id, marketer_id, cash_received, created_by) VALUES (?,?,?,?)').run(id, params.marketerId, params.cashReceived, params.actor);
    const { totalValue, prices } = postFieldSale({ marketerId: params.marketerId, items: params.items, cashReceived: params.cashReceived, actor: params.actor, sourceId: id });
    const insertItem = db.prepare('INSERT INTO marketer_sale_items (sale_id, item_id, quantity, unit_price) VALUES (?,?,?,?)');
    for (const it of params.items) {
      insertItem.run(id, it.itemId, it.quantity, prices.get(it.itemId)!);
    }

    activityLog.record(params.actor, 'recorded sale for', 'marketer', params.marketerId, `${id}: ₦${totalValue.toLocaleString('en-NG')} sold, ₦${params.cashReceived.toLocaleString('en-NG')} cash received`);
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  return { id };
}

export function dailyStatement(marketerId: string, date?: string): DailyStatement {
  assertMarketer(marketerId);
  const day = date ?? new Date().toISOString().slice(0, 10);

  const expectedAmount = (db.prepare(
    `SELECT COALESCE(SUM(CASE WHEN direction='IN' THEN quantity * unit_price ELSE -quantity * unit_price END), 0) AS v
     FROM marketer_stock_transactions WHERE marketer_id = ?`,
  ).get(marketerId) as { v: number }).v;

  const returnedGoods = (db.prepare(
    `SELECT COALESCE(SUM(quantity * unit_price), 0) AS v FROM marketer_stock_transactions
     WHERE marketer_id = ? AND source_type = 'RETURN' AND date(created_at) = ?`,
  ).get(marketerId, day) as { v: number }).v;

  const cashReceived = (db.prepare(
    `SELECT COALESCE(SUM(cash_received), 0) AS v FROM marketer_sales WHERE marketer_id = ? AND date(created_at) = ?`,
  ).get(marketerId, day) as { v: number }).v;

  const soldToday = (db.prepare(
    `SELECT COALESCE(SUM(msi.quantity * msi.unit_price), 0) AS v
     FROM marketer_sale_items msi JOIN marketer_sales ms ON ms.id = msi.sale_id
     WHERE ms.marketer_id = ? AND date(ms.created_at) = ?`,
  ).get(marketerId, day) as { v: number }).v;

  const outstandingBalance = finance.customerBalance(marketerId).outstanding;

  return { date: day, expectedAmount, returnedGoods, cashReceived, creditGiven: Math.max(soldToday - cashReceived, 0), outstandingBalance };
}
