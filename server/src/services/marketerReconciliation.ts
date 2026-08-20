import { db } from '../db/client.js';

/** End-of-day marketer reconciliation (Section: END-OF-DAY MARKETER
 *  RECONCILIATION). Assigned = Sold + Returned + Remaining always holds by
 *  construction — marketer_stock_transactions is an append-only ledger and
 *  `remaining` is simply what it hasn't yet accounted as sold or returned,
 *  so there is no way for those four figures to disagree with each other.
 *  The real discrepancy this surfaces lives one level down: a return the
 *  marketer *claims* is already off their books (assigned/returned/remaining
 *  react to it immediately — see marketerStock.recordReturn) but the
 *  warehouse hasn't physically counted back in yet (PENDING_RETURN), an
 *  assignment posted by the warehouse the marketer hasn't confirmed yet
 *  (PENDING_VERIFICATION, Section 12), or — once the warehouse does count a
 *  claimed return — the physical count coming back short or over what was
 *  claimed (SHORT / EXCESS, see marketerStock.verifyReturn). Nothing here is
 *  a snapshot: every figure is live, same "on hand right now" philosophy as
 *  dayClose.ts and stockPosition.ts. */
export type ReconciliationStatus = 'BALANCED' | 'SHORT' | 'EXCESS' | 'PENDING_RETURN' | 'PENDING_VERIFICATION';

export interface ReconciliationLine {
  marketer_id: string;
  marketer_name: string;
  item_id: string;
  item_name: string;
  assigned: number;
  sold: number;
  returned: number;
  remaining: number;
  pending_assignment: number;
  pending_return: number;
  discrepancy: number;
  status: ReconciliationStatus;
}

function statusFor(line: { pending_assignment: number; pending_return: number; shortfall: number; excess: number }): ReconciliationStatus {
  if (line.pending_assignment > 0) return 'PENDING_VERIFICATION';
  if (line.pending_return > 0) return 'PENDING_RETURN';
  if (line.shortfall > 0) return 'SHORT';
  if (line.excess > 0) return 'EXCESS';
  return 'BALANCED';
}

export function reconciliation(marketerId?: string): ReconciliationLine[] {
  const rows = db.prepare(`
    WITH pairs AS (
      SELECT DISTINCT marketer_id, item_id FROM marketer_stock_transactions
      UNION
      SELECT DISTINCT msi.marketer_id, msii.item_id
      FROM marketer_stock_issues msi JOIN marketer_stock_issue_items msii ON msii.issue_id = msi.id
    )
    SELECT
      p.marketer_id, c.name AS marketer_name, p.item_id, i.name AS item_name,
      COALESCE(a.assigned, 0) AS assigned,
      COALESCE(s.sold, 0) AS sold,
      COALESCE(r.returned, 0) AS returned,
      COALESCE(a.assigned, 0) - COALESCE(s.sold, 0) - COALESCE(r.returned, 0) AS remaining,
      COALESCE(pa.pending, 0) AS pending_assignment,
      COALESCE(pr.pending, 0) AS pending_return,
      COALESCE(mis.shortfall, 0) AS shortfall,
      COALESCE(mis.excess, 0) AS excess
    FROM pairs p
    JOIN customers c ON c.id = p.marketer_id
    JOIN items i ON i.id = p.item_id
    LEFT JOIN (
      SELECT marketer_id, item_id, SUM(quantity) AS assigned FROM marketer_stock_transactions
      WHERE direction = 'IN' AND source_type = 'ISSUE' GROUP BY marketer_id, item_id
    ) a ON a.marketer_id = p.marketer_id AND a.item_id = p.item_id
    LEFT JOIN (
      SELECT marketer_id, item_id, SUM(quantity) AS sold FROM marketer_stock_transactions
      WHERE direction = 'OUT' AND source_type = 'SOLD' GROUP BY marketer_id, item_id
    ) s ON s.marketer_id = p.marketer_id AND s.item_id = p.item_id
    LEFT JOIN (
      SELECT marketer_id, item_id, SUM(quantity) AS returned FROM marketer_stock_transactions
      WHERE direction = 'OUT' AND source_type = 'RETURN' GROUP BY marketer_id, item_id
    ) r ON r.marketer_id = p.marketer_id AND r.item_id = p.item_id
    LEFT JOIN (
      SELECT msi.marketer_id, msii.item_id, SUM(msii.quantity) AS pending
      FROM marketer_stock_issues msi JOIN marketer_stock_issue_items msii ON msii.issue_id = msi.id
      WHERE msi.status = 'ASSIGNED' GROUP BY msi.marketer_id, msii.item_id
    ) pa ON pa.marketer_id = p.marketer_id AND pa.item_id = p.item_id
    LEFT JOIN (
      SELECT mr.marketer_id, mri.item_id, SUM(mri.quantity) AS pending
      FROM marketer_returns mr JOIN marketer_return_items mri ON mri.return_id = mr.id
      WHERE mr.status = 'PENDING_VERIFICATION' GROUP BY mr.marketer_id, mri.item_id
    ) pr ON pr.marketer_id = p.marketer_id AND pr.item_id = p.item_id
    LEFT JOIN (
      SELECT mr.marketer_id, mri.item_id,
        SUM(CASE WHEN mri.quantity > mri.verified_quantity THEN mri.quantity - mri.verified_quantity ELSE 0 END) AS shortfall,
        SUM(CASE WHEN mri.verified_quantity > mri.quantity THEN mri.verified_quantity - mri.quantity ELSE 0 END) AS excess
      FROM marketer_returns mr JOIN marketer_return_items mri ON mri.return_id = mr.id
      WHERE mr.status = 'VERIFIED' AND mri.verified_quantity IS NOT NULL
      GROUP BY mr.marketer_id, mri.item_id
    ) mis ON mis.marketer_id = p.marketer_id AND mis.item_id = p.item_id
    ${marketerId ? 'WHERE p.marketer_id = ?' : ''}
    ORDER BY c.name, i.name
  `).all(...(marketerId ? [marketerId] : [])) as unknown as (Omit<ReconciliationLine, 'discrepancy' | 'status'> & { shortfall: number; excess: number })[];

  return rows.map(({ shortfall, excess, ...line }) => ({
    ...line,
    discrepancy: shortfall > 0 ? shortfall : excess > 0 ? -excess : 0,
    status: statusFor({ pending_assignment: line.pending_assignment, pending_return: line.pending_return, shortfall, excess }),
  }));
}
