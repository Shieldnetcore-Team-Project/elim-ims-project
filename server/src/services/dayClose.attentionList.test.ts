import { describe, it, expect, beforeAll } from 'vitest';
import { ensureMigrated, makeItem, makeSupplier } from '../test/fixtures.js';
import * as procurement from './procurement.js';
import * as dayClose from './dayClose.js';

beforeAll(async () => { await ensureMigrated(); });

describe('dayClose.attentionList (Section 22 — business reconciliation dashboard)', () => {
  it('includes every blocking check plus informational-only categories, without changing balanced', async () => {
    const core = await dayClose.runDiscrepancyChecks();
    const attention = await dayClose.attentionList();

    expect(attention.balanced).toBe(core.balanced);
    expect(attention.checks.filter(c => c.blocking)).toHaveLength(core.checks.length);
    const categories = attention.checks.map(c => c.category);
    expect(categories).toContain('Pending Approvals');
    expect(categories).toContain('Pending Deliveries');
    expect(categories).toContain('Pending Payments');
    expect(categories).toContain('Pending Till Close');
  });

  it('surfaces an AWAITING_APPROVAL purchase order under Pending Approvals without blocking the day-close gate', async () => {
    const itemId = await makeItem({ type: 'RAW_MATERIAL' });
    const supplierId = await makeSupplier();
    const po = await procurement.createPurchaseOrder({ supplierId, requestedBy: 'Test Officer', items: [{ itemId, quantity: 5, unitPrice: 10 }] });

    const attention = await dayClose.attentionList();
    const pendingApprovals = attention.checks.find(c => c.category === 'Pending Approvals')!;
    expect(pendingApprovals.blocking).toBe(false);
    expect(pendingApprovals.records.some(r => r.id === po.id)).toBe(true);
  });
});
