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
  // Same as the approval decision below — a price adjustment is a review
  // action, not something the Procurement officer who raised the PO should
  // be able to do unilaterally on their own order.
  await accessControl.requireSuperAdmin(userId, 'adjust a purchase order price');
  res.json(await procurement.adjustLinePrice(req.params.id, req.params.itemId, unitPrice, { reason, actor: actor ?? 'System Administrator' }));
}));

// The only two statuses ever set through this endpoint (see ProcurementPage's
// approve()) — both are the approval decision, restricted to System admin so
// every purchase order Procurement raises is reviewed by a Super Admin.
const APPROVAL_STATUSES = new Set(['APPROVED', 'REJECTED']);

purchaseOrdersRouter.put('/:id/status', safe(async (req, res) => {
  const { status, actor, userId } = req.body ?? {};
  if (APPROVAL_STATUSES.has(status)) {
    await accessControl.requireSuperAdmin(userId, 'approve or reject a purchase order');
  }
  const updated = await procurement.setStatus(req.params.id, status, actor);
  if (!updated) { res.status(404).json({ error: 'Not found' }); return; }
  res.json(updated);
}));
