import { db } from '../db/client.js';
import { nextBusinessId } from '../db/ids.js';
import * as activityLog from './activityLog.js';
import * as inventory from './inventory.js';

export interface RetailBalance { id: string; name: string; category: string; uom: string; unit_cost: number; on_hand: number }
export interface RetailIntake { id: string; issued_by: string | null; actor: string | null; created_at: string; item_count: number; total_quantity: number }
export interface RetailIntakeItem { item_id: string; item_name: string; quantity: number; unit_cost: number }

/** The only functions in the app allowed to write retail_stock_transactions —
 *  mirrors inventory.postTransaction being the sole writer of inventory_transactions. */
async function postRetailTransaction(params: {
  itemId: string; direction: 'IN' | 'OUT'; quantity: number; unitCost?: number;
  sourceType: 'INTAKE' | 'SOLD' | 'ADJUSTMENT'; sourceId?: string; actor?: string;
}): Promise<void> {
  await db.prepare(
    `INSERT INTO retail_stock_transactions (item_id, direction, quantity, unit_cost, source_type, source_id, actor)
     VALUES (?,?,?,?,?,?,?)`,
  ).run(params.itemId, params.direction, params.quantity, params.unitCost ?? 0, params.sourceType, params.sourceId ?? null, params.actor ?? null);
}

export async function getBalances(): Promise<RetailBalance[]> {
  return await db.prepare(`
    SELECT i.id, i.name, i.category, i.uom, i.unit_cost,
      COALESCE((SELECT SUM(CASE WHEN t.direction = 'IN' THEN t.quantity ELSE -t.quantity END) FROM retail_stock_transactions t WHERE t.item_id = i.id), 0) AS on_hand
    FROM items i
    WHERE EXISTS (SELECT 1 FROM retail_stock_transactions t WHERE t.item_id = i.id)
    ORDER BY i.name
  `).all() as unknown as RetailBalance[];
}

export async function getBalance(itemId: string): Promise<number> {
  const row = await db.prepare(`
    SELECT COALESCE(SUM(CASE WHEN direction = 'IN' THEN quantity ELSE -quantity END), 0) AS on_hand
    FROM retail_stock_transactions WHERE item_id = ?
  `).get(itemId) as { on_hand: number };
  return row.on_hand;
}

/** A sale against retail stock (called from services/sales.ts for channel='POS')
 *  — deducts from the Retail unit's own balance, not the central warehouse ledger,
 *  since that stock already left the warehouse at intake time. */
export async function postSale(params: { itemId: string; quantity: number; unitCost: number; salesId: string; actor?: string }): Promise<void> {
  await postRetailTransaction({ itemId: params.itemId, direction: 'OUT', quantity: params.quantity, unitCost: params.unitCost, sourceType: 'SOLD', sourceId: params.salesId, actor: params.actor });
}

/** Undoes postSale — a reversed POS sale returns stock to the Retail unit,
 *  not the central warehouse (mirrors sales.reverseOrder's INVOICE branch). */
export async function reverseSale(params: { itemId: string; quantity: number; unitCost: number; salesId: string; actor?: string }): Promise<void> {
  await postRetailTransaction({ itemId: params.itemId, direction: 'IN', quantity: params.quantity, unitCost: params.unitCost, sourceType: 'SOLD', sourceId: params.salesId, actor: params.actor });
}

/** Transfers stock from the central warehouse into Retail's own bounded
 *  stock — the "Retail Department receives products from the Warehouse/Store"
 *  step. Mirrors marketerStock.issueStock: decrements the central ledger via
 *  inventory.postTransaction (MATERIAL_ISSUE, the same source type an
 *  internal stock transfer already uses elsewhere), then credits the
 *  destination ledger — here, retail_stock_transactions instead of a
 *  per-marketer balance. */
export async function postIntake(params: { issuedBy: string; items: { itemId: string; quantity: number; unitCost: number }[]; actor?: string }): Promise<RetailIntake> {
  if (params.items.length === 0) throw new Error('An intake must have at least one item');
  for (const it of params.items) {
    if (it.quantity <= 0) throw new Error(`Quantity for ${it.itemId} must be positive`);
    const available = await inventory.getBalance(it.itemId);
    if (it.quantity > available) throw new Error(`Only ${available} of ${it.itemId} available in the central warehouse`);
  }

  const actor = params.actor ?? params.issuedBy;
  const id = await nextBusinessId('retail_intakes', 'RTI-', 4);

  await db.transaction(async () => {
    await db.prepare('INSERT INTO retail_intakes (id, issued_by, actor) VALUES (?,?,?)').run(id, params.issuedBy, actor);
    const insertItem = db.prepare('INSERT INTO retail_intake_items (intake_id, item_id, quantity, unit_cost) VALUES (?,?,?,?)');
    for (const it of params.items) {
      await insertItem.run(id, it.itemId, it.quantity, it.unitCost);
      await inventory.postTransaction({
        itemId: it.itemId, direction: 'OUT', quantity: it.quantity, unitCost: it.unitCost,
        sourceType: 'MATERIAL_ISSUE', sourceId: id, actor,
        fromLocation: 'Finished Goods Warehouse', toLocation: 'Retail Stock',
        note: `Issued to Retail on ${id}`,
      });
      await postRetailTransaction({ itemId: it.itemId, direction: 'IN', quantity: it.quantity, unitCost: it.unitCost, sourceType: 'INTAKE', sourceId: id, actor });
    }
    const totalQuantity = params.items.reduce((s, it) => s + it.quantity, 0);
    await activityLog.record(actor, 'posted retail intake', 'retail_intake', id, `${id}: ${totalQuantity} unit(s) issued to Retail from the warehouse`);
  });
  return (await getIntake(id))!;
}

export async function getIntake(id: string): Promise<RetailIntake | undefined> {
  return (await listIntakes()).find(i => i.id === id);
}

export async function listIntakeItems(intakeId: string): Promise<RetailIntakeItem[]> {
  return await db.prepare(`
    SELECT ri.item_id, i.name AS item_name, ri.quantity, ri.unit_cost
    FROM retail_intake_items ri JOIN items i ON i.id = ri.item_id
    WHERE ri.intake_id = ?
  `).all(intakeId) as unknown as RetailIntakeItem[];
}

export async function listIntakes(): Promise<RetailIntake[]> {
  return await db.prepare(`
    SELECT ri.id, ri.issued_by, ri.actor, ri.created_at,
      COUNT(rii.id) AS item_count, COALESCE(SUM(rii.quantity), 0) AS total_quantity
    FROM retail_intakes ri LEFT JOIN retail_intake_items rii ON rii.intake_id = ri.id
    GROUP BY ri.id ORDER BY ri.id DESC
  `).all() as unknown as RetailIntake[];
}

export interface DailyReportLine { item_id: string; item_name: string; quantity: number }
export interface CategoryPaymentLine { category: string; payment_method: string; amount: number }
export interface DailyActivity { type: 'INTAKE' | 'SALE'; id: string; at: string; detail: string }
export interface DailyReport {
  date: string;
  received: DailyReportLine[];
  salesByCategoryAndPayment: CategoryPaymentLine[];
  remainingBalance: RetailBalance[];
  activity: DailyActivity[];
}

/** The Retail "end-of-day" reconciliation payload — everything the spec's
 *  Module 4 asks for in one call. Defaults to today but accepts any date so
 *  a past day can be reviewed. remainingBalance is deliberately always the
 *  live figure (not scoped to `date`), same reasoning services/dayClose.ts
 *  already documents for its own checks — "on hand right now" is what
 *  matters, not a snapshot frozen at close-of-business. */
export async function dailyReport(date?: string): Promise<DailyReport> {
  const d = date ?? new Date().toISOString().slice(0, 10);

  const received = await db.prepare(`
    SELECT t.item_id, i.name AS item_name, SUM(t.quantity) AS quantity
    FROM retail_stock_transactions t JOIN items i ON i.id = t.item_id
    WHERE t.source_type = 'INTAKE' AND to_char(t.created_at::timestamp, 'YYYY-MM-DD') = ?
    GROUP BY t.item_id ORDER BY i.name
  `).all(d) as unknown as DailyReportLine[];

  // PAID only — excludes a CANCELLED (reversed/voided) retail sale, which
  // never had its receipt or stock deduction reinstated.
  const salesByCategoryAndPayment = await db.prepare(`
    SELECT i.category AS category, COALESCE(r.method, 'Unspecified') AS payment_method, SUM(si.line_total) AS amount
    FROM sales s
    JOIN sales_items si ON si.sales_id = s.id
    JOIN items i ON i.id = si.item_id
    LEFT JOIN receipts r ON r.reference_type = 'sales' AND r.reference_id = s.id
    WHERE s.channel = 'POS' AND s.status = 'PAID' AND to_char(s.created_at::timestamp, 'YYYY-MM-DD') = ?
    GROUP BY i.category, payment_method ORDER BY i.category, payment_method
  `).all(d) as unknown as CategoryPaymentLine[];

  const intakesToday = await db.prepare(`
    SELECT id, created_at, issued_by FROM retail_intakes WHERE to_char(created_at::timestamp, 'YYYY-MM-DD') = ? ORDER BY id
  `).all(d) as { id: string; created_at: string; issued_by: string | null }[];
  const salesToday = await db.prepare(`
    SELECT s.id, s.created_at, s.rep, s.total_amount, COALESCE(c.name, 'Walk-in customer') AS customer_name
    FROM sales s LEFT JOIN customers c ON c.id = s.customer_id
    WHERE s.channel = 'POS' AND to_char(s.created_at::timestamp, 'YYYY-MM-DD') = ? ORDER BY s.id
  `).all(d) as { id: string; created_at: string; rep: string | null; total_amount: number; customer_name: string }[];

  const activity: DailyActivity[] = [
    ...intakesToday.map(i => ({ type: 'INTAKE' as const, id: i.id, at: i.created_at, detail: `Stock posted to Retail by ${i.issued_by ?? 'unknown'}` })),
    ...salesToday.map(s => ({ type: 'SALE' as const, id: s.id, at: s.created_at, detail: `Sold to ${s.customer_name} by ${s.rep ?? 'unknown'} — ₦${s.total_amount.toLocaleString('en-NG')}` })),
  ].sort((a, b) => a.at.localeCompare(b.at));

  return { date: d, received, salesByCategoryAndPayment, remainingBalance: await getBalances(), activity };
}
