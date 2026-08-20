import { db } from '../db/client.js';
import { nextBusinessId } from '../db/ids.js';
import * as activityLog from './activityLog.js';
import * as emptyBottleManagement from './emptyBottleManagement.js';
import * as qualityControl from './qualityControl.js';
import * as dispenserBottles from './dispenserBottles.js';
import * as marketerCustomers from './marketerCustomers.js';
import * as finance from './finance.js';
import * as tillClose from './tillClose.js';

export interface DiscrepancyRecord { id: string; detail: string }
export interface DiscrepancyCheck { category: string; description: string; count: number; records: DiscrepancyRecord[] }
export interface DiscrepancyReport { balanced: boolean; checks: DiscrepancyCheck[] }
export interface AttentionCheck extends DiscrepancyCheck { blocking: boolean }
export interface AttentionReport { balanced: boolean; checks: AttentionCheck[] }
export interface DayClose { id: string; business_date: string; status: 'CLOSED'; checked_by: string | null; actor: string | null; closed_at: string }

function check(category: string, description: string, records: DiscrepancyRecord[]): DiscrepancyCheck {
  return { category, description, count: records.length, records };
}

function attentionCheck(category: string, description: string, records: DiscrepancyRecord[], blocking: boolean): AttentionCheck {
  return { ...check(category, description, records), blocking };
}

/** Every check reads current state, live — nothing is scoped to "today"
 *  (see dayClose plan notes: an old stuck record is more urgent, not less,
 *  once its creation day passes). This IS "must synchronize instantly" —
 *  the report always reflects reality right now. */
export function runDiscrepancyChecks(): DiscrepancyReport {
  const productionOutput = db.prepare(`
    SELECT id, quantity_issued, started_at FROM empty_bottle_runs WHERE status = 'OPEN'
  `).all() as { id: string; quantity_issued: number; started_at: string }[];

  const warehouseReceipt = db.prepare(`
    SELECT id, status, received_at FROM goods_received WHERE status IN ('PENDING_INSPECTION','PARTIALLY_ACCEPTED')
  `).all() as { id: string; status: string; received_at: string }[];

  const warehouseIssues = db.prepare(`
    SELECT id, requested_by, created_at FROM material_requests WHERE status = 'PENDING'
  `).all() as { id: string; requested_by: string | null; created_at: string }[];

  const supplierReturns = db.prepare(`
    SELECT id, supplier_id, created_at FROM supplier_returns WHERE status = 'PENDING'
  `).all() as { id: string; supplier_id: string; created_at: string }[];
  const salesReturnsPending = db.prepare(`
    SELECT id, status, created_at FROM sales_returns WHERE status IN ('PENDING_INSPECTION','PARTIALLY_ACCEPTED')
  `).all() as { id: string; status: string; created_at: string }[];

  const emptyReturns = db.prepare(`
    SELECT id, marketer_id, created_at FROM marketer_returns WHERE status = 'PENDING_VERIFICATION'
  `).all() as { id: string; marketer_id: string; created_at: string }[];

  const finishedGoodsGap = db.prepare(`
    SELECT pb.id, pb.product_item_id, pb.units_actual,
      COALESCE((SELECT SUM(fg.quantity) FROM finished_goods fg WHERE fg.batch_id = pb.id), 0) AS packaged
    FROM production_batches pb
    WHERE pb.status = 'COMPLETED' AND pb.units_actual > COALESCE((SELECT SUM(fg.quantity) FROM finished_goods fg WHERE fg.batch_id = pb.id), 0)
  `).all() as { id: string; product_item_id: string; units_actual: number; packaged: number }[];

  let damagedEmptiesCount = 0;
  let damagedEmptiesDetail = 'No returnable-asset item configured';
  try {
    const summary = emptyBottleManagement.conditionSummary();
    damagedEmptiesCount = summary.damagedEmpty + summary.leakingEmpty;
    damagedEmptiesDetail = `${summary.damagedEmpty} damaged, ${summary.leakingEmpty} leaking — untriaged`;
  } catch {
    // No returnable-asset item exists yet — nothing to reconcile for this category.
    damagedEmptiesCount = 0;
  }

  const pendingGrnQc = qualityControl.pendingGoodsReceived() as { id: string; received_at: string }[];
  const pendingBatchQc = qualityControl.pendingProductionBatches() as { id: string; completed_at: string | null; product_name: string }[];

  const unexplainedBottles = dispenserBottles.marketerWiseReport().filter(r => r.unexplained_missing > 0);

  const overdueCustomerInvoices = marketerCustomers.collectionsReport().filter(r => r.bucket === 'OVERDUE');

  const agedSupplierBalances = finance.agingReport().filter(r => r.d90plus > 0);

  const posSales = db.prepare(`
    SELECT s.id, s.created_at, s.total_amount,
      COALESCE((SELECT SUM(r.amount) FROM receipts r WHERE r.reference_type = 'sales' AND r.reference_id = s.id), 0) AS receipted
    FROM sales s
    WHERE s.channel = 'POS' AND date(s.created_at) = date('now')
  `).all() as { id: string; created_at: string; total_amount: number; receipted: number }[];
  const posMismatches = posSales.filter(s => Math.abs(s.total_amount - s.receipted) > 0.01);

  const checks: DiscrepancyCheck[] = [
    check('Pending GRN', 'Goods received but not yet inspected', warehouseReceipt.map(r => ({
      id: r.id, detail: `${r.status}, received ${r.received_at}`,
    }))),
    check('Pending QC', 'Goods received and production batches awaiting a quality-control verdict', [
      ...pendingGrnQc.map(r => ({ id: r.id, detail: `goods received, received ${r.received_at}` })),
      ...pendingBatchQc.map(r => ({ id: r.id, detail: `production batch, ${r.product_name}, completed ${r.completed_at ?? 'unknown'}` })),
    ]),
    check('Pending Warehouse Verification', 'Marketer stock returns claimed but not yet warehouse-verified', emptyReturns.map(r => ({
      id: r.id, detail: `marketer ${r.marketer_id}, claimed ${r.created_at}`,
    }))),
    check('Outstanding Returns', 'Supplier and sales returns not yet resolved', [
      ...supplierReturns.map(r => ({ id: r.id, detail: `supplier return, ${r.supplier_id}, ${r.created_at}` })),
      ...salesReturnsPending.map(r => ({ id: r.id, detail: `sales return, ${r.status}, ${r.created_at}` })),
    ]),
    check('Outstanding Empty Bottles', 'Dispenser bottles neither returned nor explained by a marketer', unexplainedBottles.map(r => ({
      id: `${r.marketer_id}/${r.item_id}`, detail: `${r.marketer_name}, ${r.unexplained_missing} of ${r.item_name} unexplained`,
    }))),
    check('Outstanding Customer Debts', 'Marketer-customer invoices overdue past their due date', overdueCustomerInvoices.map(r => ({
      id: r.id, detail: `${r.customer_name} (via ${r.marketer_name}), ₦${r.balance.toLocaleString('en-NG')} overdue since ${r.due_date}`,
    }))),
    check('Outstanding Supplier Debts', 'Supplier balances aged 90+ days', agedSupplierBalances.map(r => ({
      id: r.supplierId, detail: `${r.supplierName}, ₦${r.d90plus.toLocaleString('en-NG')} aged 90+ days`,
    }))),
    check('Production Output', 'Empty-bottle production runs pulled from the warehouse but never reconciled', productionOutput.map(r => ({
      id: r.id, detail: `${r.quantity_issued} issued, started ${r.started_at}`,
    }))),
    check('Warehouse Issues', 'Material requests raised but not yet issued or rejected', warehouseIssues.map(r => ({
      id: r.id, detail: `requested by ${r.requested_by ?? 'unknown'} on ${r.created_at}`,
    }))),
    check('Damaged Empties', 'Damaged/leaking bottles not yet triaged to repairable or scrapped', damagedEmptiesCount > 0 ? [{ id: '—', detail: damagedEmptiesDetail }] : []),
    check('Finished Goods', 'Completed production batches not yet fully packaged into finished-goods inventory', finishedGoodsGap.map(r => ({
      id: r.id, detail: `${r.units_actual - r.packaged} of ${r.units_actual} units of ${r.product_item_id} not yet packaged`,
    }))),
    check('POS', "Today's POS sales where receipted payments don't match the sale total", posMismatches.map(r => ({
      id: r.id, detail: `total ₦${r.total_amount.toLocaleString('en-NG')} vs receipted ₦${r.receipted.toLocaleString('en-NG')}`,
    }))),
  ];

  return { balanced: checks.every(c => c.count === 0), checks };
}

/** Section 22: "what requires attention before we close the day?" — every
 *  check runDiscrepancyChecks() already enforces as a hard gate on closing
 *  (blocking: true), plus categories that are worth surfacing but
 *  deliberately don't block the close-day gate itself (blocking: false) —
 *  approvals and deliveries are normal, ongoing business-in-progress, not a
 *  reconciliation failure, so requiring them at zero would make closing the
 *  day impossible on any day with an order still moving through the
 *  pipeline. Nothing here is stored; both halves are computed live, same as
 *  runDiscrepancyChecks(). */
export function attentionList(): AttentionReport {
  const core = runDiscrepancyChecks();
  const blockingChecks: AttentionCheck[] = core.checks.map(c => ({ ...c, blocking: true }));

  const pendingApprovalPOs = db.prepare(`SELECT id, created_at FROM purchase_orders WHERE status = 'AWAITING_APPROVAL'`).all() as { id: string; created_at: string }[];
  const pendingApprovalSales = db.prepare(`SELECT id, created_at FROM sales WHERE status = 'AWAITING_APPROVAL'`).all() as { id: string; created_at: string }[];
  const pendingApprovalUsers = db.prepare(`SELECT id, name FROM users WHERE status = 'PENDING_APPROVAL'`).all() as { id: string; name: string }[];
  const pendingDeletions = db.prepare(`SELECT id, entity_type, entity_label FROM deletion_requests WHERE status = 'PENDING'`).all() as { id: string; entity_type: string; entity_label: string | null }[];

  const undeliveredPOs = db.prepare(`
    SELECT po.id, s.name AS supplier_name FROM purchase_orders po JOIN suppliers s ON s.id = po.supplier_id WHERE po.status = 'APPROVED'
  `).all() as { id: string; supplier_name: string }[];
  const undeliveredRuns = db.prepare(`
    SELECT id, sales_id, status FROM delivery_runs WHERE status IN ('DISPATCHED', 'ACTIVE')
  `).all() as { id: string; sales_id: string; status: string }[];

  // Always 0 today — nothing in this app currently posts a payment/receipt
  // with any status other than the schema default 'CLEARED' — kept as a real
  // check (not hard-coded to always pass) so it's meaningful the moment
  // anything ever does introduce an uncleared/pending state.
  const uncleared = db.prepare(`SELECT id, 'payment' AS kind FROM payments WHERE status != 'CLEARED' UNION ALL SELECT id, 'receipt' FROM receipts WHERE status != 'CLEARED'`).all() as { id: string; kind: string }[];

  const businessDate = today();
  const tillPending = tillClose.isTillClosed(undefined, businessDate) ? [] : [{ id: businessDate, detail: 'Retail Till not yet closed for today' }];

  const companyWideAgedCustomers = finance.customerAgingReport().filter(r => r.d90plus > 0);

  const informational: AttentionCheck[] = [
    attentionCheck('Pending Approvals', 'Purchase orders, sales, user accounts and deletion requests awaiting a decision', [
      ...pendingApprovalPOs.map(r => ({ id: r.id, detail: `purchase order, raised ${r.created_at}` })),
      ...pendingApprovalSales.map(r => ({ id: r.id, detail: `sales order, raised ${r.created_at}` })),
      ...pendingApprovalUsers.map(r => ({ id: r.id, detail: `user account, ${r.name}` })),
      ...pendingDeletions.map(r => ({ id: r.id, detail: `deletion request, ${r.entity_type} ${r.entity_label ?? ''}`.trim() })),
    ], false),
    attentionCheck('Pending Deliveries', 'Approved purchase orders not yet received, and dispatched sales not yet delivered', [
      ...undeliveredPOs.map(r => ({ id: r.id, detail: `approved, awaiting receipt from ${r.supplier_name}` })),
      ...undeliveredRuns.map(r => ({ id: r.id, detail: `delivery for ${r.sales_id}, ${r.status.toLowerCase()}` })),
    ], false),
    attentionCheck('Pending Payments', 'Payments or receipts recorded but not yet cleared', uncleared.map(r => ({ id: r.id, detail: `${r.kind}, not cleared` })), false),
    attentionCheck('Pending Till Close', "Today's till not yet closed", tillPending, false),
    attentionCheck('Outstanding Customer Balances (company-wide)', 'Any customer’s Accounts receivable aged 90+ days, across every channel', companyWideAgedCustomers.map(r => ({
      id: r.customerId, detail: `${r.customerName} (${r.customerType}), ₦${r.d90plus.toLocaleString('en-NG')} aged 90+ days`,
    })), false),
  ];

  return { balanced: core.balanced, checks: [...blockingChecks, ...informational] };
}

export function listDayCloses(): DayClose[] {
  return db.prepare('SELECT * FROM day_closes ORDER BY business_date DESC').all() as unknown as DayClose[];
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

/** Only ever writes when balanced — a blocked attempt persists nothing,
 *  matching validate-then-write everywhere else in this app. Re-closing an
 *  already-closed day is a no-op, not an error. */
export function closeDay(params: { checkedBy: string; actor?: string }): { alreadyClosed: boolean; balanced: boolean; dayClose?: DayClose; checks?: DiscrepancyCheck[] } {
  const businessDate = today();
  const existing = db.prepare('SELECT * FROM day_closes WHERE business_date = ?').get(businessDate) as unknown as DayClose | undefined;
  if (existing) {
    return { alreadyClosed: true, balanced: true, dayClose: existing };
  }

  const report = runDiscrepancyChecks();
  if (!report.balanced) {
    return { alreadyClosed: false, balanced: false, checks: report.checks };
  }

  const actor = params.actor ?? params.checkedBy;
  const id = nextBusinessId('day_closes', 'DC-', 4);
  db.prepare('INSERT INTO day_closes (id, business_date, checked_by, actor) VALUES (?,?,?,?)').run(id, businessDate, params.checkedBy, actor);
  activityLog.record(actor, 'closed business day', 'day_close', id, `${businessDate} closed by ${params.checkedBy} — all checks balanced`);

  const dayClose = db.prepare('SELECT * FROM day_closes WHERE id = ?').get(id) as unknown as DayClose;
  return { alreadyClosed: false, balanced: true, dayClose };
}
