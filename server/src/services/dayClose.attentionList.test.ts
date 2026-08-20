import { describe, it, expect, beforeAll } from 'vitest';
import { ensureMigrated, makeItem, makeSupplier } from '../test/fixtures.js';
import * as procurement from './procurement.js';
import * as dayClose from './dayClose.js';

beforeAll(() => ensureMigrated());

describe('dayClose.attentionList (Section 22 — business reconciliation dashboard)', () => {
  it('includes every blocking check plus informational-only categories, without changing balanced', () => {
    const core = dayClose.runDiscrepancyChecks();
    const attention = dayClose.attentionList();

    expect(attention.balanced).toBe(core.balanced);
    expect(attention.checks.filter(c => c.blocking)).toHaveLength(core.checks.length);
    const categories = attention.checks.map(c => c.category);
    expect(categories).toContain('Pending Approvals');
    expect(categories).toContain('Pending Deliveries');
    expect(categories).toContain('Pending Payments');
    expect(categories).toContain('Pending Till Close');
  });

  it('surfaces an AWAITING_APPROVAL purchase order under Pending Approvals without blocking the day-close gate', () => {
    const itemId = makeItem({ type: 'RAW_MATERIAL' });
    const supplierId = makeSupplier();
    const po = procurement.createPurchaseOrder({ supplierId, requestedBy: 'Test Officer', items: [{ itemId, quantity: 5, unitPrice: 10 }] });

    const attention = dayClose.attentionList();
    const pendingApprovals = attention.checks.find(c => c.category === 'Pending Approvals')!;
    expect(pendingApprovals.blocking).toBe(false);
    expect(pendingApprovals.records.some(r => r.id === po.id)).toBe(true);
  });
});
