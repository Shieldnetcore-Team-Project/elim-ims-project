import { db } from '../db/client.js';
import * as activityLog from './activityLog.js';
import * as sales from './sales.js';

export interface ReturnableItem { id: string; name: string; uom: string }
export interface CustodyBalance {
  expected: number; returned: number; outstanding: number; explainedMissing: number; unexplainedMissing: number;
}
export interface MarketerWiseRow {
  marketer_id: string; marketer_name: string; item_id: string; item_name: string;
  expected: number; returned: number; outstanding: number; explained_missing: number; unexplained_missing: number;
}
export interface CustomerWiseRow { customer_name: string; item_id: string; item_name: string; quantity: number; last_event_at: string }
export interface MovementRow { period: string; returned: number; sold_with_bottle: number }

async function assertMarketer(marketerId: string) {
  const customer = await sales.getCustomer(marketerId);
  if (!customer) throw new Error(`Unknown customer ${marketerId}`);
  if (customer.customer_type !== 'MARKETER') throw new Error(`${marketerId} is not a Marketer (${customer.customer_type})`);
  return customer;
}

async function assertReturnableAsset(itemId: string): Promise<{ id: string; name: string }> {
  const item = await db.prepare('SELECT id, name FROM items WHERE id = ? AND is_returnable_asset = 1').get(itemId) as { id: string; name: string } | undefined;
  if (!item) throw new Error(`${itemId} is not tracked as a returnable asset`);
  return item;
}

export async function listReturnableItems(): Promise<ReturnableItem[]> {
  return await db.prepare(`SELECT id, name, uom FROM items WHERE is_returnable_asset = 1 ORDER BY name`).all() as unknown as ReturnableItem[];
}

/** Filled bottles ever issued to this marketer for this item — derived
 *  straight from marketer_stock_transactions (Module 4), not re-recorded
 *  here. Nothing else in this file writes to that table. */
async function expectedIssued(marketerId: string, itemId: string): Promise<number> {
  const row = await db.prepare(
    `SELECT COALESCE(SUM(quantity), 0) AS q FROM marketer_stock_transactions
     WHERE marketer_id = ? AND item_id = ? AND source_type = 'ISSUE' AND direction = 'IN'`,
  ).get(marketerId, itemId) as { q: number };
  return row.q;
}

async function emptiesReturned(marketerId: string, itemId: string): Promise<number> {
  const row = await db.prepare(
    `SELECT COALESCE(SUM(quantity), 0) AS q FROM bottle_custody_events WHERE marketer_id = ? AND item_id = ? AND event_type = 'EMPTY_RETURNED'`,
  ).get(marketerId, itemId) as { q: number };
  return row.q;
}

async function soldWithBottleTotal(marketerId: string, itemId: string): Promise<number> {
  const row = await db.prepare(
    `SELECT COALESCE(SUM(quantity), 0) AS q FROM bottle_custody_events WHERE marketer_id = ? AND item_id = ? AND event_type = 'SOLD_WITH_BOTTLE'`,
  ).get(marketerId, itemId) as { q: number };
  return row.q;
}

export async function custodyBalance(marketerId: string, itemId: string): Promise<CustodyBalance> {
  const expected = await expectedIssued(marketerId, itemId);
  const returned = await emptiesReturned(marketerId, itemId);
  const outstanding = expected - returned;
  const explainedMissing = await soldWithBottleTotal(marketerId, itemId);
  return { expected, returned, outstanding, explainedMissing, unexplainedMissing: Math.max(outstanding - explainedMissing, 0) };
}

/** Reconciles a marketer's outstanding empties in one action: however many
 *  physically came back, plus who kept a bottle because they bought it
 *  outright with no empty to trade — "Missing Empty Bottles" and its
 *  "Sold With Bottle" reason are just custodyBalance() read after this,
 *  never stored as their own fact. */
export async function recordEmptyReturn(params: {
  marketerId: string; itemId: string; quantityReturned: number;
  soldWithBottle: { customerName: string; quantity: number }[]; returnedBy: string; actor?: string;
}): Promise<void> {
  await assertMarketer(params.marketerId);
  const item = await assertReturnableAsset(params.itemId);
  if (params.quantityReturned < 0) throw new Error('quantityReturned cannot be negative');
  for (const line of params.soldWithBottle) {
    if (!line.customerName.trim()) throw new Error('Every sold-with-bottle line needs a customer name');
    if (line.quantity <= 0) throw new Error(`${line.customerName}: quantity must be positive`);
  }

  const explainedTotal = params.quantityReturned + params.soldWithBottle.reduce((s, l) => s + l.quantity, 0);
  const { outstanding } = await custodyBalance(params.marketerId, params.itemId);
  if (explainedTotal > outstanding) {
    throw new Error(`${params.itemId} (${item.name}): cannot account for ${explainedTotal} — only ${outstanding} is currently outstanding for ${params.marketerId}`);
  }

  const actor = params.actor ?? params.returnedBy;
  await db.transaction(async () => {
    if (params.quantityReturned > 0) {
      await db.prepare('INSERT INTO bottle_custody_events (marketer_id, item_id, event_type, quantity, actor) VALUES (?,?,\'EMPTY_RETURNED\',?,?)')
        .run(params.marketerId, params.itemId, params.quantityReturned, actor);
    }
    const insertSold = db.prepare(`INSERT INTO bottle_custody_events (marketer_id, item_id, event_type, quantity, customer_name, actor) VALUES (?,?,'SOLD_WITH_BOTTLE',?,?,?)`);
    for (const line of params.soldWithBottle) {
      await insertSold.run(params.marketerId, params.itemId, line.quantity, line.customerName.trim(), actor);
    }

    const balance = await custodyBalance(params.marketerId, params.itemId);
    await activityLog.record(actor, 'reconciled dispenser bottles for', 'marketer', params.marketerId,
      `${item.name}: ${params.quantityReturned} returned, ${params.soldWithBottle.reduce((s, l) => s + l.quantity, 0)} sold with bottle — outstanding now ${balance.outstanding}`);
  });
}

export async function marketerWiseReport(): Promise<MarketerWiseRow[]> {
  const pairs = await db.prepare(`
    SELECT DISTINCT marketer_id, item_id FROM (
      SELECT marketer_id, item_id FROM marketer_stock_transactions WHERE source_type = 'ISSUE'
      UNION
      SELECT marketer_id, item_id FROM bottle_custody_events
    ) x WHERE item_id IN (SELECT id FROM items WHERE is_returnable_asset = 1)
  `).all() as { marketer_id: string; item_id: string }[];

  const rows: MarketerWiseRow[] = [];
  for (const { marketer_id, item_id } of pairs) {
    const marketer = await sales.getCustomer(marketer_id);
    const item = await db.prepare('SELECT name FROM items WHERE id = ?').get(item_id) as { name: string } | undefined;
    const balance = await custodyBalance(marketer_id, item_id);
    if (balance.expected > 0) {
      rows.push({
        marketer_id, marketer_name: marketer?.name ?? marketer_id, item_id, item_name: item?.name ?? item_id,
        expected: balance.expected, returned: balance.returned, outstanding: balance.outstanding,
        explained_missing: balance.explainedMissing, unexplained_missing: balance.unexplainedMissing,
      });
    }
  }
  return rows.sort((a, b) => b.outstanding - a.outstanding);
}

export async function customerWiseReport(): Promise<CustomerWiseRow[]> {
  return await db.prepare(`
    SELECT bce.customer_name AS customer_name, bce.item_id AS item_id, i.name AS item_name,
      SUM(bce.quantity) AS quantity, MAX(bce.created_at) AS last_event_at
    FROM bottle_custody_events bce JOIN items i ON i.id = bce.item_id
    WHERE bce.event_type = 'SOLD_WITH_BOTTLE'
    GROUP BY bce.customer_name, bce.item_id, i.name
    ORDER BY quantity DESC
  `).all() as unknown as CustomerWiseRow[];
}

// SQLite's date()/strftime() have no Postgres equivalent — created_at is stored
// as formatted TEXT (see schema.ts), cast to timestamp first, then to_char()
// covers all three buckets. Week uses ISO year-week (IYYY-"W"IW) as the closest
// standard equivalent to SQLite's %Y-W%W.
const BUCKET_EXPR: Record<'day' | 'week' | 'month', string> = {
  day: `to_char(created_at::timestamp, 'YYYY-MM-DD')`,
  week: `to_char(created_at::timestamp, 'IYYY-"W"IW')`,
  month: `to_char(created_at::timestamp, 'YYYY-MM')`,
};

export async function movementReport(params: { bucket: 'day' | 'week' | 'month'; marketerId?: string }): Promise<MovementRow[]> {
  const bucketExpr = BUCKET_EXPR[params.bucket];
  const where = params.marketerId ? 'WHERE marketer_id = ?' : '';
  const args = params.marketerId ? [params.marketerId] : [];
  return await db.prepare(`
    SELECT ${bucketExpr} AS period,
      COALESCE(SUM(CASE WHEN event_type = 'EMPTY_RETURNED' THEN quantity ELSE 0 END), 0) AS returned,
      COALESCE(SUM(CASE WHEN event_type = 'SOLD_WITH_BOTTLE' THEN quantity ELSE 0 END), 0) AS sold_with_bottle
    FROM bottle_custody_events
    ${where}
    GROUP BY period
    ORDER BY period DESC
  `).all(...args) as unknown as MovementRow[];
}
