import { Router } from 'express';
import * as procurement from '../services/procurement.js';
import * as deletionRequests from '../services/deletionRequests.js';
import * as accessControl from '../services/accessControl.js';
import { safe } from '../lib/errors.js';

export const purchaseOrdersRouter = Router();

purchaseOrdersRouter.get('/', safe(async (_req, res) => {
  res.json(await deletionRequests.filterDeleted('purchase_orders', await procurement.listPurchaseOrders()));
}));
purchaseOrdersRouter.get('/awaiting-receipt', safe(async (_req, res) => {
  res.json(await deletionRequests.filterDeleted('purchase_orders', await procurement.awaitingReceipt()));
}));

purchaseOrdersRouter.get('/:id', safe(async (req, res) => {
  const po = await procurement.getPurchaseOrder(req.params.id);
  if (!po) return void res.status(404).json({ error: 'Not found' });
  res.json({ ...po, items: await procurement.listPurchaseOrderItems(req.params.id) });
}));

purchaseOrdersRouter.post('/', safe(async (req, res) => {
  const { supplierId, requestedBy, requestedByUserId, items } = req.body ?? {};
  if (!supplierId || !requestedBy || !Array.isArray(items) || items.length === 0) {
    res.status(400).json({ error: 'supplierId, requestedBy and at least one item are required' });
    return;
  }
  res.status(201).json(await procurement.createPurchaseOrder({ supplierId, requestedBy, requestedByUserId, items }));
}));

purchaseOrdersRouter.put('/:id/items/:itemId/price', safe(async (req, res) => {
  const { unitPrice, reason, actor, userId } = req.body ?? {};
  if (typeof unitPrice !== 'number' || !reason) {
    res.status(400).json({ error: 'unitPrice and reason are required' });
    return;
  }
  // The same dual-control capability as approving/rejecting — a price
  // adjustment is a review action, not something the requester should be
  // able to do unilaterally on their own PO either.
  await accessControl.requirePageAccess(userId, 'procurement-approve', 'Procurement approvals');
  res.json(await procurement.adjustLinePrice(req.params.id, req.params.itemId, unitPrice, { reason, actor: actor ?? 'System Administrator' }));
}));

// The only two statuses ever set through this endpoint (see ProcurementPage's
// approve()) — both are the approval decision, so both require the separate
// "procurement-approve" capability, distinct from ordinary procurement page
// access, so the person who raised the PO can't also approve their own.
const APPROVAL_STATUSES = new Set(['APPROVED', 'REJECTED']);

purchaseOrdersRouter.put('/:id/status', safe(async (req, res) => {
  const { status, actor, userId } = req.body ?? {};
  if (APPROVAL_STATUSES.has(status)) {
    await accessControl.requirePageAccess(userId, 'procurement-approve', 'Procurement approvals');
    // Segregation of duties, enforced server-side rather than left to
    // whoever happens to hold the capability grant: the Procurement Officer
    // who raised this PO can't also be its Procurement Manager review, even
    // if they were separately granted approval access. System admin is the
    // one exception, same as every other access check in this app.
    const po = await procurement.getPurchaseOrder(req.params.id);
    if (po?.requested_by_user_id && userId && po.requested_by_user_id === userId) {
      const approver = await accessControl.getUser(userId);
      if (!approver || !accessControl.isSuperAdminRole(approver.role)) {
        res.status(403).json({ error: 'You raised this purchase order — a different Procurement Manager must review it' });
        return;
      }
    }
  }
  const updated = await procurement.setStatus(req.params.id, status, actor);
  if (!updated) { res.status(404).json({ error: 'Not found' }); return; }
  res.json(updated);
}));
