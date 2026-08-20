import { db } from '../db/client.js';

/** The "marketer trust stock" exception: a marketer/retail point may report
 *  goods sold or returned before those goods are physically back on the
 *  warehouse floor (see marketerStock.recordReturn/verifyReturn and
 *  salesReturns.createReturn/inspectReturn — both defer the real inventory
 *  posting until someone at the warehouse physically counts what arrived).
 *  That gap is invisible unless named explicitly, which is what this reports
 *  per finished good: never collapses the four figures into one balance. */
export interface StockPositionLine {
  item_id: string;
  item_name: string;
  category: string;
  unit: string;
  physical_stock: number;
  assigned_stock: number;
  pending_return: number;
  available_stock: number;
}

/** physical_stock: what's actually sitting in the Finished Goods Warehouse right
 *    now (inventory_transactions balance) — decremented the moment goods are
 *    physically loaded out to a marketer or Retail, same instant a real GRN or
 *    packaging run increments it.
 *  assigned_stock: currently out with a marketer or at Retail, not yet sold or
 *    returned — marketer_stock_transactions (a marketer's own VERIFIED, held
 *    balance — see marketerStock.verifyAssignment) + retail_stock_transactions,
 *    PLUS whatever's sitting in marketer_stock_issues as ASSIGNED but not yet
 *    verified (Section 12: physically left the warehouse the moment the
 *    warehouse posted it, so it can't just vanish from this figure while the
 *    marketer hasn't confirmed receipt yet). Distributor/Marketer invoice
 *    sales aren't consignment in this system — once invoiced they're a
 *    completed sale, not "assigned" stock — so those don't contribute here.
 *  pending_return: claimed as coming back but not yet physically verified/
 *    inspected by the warehouse — marketer_returns sitting PENDING_VERIFICATION
 *    plus sales_returns sitting PENDING_INSPECTION. Already left assigned_stock
 *    (the marketer's balance drops the moment they claim a return) but hasn't
 *    yet landed in physical_stock (that only happens on verification/inspection)
 *    — this is exactly the temporary gap management needs visibility into.
 *  available_stock: physical_stock currently free to hand out to a new
 *    assignment. Equal to physical_stock today (nothing in this system reserves
 *    physical stock against an unfulfilled order), kept as its own field rather
 *    than reusing physical_stock so a future reservation concept has somewhere
 *    to land without renaming this API. */
export function getStockPosition(): StockPositionLine[] {
  return db.prepare(`
    SELECT
      i.id AS item_id, i.name AS item_name, i.category, i.uom AS unit,
      COALESCE(inv.physical, 0) AS physical_stock,
      COALESCE(mkt.assigned, 0) + COALESCE(rtl.assigned, 0) + COALESCE(asg.assigned, 0) AS assigned_stock,
      COALESCE(mrt.pending, 0) + COALESCE(srt.pending, 0) AS pending_return,
      COALESCE(inv.physical, 0) AS available_stock
    FROM items i
    LEFT JOIN (
      SELECT item_id, SUM(CASE WHEN direction = 'IN' THEN quantity ELSE -quantity END) AS physical
      FROM inventory_transactions GROUP BY item_id
    ) inv ON inv.item_id = i.id
    LEFT JOIN (
      SELECT item_id, SUM(CASE WHEN direction = 'IN' THEN quantity ELSE -quantity END) AS assigned
      FROM marketer_stock_transactions GROUP BY item_id
    ) mkt ON mkt.item_id = i.id
    LEFT JOIN (
      SELECT item_id, SUM(CASE WHEN direction = 'IN' THEN quantity ELSE -quantity END) AS assigned
      FROM retail_stock_transactions GROUP BY item_id
    ) rtl ON rtl.item_id = i.id
    LEFT JOIN (
      SELECT msii.item_id, SUM(msii.quantity) AS assigned
      FROM marketer_stock_issue_items msii JOIN marketer_stock_issues msi ON msi.id = msii.issue_id
      WHERE msi.status = 'ASSIGNED' GROUP BY msii.item_id
    ) asg ON asg.item_id = i.id
    LEFT JOIN (
      SELECT mri.item_id, SUM(mri.quantity) AS pending
      FROM marketer_return_items mri JOIN marketer_returns mr ON mr.id = mri.return_id
      WHERE mr.status = 'PENDING_VERIFICATION' GROUP BY mri.item_id
    ) mrt ON mrt.item_id = i.id
    LEFT JOIN (
      SELECT sri.item_id, SUM(sri.quantity_returned) AS pending
      FROM sales_return_items sri JOIN sales_returns sr ON sr.id = sri.return_id
      WHERE sr.status = 'PENDING_INSPECTION' GROUP BY sri.item_id
    ) srt ON srt.item_id = i.id
    WHERE i.type = 'FINISHED_GOOD'
    ORDER BY i.name
  `).all() as unknown as StockPositionLine[];
}
