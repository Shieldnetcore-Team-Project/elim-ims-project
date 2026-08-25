import { db } from '../db/client.js';
import * as inventory from './inventory.js';
import * as vehicleDocuments from './vehicleDocuments.js';
import * as marketerCustomers from './marketerCustomers.js';
import * as finance from './finance.js';
import * as marketerReconciliation from './marketerReconciliation.js';
import * as qualityControl from './qualityControl.js';
import * as tillClose from './tillClose.js';

export type NotificationCategory =
  | 'LOW_STOCK' | 'DOCUMENT_EXPIRY' | 'PENDING_APPROVAL' | 'PENDING_RECONCILIATION'
  | 'PENDING_RETURN' | 'OUTSTANDING_CREDIT' | 'OVERDUE_CREDIT' | 'PENDING_DELIVERY'
  | 'PAYROLL_APPROVAL' | 'MAINTENANCE_DUE' | 'UNCLOSED_TILL' | 'QUALITY_TEST_PENDING';

export type NotificationSeverity = 'INFO' | 'WARNING' | 'CRITICAL';

export interface NotificationItem {
  id: string;
  category: NotificationCategory;
  /** Module nav key (see shared/src/moduleConfig.ts MODULES) — used to filter
   *  by the viewer's page permissions, same gate as the sidebar/routes use. */
  pageKey: string;
  severity: NotificationSeverity;
  title: string;
  detail: string;
}

export const NOTIFICATION_CATEGORY_LABELS: Record<NotificationCategory, string> = {
  LOW_STOCK: 'Low Stock',
  DOCUMENT_EXPIRY: 'Document Expiry',
  PENDING_APPROVAL: 'Pending Approval',
  PENDING_RECONCILIATION: 'Pending Reconciliation',
  PENDING_RETURN: 'Pending Return',
  OUTSTANDING_CREDIT: 'Outstanding Credit',
  OVERDUE_CREDIT: 'Overdue Credit',
  PENDING_DELIVERY: 'Pending Delivery',
  PAYROLL_APPROVAL: 'Payroll Approval',
  MAINTENANCE_DUE: 'Maintenance Due',
  UNCLOSED_TILL: 'Unclosed Till',
  QUALITY_TEST_PENDING: 'Quality Test Pending',
};

async function lowStock(): Promise<NotificationItem[]> {
  return (await inventory.getBalances())
    .filter(i => i.reorder_point > 0 && i.on_hand <= i.reorder_point)
    .map(i => ({
      id: `LOW_STOCK-${i.id}`, category: 'LOW_STOCK' as const, pageKey: 'inventory',
      severity: (i.on_hand <= 0 ? 'CRITICAL' : 'WARNING') as NotificationSeverity,
      title: i.name,
      detail: `${i.on_hand} ${i.uom} on hand, reorder at ${i.reorder_point}`,
    }));
}

async function documentExpiry(): Promise<NotificationItem[]> {
  return (await vehicleDocuments.upcomingExpiries()).map(a => ({
    id: `DOCUMENT_EXPIRY-${a.id}`, category: 'DOCUMENT_EXPIRY' as const, pageKey: 'fleet',
    severity: (a.expired ? 'CRITICAL' : 'WARNING') as NotificationSeverity,
    title: `${a.document_type} — ${a.vehicle_plate_number ?? a.vehicle_id}`,
    detail: a.expired ? `Expired ${Math.abs(a.days_until_expiry)} day(s) ago` : `Expires in ${a.days_until_expiry} day(s)`,
  }));
}

async function pendingApproval(): Promise<NotificationItem[]> {
  const pos = await db.prepare(`SELECT id, created_at FROM purchase_orders WHERE status = 'AWAITING_APPROVAL'`).all() as { id: string; created_at: string }[];
  const sales = await db.prepare(`SELECT id, created_at FROM sales WHERE status = 'AWAITING_APPROVAL'`).all() as { id: string; created_at: string }[];
  const users = await db.prepare(`SELECT id, name FROM users WHERE status = 'PENDING_APPROVAL'`).all() as { id: string; name: string }[];
  const deletions = await db.prepare(`SELECT id, entity_type, entity_label FROM deletion_requests WHERE status = 'PENDING'`).all() as { id: string; entity_type: string; entity_label: string | null }[];

  return [
    ...pos.map(r => ({ id: `PENDING_APPROVAL-po-${r.id}`, category: 'PENDING_APPROVAL' as const, pageKey: 'procurement', severity: 'WARNING' as const, title: `Purchase order ${r.id}`, detail: `Raised ${r.created_at}` })),
    ...sales.map(r => ({ id: `PENDING_APPROVAL-sale-${r.id}`, category: 'PENDING_APPROVAL' as const, pageKey: 'sales', severity: 'WARNING' as const, title: `Sales order ${r.id}`, detail: `Raised ${r.created_at}` })),
    ...users.map(r => ({ id: `PENDING_APPROVAL-user-${r.id}`, category: 'PENDING_APPROVAL' as const, pageKey: 'users', severity: 'WARNING' as const, title: `New user: ${r.name}`, detail: 'Awaiting account approval' })),
    ...deletions.map(r => ({ id: `PENDING_APPROVAL-del-${r.id}`, category: 'PENDING_APPROVAL' as const, pageKey: 'delete-requests', severity: 'WARNING' as const, title: `Deletion request: ${r.entity_type}`, detail: r.entity_label ?? r.id })),
  ];
}

async function pendingReconciliation(): Promise<NotificationItem[]> {
  return (await marketerReconciliation.reconciliation())
    .filter(l => l.status === 'PENDING_VERIFICATION' || l.status === 'PENDING_RETURN')
    .map(l => ({
      id: `PENDING_RECONCILIATION-${l.marketer_id}-${l.item_id}`, category: 'PENDING_RECONCILIATION' as const, pageKey: 'sales',
      severity: 'WARNING' as const,
      title: `${l.marketer_name} — ${l.item_name}`,
      detail: l.status === 'PENDING_VERIFICATION' ? `${l.pending_assignment} pending warehouse verification` : `${l.pending_return} claimed return not yet counted back in`,
    }));
}

async function pendingReturn(): Promise<NotificationItem[]> {
  const supplierReturns = await db.prepare(`SELECT id, supplier_id, created_at FROM supplier_returns WHERE status = 'PENDING'`).all() as { id: string; supplier_id: string; created_at: string }[];
  const salesReturns = await db.prepare(`SELECT id, status, created_at FROM sales_returns WHERE status IN ('PENDING_INSPECTION','PARTIALLY_ACCEPTED')`).all() as { id: string; status: string; created_at: string }[];
  return [
    ...supplierReturns.map(r => ({ id: `PENDING_RETURN-sup-${r.id}`, category: 'PENDING_RETURN' as const, pageKey: 'procurement', severity: 'WARNING' as const, title: `Supplier return ${r.id}`, detail: `Raised ${r.created_at}` })),
    ...salesReturns.map(r => ({ id: `PENDING_RETURN-sale-${r.id}`, category: 'PENDING_RETURN' as const, pageKey: 'sales', severity: 'WARNING' as const, title: `Sales return ${r.id}`, detail: `${r.status}, raised ${r.created_at}` })),
  ];
}

async function credit(): Promise<{ outstanding: NotificationItem[]; overdue: NotificationItem[] }> {
  const marketerRows = await marketerCustomers.collectionsReport();
  const companyRows = (await finance.customerAgingReport()).filter(r => r.total > 0);

  const outstanding: NotificationItem[] = [
    ...marketerRows.map(r => ({
      id: `OUTSTANDING_CREDIT-mkt-${r.id}`, category: 'OUTSTANDING_CREDIT' as const, pageKey: 'sales', severity: 'INFO' as const,
      title: r.customer_name, detail: `₦${r.balance.toLocaleString('en-NG')} outstanding via ${r.marketer_name}`,
    })),
    ...companyRows.map(r => ({
      id: `OUTSTANDING_CREDIT-co-${r.customerId}`, category: 'OUTSTANDING_CREDIT' as const, pageKey: 'finance', severity: 'INFO' as const,
      title: r.customerName, detail: `₦${r.total.toLocaleString('en-NG')} outstanding (${r.customerType})`,
    })),
  ];

  const overdue: NotificationItem[] = [
    ...marketerRows.filter(r => r.bucket === 'OVERDUE').map(r => ({
      id: `OVERDUE_CREDIT-mkt-${r.id}`, category: 'OVERDUE_CREDIT' as const, pageKey: 'sales', severity: 'CRITICAL' as const,
      title: r.customer_name, detail: `₦${r.balance.toLocaleString('en-NG')} overdue since ${r.due_date} (via ${r.marketer_name})`,
    })),
    ...companyRows.filter(r => r.d90plus > 0).map(r => ({
      id: `OVERDUE_CREDIT-co-${r.customerId}`, category: 'OVERDUE_CREDIT' as const, pageKey: 'finance', severity: 'CRITICAL' as const,
      title: r.customerName, detail: `₦${r.d90plus.toLocaleString('en-NG')} aged 90+ days (${r.customerType})`,
    })),
  ];

  return { outstanding, overdue };
}

async function pendingDelivery(): Promise<NotificationItem[]> {
  const pos = await db.prepare(`
    SELECT po.id, s.name AS supplier_name FROM purchase_orders po JOIN suppliers s ON s.id = po.supplier_id WHERE po.status = 'APPROVED'
  `).all() as { id: string; supplier_name: string }[];
  const runs = await db.prepare(`SELECT id, sales_id, status FROM delivery_runs WHERE status IN ('DISPATCHED', 'ACTIVE')`).all() as { id: string; sales_id: string; status: string }[];
  return [
    ...pos.map(r => ({ id: `PENDING_DELIVERY-po-${r.id}`, category: 'PENDING_DELIVERY' as const, pageKey: 'procurement', severity: 'INFO' as const, title: `Purchase order ${r.id}`, detail: `Approved, awaiting receipt from ${r.supplier_name}` })),
    ...runs.map(r => ({ id: `PENDING_DELIVERY-run-${r.id}`, category: 'PENDING_DELIVERY' as const, pageKey: 'fleet', severity: 'INFO' as const, title: `Delivery ${r.id}`, detail: `${r.status.toLowerCase()} — for ${r.sales_id}` })),
  ];
}

async function payrollApproval(): Promise<NotificationItem[]> {
  const rows = await db.prepare(`SELECT id, staff_name, period FROM payroll_runs WHERE status = 'AWAITING_APPROVAL'`).all() as { id: string; staff_name: string; period: string }[];
  return rows.map(r => ({
    id: `PAYROLL_APPROVAL-${r.id}`, category: 'PAYROLL_APPROVAL' as const, pageKey: 'payroll', severity: 'WARNING' as const,
    title: `${r.staff_name} — ${r.period}`, detail: 'Payroll run awaiting approval',
  }));
}

/** SQLite's julianday() has no Postgres equivalent — next_due is a plain
 *  'YYYY-MM-DD' TEXT column (see schema.ts), so date - CURRENT_DATE already
 *  gives an exact integer day count. */
async function maintenanceDue(): Promise<NotificationItem[]> {
  const rows = await db.prepare(`
    SELECT id, equipment, next_due FROM assets
    WHERE next_due IS NOT NULL AND status != 'SUSPENDED' AND (next_due::date - CURRENT_DATE) <= 7
    ORDER BY next_due
  `).all() as { id: string; equipment: string; next_due: string }[];
  return rows.map(r => {
    const daysUntil = Math.ceil((new Date(r.next_due).getTime() - Date.now()) / 86_400_000);
    return {
      id: `MAINTENANCE_DUE-${r.id}`, category: 'MAINTENANCE_DUE' as const, pageKey: 'assets',
      severity: (daysUntil < 0 ? 'CRITICAL' : 'WARNING') as NotificationSeverity,
      title: r.equipment,
      detail: daysUntil < 0 ? `Service overdue by ${Math.abs(daysUntil)} day(s)` : `Service due in ${daysUntil} day(s)`,
    };
  });
}

async function unclosedTill(): Promise<NotificationItem[]> {
  if (await tillClose.isTillClosed()) return [];
  const businessDate = new Date().toISOString().slice(0, 10);
  return [{ id: `UNCLOSED_TILL-${businessDate}`, category: 'UNCLOSED_TILL', pageKey: 'pos', severity: 'WARNING', title: "Today's till not closed", detail: businessDate }];
}

async function qualityTestPending(): Promise<NotificationItem[]> {
  const grn = await qualityControl.pendingGoodsReceived() as { id: string; received_at: string }[];
  const batches = await qualityControl.pendingProductionBatches() as { id: string; completed_at: string | null; product_name: string }[];
  return [
    ...grn.map(r => ({ id: `QUALITY_TEST_PENDING-grn-${r.id}`, category: 'QUALITY_TEST_PENDING' as const, pageKey: 'quality-control', severity: 'WARNING' as const, title: `Goods received ${r.id}`, detail: `Received ${r.received_at}, awaiting QC` })),
    ...batches.map(r => ({ id: `QUALITY_TEST_PENDING-batch-${r.id}`, category: 'QUALITY_TEST_PENDING' as const, pageKey: 'quality-control', severity: 'WARNING' as const, title: `Batch ${r.id} — ${r.product_name}`, detail: `Completed ${r.completed_at ?? 'unknown'}, awaiting QC` })),
  ];
}

/** Every category read live, same principle as dayClose.runDiscrepancyChecks —
 *  nothing here is stored, so it can never drift from reality. Callers filter
 *  by pageKey against the viewer's allowed pages (see client useCurrentUser
 *  .hasAccess), same permission gate the sidebar/routes already use. */
export async function allNotifications(): Promise<NotificationItem[]> {
  const { outstanding, overdue } = await credit();
  return [
    ...(await lowStock()),
    ...(await documentExpiry()),
    ...(await pendingApproval()),
    ...(await pendingReconciliation()),
    ...(await pendingReturn()),
    ...outstanding,
    ...overdue,
    ...(await pendingDelivery()),
    ...(await payrollApproval()),
    ...(await maintenanceDue()),
    ...(await unclosedTill()),
    ...(await qualityTestPending()),
  ];
}
