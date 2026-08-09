import { Router } from 'express';
import { db } from '../db/client.js';

export const pendingCountsRouter = Router();

function count(sql: string): number {
  return (db.prepare(sql).get() as { n: number }).n;
}

/** One badge count per sidebar nav key, for items that already surface an
 *  "awaiting approval / inspection / verification" queue inline on their own
 *  page (see the KPI tiles on ProcurementPage, SalesPage, ProductionPage,
 *  DeleteRequestsPage) — this just makes the same counts visible from the
 *  sidebar before a user opens the page. */
pendingCountsRouter.get('/', (_req, res) => {
  res.json({
    'delete-requests': count(`SELECT COUNT(*) AS n FROM deletion_requests WHERE status = 'PENDING'`),
    'control-panel': count(`SELECT COUNT(*) AS n FROM users WHERE status = 'PENDING_APPROVAL'`),
    procurement:
      count(`SELECT COUNT(*) AS n FROM purchase_orders WHERE status = 'AWAITING_APPROVAL'`) +
      count(`SELECT COUNT(*) AS n FROM goods_received WHERE status = 'PENDING_INSPECTION'`) +
      count(`SELECT COUNT(*) AS n FROM supplier_returns WHERE status = 'PENDING'`),
    sales:
      count(`SELECT COUNT(*) AS n FROM sales WHERE status = 'AWAITING_APPROVAL'`) +
      count(`SELECT COUNT(*) AS n FROM sales_returns WHERE status = 'PENDING_INSPECTION'`) +
      count(`SELECT COUNT(*) AS n FROM marketer_returns WHERE status = 'PENDING_VERIFICATION'`),
    production: count(`SELECT COUNT(*) AS n FROM material_requests WHERE status = 'PENDING'`),
    // Retail customers overdue for follow-up (Module 20) — same 30-day
    // threshold as sales.retailCustomerActivity's needs_follow_up column.
    pos: count(`
      SELECT COUNT(*) AS n FROM (
        SELECT customer_id, MAX(created_at) AS last_purchase FROM sales
        WHERE channel = 'POS' AND customer_id IS NOT NULL GROUP BY customer_id
      ) WHERE julianday('now') - julianday(last_purchase) > 30
    `),
  });
});
