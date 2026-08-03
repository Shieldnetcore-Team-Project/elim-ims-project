import { db } from '../db/client.js';
import { nextBusinessId } from '../db/ids.js';
import * as activityLog from './activityLog.js';
import * as sales from './sales.js';

export interface DistributorBranch {
  id: string; company_id: string; name: string; location: string | null;
  contact_phone: string | null; status: 'ACTIVE' | 'INACTIVE'; created_at: string;
}
export interface BranchBalance { invoiced: number; paid: number; outstanding: number }
export interface BranchInvoice {
  id: string; manual_invoice_number: string | null; created_at: string; status: string;
  products: string; value: number; balance: number; vehicle_id: string | null; driver: string | null;
}

function assertDistributor(companyId: string) {
  const customer = sales.getCustomer(companyId);
  if (!customer) throw new Error(`Unknown customer ${companyId}`);
  if (customer.customer_type !== 'DISTRIBUTOR') throw new Error(`${companyId} is not a Distributor (${customer.customer_type})`);
  return customer;
}

export function createBranch(params: {
  companyId: string; name: string; location?: string; contactPhone?: string; actor?: string;
}): DistributorBranch {
  assertDistributor(params.companyId);
  const id = nextBusinessId('distributor_branches', 'BR-', 4);
  db.prepare('INSERT INTO distributor_branches (id, company_id, name, location, contact_phone) VALUES (?,?,?,?,?)')
    .run(id, params.companyId, params.name, params.location ?? null, params.contactPhone ?? null);
  activityLog.record(params.actor ?? 'System Administrator', 'added branch for', 'distributor', params.companyId, `${id}: ${params.name}`);
  return getBranch(id)!;
}

export function updateBranch(id: string, patch: {
  name?: string; location?: string; contactPhone?: string; status?: 'ACTIVE' | 'INACTIVE';
}, actor?: string): DistributorBranch {
  const existing = getBranch(id);
  if (!existing) throw new Error(`Unknown branch ${id}`);
  db.prepare('UPDATE distributor_branches SET name = ?, location = ?, contact_phone = ?, status = ? WHERE id = ?').run(
    patch.name ?? existing.name, patch.location ?? existing.location, patch.contactPhone ?? existing.contact_phone,
    patch.status ?? existing.status, id,
  );
  activityLog.record(actor ?? 'System Administrator', 'updated branch', 'distributor_branch', id, `${id} profile updated`);
  return getBranch(id)!;
}

export function getBranch(id: string): DistributorBranch | undefined {
  return db.prepare('SELECT * FROM distributor_branches WHERE id = ?').get(id) as DistributorBranch | undefined;
}

export function listBranches(companyId?: string): (DistributorBranch & { outstanding: number })[] {
  const rows = (companyId
    ? db.prepare('SELECT * FROM distributor_branches WHERE company_id = ? ORDER BY name').all(companyId)
    : db.prepare('SELECT * FROM distributor_branches ORDER BY name').all()) as unknown as DistributorBranch[];
  return rows.map(b => ({ ...b, outstanding: branchBalance(b.id).outstanding }));
}

/** invoiced/paid/outstanding for one branch — same debit=invoiced/credit=paid
 *  convention as finance.customerBalance, scoped to ledger.branch_id instead
 *  of customer_id (the same row carries both tags, see finance.postLedger). */
export function branchBalance(branchId: string): BranchBalance {
  const row = db.prepare(
    `SELECT COALESCE(SUM(debit), 0) AS invoiced, COALESCE(SUM(credit), 0) AS paid
     FROM ledger WHERE branch_id = ? AND account = 'Accounts receivable'`,
  ).get(branchId) as { invoiced: number; paid: number };
  return { invoiced: row.invoiced, paid: row.paid, outstanding: row.invoiced - row.paid };
}

/** manual_invoice_number (Module 12) is joined in from the sales order the
 *  ledger row references, so a printed statement is cross-referenceable by
 *  either the ERP invoice id (this row's own reference_id) or the paper
 *  invoice number, with no separate lookup needed. */
export function branchStatement(branchId: string) {
  return db.prepare(`
    SELECT l.id, l.entry_date, l.debit, l.credit, l.description, l.reference_id, s.manual_invoice_number,
      SUM(l.debit - l.credit) OVER (ORDER BY l.entry_date, l.id) AS running_balance
    FROM ledger l
    LEFT JOIN sales s ON s.id = l.reference_id
    WHERE l.branch_id = ? AND l.account = 'Accounts receivable'
    ORDER BY l.entry_date, l.id
  `).all(branchId);
}

/** One row per sales order placed against this branch — ERP invoice number
 *  (sales.id) / manual invoice number / products / value / balance (the same
 *  reference_id-scoped derivation Module 10 uses for marketer-customer
 *  invoices) / vehicle+driver LEFT JOINed live from delivery_runs (null
 *  until dispatched — never duplicated onto the order itself). */
export function branchInvoices(branchId: string): BranchInvoice[] {
  const orders = db.prepare(
    `SELECT id, manual_invoice_number, created_at, status, total_amount FROM sales WHERE branch_id = ? ORDER BY id DESC`,
  ).all(branchId) as { id: string; manual_invoice_number: string | null; created_at: string; status: string; total_amount: number }[];

  return orders.map(o => {
    const items = db.prepare(
      `SELECT i.name FROM sales_items si JOIN items i ON i.id = si.item_id WHERE si.sales_id = ?`,
    ).all(o.id) as { name: string }[];
    const paid = (db.prepare(
      `SELECT COALESCE(SUM(credit), 0) AS v FROM ledger WHERE reference_id = ? AND account = 'Accounts receivable'`,
    ).get(o.id) as { v: number }).v;
    const dispatch = db.prepare(
      `SELECT vehicle_id, driver FROM delivery_runs WHERE sales_id = ? ORDER BY id DESC LIMIT 1`,
    ).get(o.id) as { vehicle_id: string; driver: string | null } | undefined;

    return {
      id: o.id, manual_invoice_number: o.manual_invoice_number, created_at: o.created_at, status: o.status,
      products: items.map(it => it.name).join(', '), value: o.total_amount, balance: o.total_amount - paid,
      vehicle_id: dispatch?.vehicle_id ?? null, driver: dispatch?.driver ?? null,
    };
  });
}
