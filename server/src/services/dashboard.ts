import { db } from '../db/client.js';
import type {
  KpiMetric, TrendPoint, ProductVolume, TraceStop,
  SalesOverviewPoint, ProfitLossPoint, LowStockAlert, TopProduct,
} from '../../../shared/src/types.js';

function pct(curr: number, prev: number): number {
  if (prev === 0) return curr > 0 ? 100 : 0;
  return Math.round(((curr - prev) / prev) * 1000) / 10;
}

// SQLite's datetime('now', '-N days') / date('now', '-N days') have no Postgres
// equivalent — every *_at/*_date column here is formatted TEXT (see schema.ts),
// so cutoffs are computed here in the same text shape and compared directly.
// isoCutoff is a moving instant (N*24h ago); dayStart is a calendar-date
// boundary at 00:00 UTC, matching SQLite's date('now', '-N days') exactly.
function isoCutoff(days: number): string {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString().slice(0, 19).replace('T', ' ');
}
function dayStart(daysAgo: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - daysAgo);
  return `${d.toISOString().slice(0, 10)} 00:00:00`;
}

export async function kpis(): Promise<KpiMetric[]> {
  const units = (await db.prepare(`SELECT COALESCE(SUM(quantity), 0) AS v FROM finished_goods WHERE packaged_at >= ?`).get(isoCutoff(7)) as { v: number }).v;
  const unitsPrev = (await db.prepare(`SELECT COALESCE(SUM(quantity), 0) AS v FROM finished_goods WHERE packaged_at >= ? AND packaged_at < ?`).get(isoCutoff(14), isoCutoff(7)) as { v: number }).v;

  const yieldRow = await db.prepare(`
    SELECT AVG(CASE WHEN units_target > 0 THEN 100.0 * units_actual / units_target ELSE 100 END) AS v
    FROM production_batches WHERE status = 'COMPLETED' AND started_at >= ?
  `).get(isoCutoff(7)) as { v: number | null };

  const awaiting = (await db.prepare(`
    SELECT COUNT(*) AS v FROM sales
    WHERE channel = 'INVOICE' AND status IN ('PENDING','PROCESSING') AND id NOT IN (SELECT sales_id FROM delivery_runs WHERE status NOT IN ('CANCELLED','RETURNED'))
  `).get() as { v: number }).v;

  const revenue = (await db.prepare(`SELECT COALESCE(SUM(total_amount), 0) AS v FROM sales WHERE created_at >= ?`).get(isoCutoff(7)) as { v: number }).v;
  const revenuePrev = (await db.prepare(`SELECT COALESCE(SUM(total_amount), 0) AS v FROM sales WHERE created_at >= ? AND created_at < ?`).get(isoCutoff(14), isoCutoff(7)) as { v: number }).v;

  return [
    { key: 'units', label: 'Units produced', icon: 'drop', value: units.toLocaleString('en-NG'), delta: pct(units, unitsPrev), good: units >= unitsPrev },
    { key: 'yield', label: 'Production yield', icon: 'chart', value: `${(yieldRow.v ?? 100).toFixed(1)}%`, delta: undefined, good: true },
    { key: 'dispatch', label: 'Orders awaiting dispatch', icon: 'box', value: String(awaiting), delta: undefined, good: true },
    { key: 'revenue', label: 'Revenue', icon: 'wallet', value: `₦${Math.round(revenue).toLocaleString('en-NG')}`, delta: pct(revenue, revenuePrev), good: revenue >= revenuePrev },
  ];
}

const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export async function trend(): Promise<TrendPoint[]> {
  const rows = await db.prepare(`
    SELECT to_char(packaged_at::timestamp, 'YYYY-MM-DD') AS day, SUM(quantity) AS units FROM finished_goods
    WHERE packaged_at >= ? GROUP BY day
  `).all(dayStart(6)) as { day: string; units: number }[];
  const byDay = new Map(rows.map(r => [r.day, r.units]));

  const out: TrendPoint[] = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    const key = d.toISOString().slice(0, 10);
    out.push({ day: DAY_NAMES[d.getDay()], units: byDay.get(key) ?? 0 });
  }
  return out;
}

export async function byProduct(): Promise<ProductVolume[]> {
  const recent = await db.prepare(`
    SELECT i.name AS label, SUM(fg.quantity) AS value FROM finished_goods fg JOIN items i ON i.id = fg.item_id
    WHERE fg.packaged_at >= ? GROUP BY i.id ORDER BY value DESC LIMIT 5
  `).all(isoCutoff(7)) as unknown as ProductVolume[];
  if (recent.length > 0) return recent;
  // Fall back to all-time if nothing packaged in the last week yet.
  return await db.prepare(`
    SELECT i.name AS label, SUM(fg.quantity) AS value FROM finished_goods fg JOIN items i ON i.id = fg.item_id
    GROUP BY i.id ORDER BY value DESC LIMIT 5
  `).all() as unknown as ProductVolume[];
}

/** Daily revenue (sales) against daily "Operating expenses" ledger debits, last 7 days —
 *  the bar+line pair behind the Sales overview chart. */
export async function salesOverview(): Promise<SalesOverviewPoint[]> {
  const salesRows = await db.prepare(`
    SELECT to_char(created_at::timestamp, 'YYYY-MM-DD') AS day, SUM(total_amount) AS v FROM sales
    WHERE created_at >= ? GROUP BY day
  `).all(dayStart(6)) as { day: string; v: number }[];
  const expenseRows = await db.prepare(`
    SELECT to_char(entry_date::timestamp, 'YYYY-MM-DD') AS day, SUM(debit) AS v FROM ledger
    WHERE account = 'Operating expenses' AND entry_date >= ? GROUP BY day
  `).all(dayStart(6)) as { day: string; v: number }[];
  const salesByDay = new Map(salesRows.map(r => [r.day, r.v]));
  const expByDay = new Map(expenseRows.map(r => [r.day, r.v]));

  const out: SalesOverviewPoint[] = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    const key = d.toISOString().slice(0, 10);
    const sales = salesByDay.get(key) ?? 0;
    const expenses = expByDay.get(key) ?? 0;
    out.push({ day: DAY_NAMES[d.getDay()], sales: Math.round(sales), profit: Math.round(sales - expenses) });
  }
  return out;
}

const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** Same revenue-minus-expenses calculation as salesOverview, extended to a selectable
 *  window — the green/red profit-and-loss area chart. */
export async function profitLoss(days: number): Promise<ProfitLossPoint[]> {
  const cutoff = dayStart(days - 1);
  const salesRows = await db.prepare(`
    SELECT to_char(created_at::timestamp, 'YYYY-MM-DD') AS day, SUM(total_amount) AS v FROM sales
    WHERE created_at >= ? GROUP BY day
  `).all(cutoff) as { day: string; v: number }[];
  const expenseRows = await db.prepare(`
    SELECT to_char(entry_date::timestamp, 'YYYY-MM-DD') AS day, SUM(debit) AS v FROM ledger
    WHERE account = 'Operating expenses' AND entry_date >= ? GROUP BY day
  `).all(cutoff) as { day: string; v: number }[];
  const salesByDay = new Map(salesRows.map(r => [r.day, r.v]));
  const expByDay = new Map(expenseRows.map(r => [r.day, r.v]));

  const out: ProfitLossPoint[] = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    const key = d.toISOString().slice(0, 10);
    const sales = salesByDay.get(key) ?? 0;
    const expenses = expByDay.get(key) ?? 0;
    out.push({ day: `${MONTH_NAMES[d.getMonth()]} ${d.getDate()}`, value: Math.round(sales - expenses) });
  }
  return out;
}

/** Items at or below their reorder point, worst-off first. Returns raw rows (with `id`) so
 *  the route can run them through deletionRequests.filterDeleted before trimming to a top N. */
export async function lowStockAlertRows(): Promise<LowStockAlert[]> {
  return await db.prepare(`
    SELECT i.id, i.name, i.uom, i.reorder_point AS "reorderPoint", COALESCE(b.on_hand, 0) AS "onHand"
    FROM items i LEFT JOIN inventory_balances b ON b.item_id = i.id
    WHERE COALESCE(b.on_hand, 0) <= i.reorder_point
    ORDER BY (COALESCE(b.on_hand, 0) - i.reorder_point) ASC
  `).all() as unknown as LowStockAlert[];
}

/** Every item joined to its balance, for the Stock status donut — also raw rows so the
 *  route can filter out deleted items before aggregating into counts. */
export async function stockStatusRows(): Promise<(LowStockAlert & { id: string })[]> {
  return await db.prepare(`
    SELECT i.id, i.name, i.uom, i.reorder_point AS "reorderPoint", COALESCE(b.on_hand, 0) AS "onHand"
    FROM items i LEFT JOIN inventory_balances b ON b.item_id = i.id
  `).all() as unknown as (LowStockAlert & { id: string })[];
}

export async function topProducts(limit = 5): Promise<TopProduct[]> {
  const recent = await db.prepare(`
    SELECT i.id, i.name, SUM(si.quantity) AS "unitsSold"
    FROM sales_items si JOIN items i ON i.id = si.item_id JOIN sales s ON s.id = si.sales_id
    WHERE s.created_at >= ? GROUP BY i.id ORDER BY "unitsSold" DESC LIMIT ?
  `).all(isoCutoff(30), limit) as unknown as TopProduct[];
  if (recent.length > 0) return recent;
  return await db.prepare(`
    SELECT i.id, i.name, SUM(si.quantity) AS "unitsSold"
    FROM sales_items si JOIN items i ON i.id = si.item_id GROUP BY i.id ORDER BY "unitsSold" DESC LIMIT ?
  `).all(limit) as unknown as TopProduct[];
}

/** A real join across the chain for one delivery: source water → production batch →
 *  QC verdict → packaging → the sales order it fulfilled → the waybill itself. The item
 *  a lot fulfilled is attributed by "most recent finished-goods packaging of that SKU"
 *  rather than a strict per-unit lot allocation, which this schema doesn't track. */
export async function deliveryTrace(deliveryId: string): Promise<TraceStop[] | null> {
  const delivery = await db.prepare(`
    SELECT dr.*, v.driver AS vehicle_driver FROM delivery_runs dr JOIN vehicles v ON v.id = dr.vehicle_id WHERE dr.id = ?
  `).get(deliveryId) as Record<string, any> | undefined;
  if (!delivery) return null;

  const sale = await db.prepare(`
    SELECT s.*, c.name AS customer_name, c.location AS customer_location FROM sales s
    JOIN customers c ON c.id = s.customer_id WHERE s.id = ?
  `).get(delivery.sales_id) as Record<string, any> | undefined;
  if (!sale) return null;

  const items = await db.prepare(`
    SELECT si.*, i.name AS item_name FROM sales_items si JOIN items i ON i.id = si.item_id WHERE si.sales_id = ?
  `).all(delivery.sales_id) as Record<string, any>[];
  const primary = items[0];

  const stages: TraceStop[] = [];

  if (primary) {
    const fg = await db.prepare('SELECT * FROM finished_goods WHERE item_id = ? ORDER BY packaged_at DESC LIMIT 1').get(primary.item_id) as Record<string, any> | undefined;
    if (fg) {
      const batch = await db.prepare('SELECT * FROM production_batches WHERE id = ?').get(fg.batch_id) as Record<string, any> | undefined;
      if (batch?.water_treatment_run_id) {
        const source = await db.prepare('SELECT * FROM water_treatment_runs WHERE id = ?').get(batch.water_treatment_run_id) as Record<string, any> | undefined;
        if (source) {
          stages.push({ stage: 'Source', ref: source.id, detail: `${source.source} · ${source.stage} · ${Math.round(source.volume_l).toLocaleString('en-NG')} L drawn` });
        }
      }
      if (batch) {
        stages.push({ stage: 'Production', ref: batch.id, detail: `${batch.line} · ${batch.shift} shift · ${batch.units_actual.toLocaleString('en-NG')} units, ${batch.operator}` });
        const qc = await db.prepare(`SELECT * FROM quality_control WHERE ref_type = 'PRODUCTION_BATCH' AND ref_id = ? ORDER BY id DESC LIMIT 1`).get(batch.id) as Record<string, any> | undefined;
        if (qc) {
          stages.push({ stage: 'Quality control', ref: qc.id, detail: `${qc.parameter ?? 'Inspection'}: ${qc.result ?? qc.verdict}`, verdict: qc.verdict === 'PASS' ? 'pass' : 'fail' });
        }
      }
      stages.push({ stage: 'Packaging', ref: fg.id, detail: `${fg.quantity.toLocaleString('en-NG')} × ${primary.item_name}, ${fg.packaged_by ?? ''}`.trim() });
    }
  }

  stages.push({ stage: 'Sales order', ref: sale.id, detail: `${sale.customer_name}, ${items.length} line item(s), ₦${sale.total_amount.toLocaleString('en-NG')}` });
  stages.push({ stage: 'Waybill', ref: delivery.id, detail: `${delivery.route ?? sale.customer_location}, driver ${delivery.driver ?? delivery.vehicle_driver}` });

  return stages;
}
