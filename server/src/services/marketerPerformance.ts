import { db } from '../db/client.js';
import * as marketerReconciliation from './marketerReconciliation.js';

const COMMISSION_SETTING_ID = 'Marketer commission rate';

/** Configurable, never hard-coded (the spec's own words) — read from the
 *  Settings module's existing generic CRUD (module 18), the same table/UI
 *  every other business rule in this app is tuned through. Stored as e.g.
 *  "5%"; a missing or unparseable row is 0% rather than a guessed default,
 *  since paying commission on an unconfigured rate would be a real financial
 *  error, not a safe fallback. */
export function commissionRatePercent(): number {
  const row = db.prepare('SELECT value FROM settings WHERE id = ?').get(COMMISSION_SETTING_ID) as { value: string } | undefined;
  if (!row) return 0;
  const parsed = Number(row.value.replace(/[^0-9.]/g, ''));
  return Number.isFinite(parsed) ? parsed : 0;
}

export interface MarketerPerformanceRow {
  marketer_id: string;
  marketer_name: string;
  cash_sales: number;
  credit_sales: number;
  credit_recovered: number;
  outstanding_credit: number;
  total_sales: number;
  eligible_sales: number;
  commissionable_sales: number;
  commission_rate: number;
  commission: number;
  stock_received: number;
  stock_sold: number;
  stock_returned: number;
  stock_outstanding: number;
}

export interface DateRange { from: string; to: string }

/** Marketer Commission and Performance report. cash_sales/credit_sales split
 *  per sale (not per naira) — a sale counts as a Credit Sale in full the
 *  moment any of it is unpaid at the point of sale, matching how "sold on
 *  credit" reads as a plain business fact.
 *
 *  The business rule this exists for: "a marketer does not receive
 *  commission for unrecovered credit sales" — eligible_sales is total_sales
 *  with nothing excluded yet (kept as its own field, distinct from
 *  total_sales, so a future exclusion — e.g. a reversed sale — has somewhere
 *  to land without renaming this API); commissionable_sales is Cash +
 *  Recovered Credit, never plain total_sales. commission = commissionable_sales
 *  × commissionRatePercent(), the configured rate — never a hard-coded
 *  number.
 *
 *  Section 39 adds optional date-range scoping (Daily/Monthly/Yearly/Custom).
 *  Cash/Credit Sales and Stock Received/Sold/Returned are scoped to activity
 *  *within* the range — "what happened this period." Outstanding Credit and
 *  Stock Outstanding stay live/all-time regardless of range — both are
 *  "what's currently owed/held right now" concepts, the same philosophy
 *  dayClose.ts and stockPosition.ts use everywhere else in this app, so an
 *  unrelated old debt from a prior period can never zero out this period's
 *  commission. credit_recovered is genuine recovery of credit specifically —
 *  ledger credit (payment) entries within the range, excluding the
 *  same-transaction settlement a fully-paid-at-sale cash sale posts (that's
 *  not "recovering" anything, it was never outstanding) — so
 *  commissionable_sales = cash_sales + credit_recovered holds consistently
 *  whether or not a range is given. */
export function performanceReport(range?: DateRange): MarketerPerformanceRow[] {
  const marketers = db.prepare(`SELECT id, name FROM customers WHERE customer_type = 'MARKETER' ORDER BY name`).all() as { id: string; name: string }[];
  const rate = commissionRatePercent();
  const rangeParams = range ? [range.from, range.to] : [];

  const salesByMarketer = new Map(
    (db.prepare(`
      WITH sale_totals AS (
        SELECT mcs.id AS sale_id, mcs.marketer_id, mcs.cash_received,
          (SELECT COALESCE(SUM(quantity * unit_price), 0) FROM marketer_customer_sale_items WHERE sale_id = mcs.id) AS sale_total
        FROM marketer_customer_sales mcs
        WHERE 1 = 1 ${range ? 'AND date(mcs.created_at) BETWEEN date(?) AND date(?)' : ''}
      )
      SELECT marketer_id,
        SUM(CASE WHEN cash_received >= sale_total THEN sale_total ELSE 0 END) AS cash_sales,
        SUM(CASE WHEN cash_received < sale_total THEN sale_total ELSE 0 END) AS credit_sales
      FROM sale_totals GROUP BY marketer_id
    `).all(...rangeParams) as { marketer_id: string; cash_sales: number; credit_sales: number }[]).map(r => [r.marketer_id, r]),
  );

  // Live, all-time — never scoped to the report range (see doc comment above).
  const outstandingByMarketer = new Map(
    (db.prepare(`
      SELECT mc.marketer_id, COALESCE(SUM(l.debit), 0) - COALESCE(SUM(l.credit), 0) AS outstanding
      FROM marketer_customer_ledger l JOIN marketer_customers mc ON mc.id = l.customer_id
      GROUP BY mc.marketer_id
    `).all() as { marketer_id: string; outstanding: number }[]).map(r => [r.marketer_id, r.outstanding]),
  );

  const recoveredByMarketer = new Map(
    (db.prepare(`
      WITH settled_cash_sale_ids AS (
        SELECT mcs.id FROM marketer_customer_sales mcs
        WHERE mcs.cash_received >= (SELECT COALESCE(SUM(quantity * unit_price), 0) FROM marketer_customer_sale_items WHERE sale_id = mcs.id)
      )
      SELECT mc.marketer_id, COALESCE(SUM(l.credit), 0) AS recovered
      FROM marketer_customer_ledger l JOIN marketer_customers mc ON mc.id = l.customer_id
      WHERE l.credit > 0 AND l.reference_id NOT IN (SELECT id FROM settled_cash_sale_ids)
        ${range ? 'AND date(l.entry_date) BETWEEN date(?) AND date(?)' : ''}
      GROUP BY mc.marketer_id
    `).all(...rangeParams) as { marketer_id: string; recovered: number }[]).map(r => [r.marketer_id, r.recovered]),
  );

  const stockMovementByMarketer = new Map(
    (db.prepare(`
      SELECT marketer_id,
        SUM(CASE WHEN direction = 'IN' AND source_type = 'ISSUE' THEN quantity ELSE 0 END) AS received,
        SUM(CASE WHEN direction = 'OUT' AND source_type = 'SOLD' THEN quantity ELSE 0 END) AS sold,
        SUM(CASE WHEN direction = 'OUT' AND source_type = 'RETURN' THEN quantity ELSE 0 END) AS returned
      FROM marketer_stock_transactions
      WHERE 1 = 1 ${range ? 'AND date(created_at) BETWEEN date(?) AND date(?)' : ''}
      GROUP BY marketer_id
    `).all(...rangeParams) as { marketer_id: string; received: number; sold: number; returned: number }[]).map(r => [r.marketer_id, r]),
  );

  // Live, all-time — what's currently in the marketer's hands, same reasoning as outstanding_credit above.
  const stockOutstandingByMarketer = new Map<string, number>();
  for (const line of marketerReconciliation.reconciliation()) {
    stockOutstandingByMarketer.set(line.marketer_id, (stockOutstandingByMarketer.get(line.marketer_id) ?? 0) + line.remaining);
  }

  return marketers.map(m => {
    const s = salesByMarketer.get(m.id) ?? { cash_sales: 0, credit_sales: 0 };
    const outstandingCredit = Math.max(outstandingByMarketer.get(m.id) ?? 0, 0);
    const totalSales = s.cash_sales + s.credit_sales;
    const eligibleSales = totalSales;
    const creditRecovered = recoveredByMarketer.get(m.id) ?? 0;
    const commissionableSales = s.cash_sales + creditRecovered;
    const stock = stockMovementByMarketer.get(m.id) ?? { received: 0, sold: 0, returned: 0 };
    const stockOutstanding = stockOutstandingByMarketer.get(m.id) ?? 0;

    return {
      marketer_id: m.id, marketer_name: m.name,
      cash_sales: s.cash_sales, credit_sales: s.credit_sales, credit_recovered: creditRecovered, outstanding_credit: outstandingCredit,
      total_sales: totalSales, eligible_sales: eligibleSales, commissionable_sales: commissionableSales,
      commission_rate: rate, commission: commissionableSales * (rate / 100),
      stock_received: stock.received, stock_sold: stock.sold, stock_returned: stock.returned, stock_outstanding: stockOutstanding,
    };
  });
}
