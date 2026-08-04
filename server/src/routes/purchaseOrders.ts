import { Router } from 'express';
import * as procurement from '../services/procurement.js';
import * as deletionRequests from '../services/deletionRequests.js';
import * as accessControl from '../services/accessControl.js';
import { safe } from '../lib/errors.js';

export const purchaseOrdersRouter = Router();

purchaseOrdersRouter.get('/', (_req, res) => res.json(deletionRequests.filterDeleted('purchase_orders', procurement.listPurchaseOrders())));
purchaseOrdersRouter.get('/awaiting-receipt', (_req, res) => res.json(deletionRequests.filterDeleted('purchase_orders', procurement.awaitingReceipt())));

purchaseOrdersRouter.get('/:id', (req, res) => {
  const po = procurement.getPurchaseOrder(req.params.id);
  if (!po) return res.status(404).json({ error: 'Not found' });
  res.json({ ...po, items: procurement.listPurchaseOrderItems(req.params.id) });
});

purchaseOrdersRouter.post('/', safe((req, res) => {
  const { supplierId, requestedBy, items } = req.body ?? {};
  if (!supplierId || !requestedBy || !Array.isArray(items) || items.length === 0) {
    res.status(400).json({ error: 'supplierId, requestedBy and at least one item are required' });
    return;
  }
  res.status(201).json(procurement.createPurchaseOrder({ supplierId, requestedBy, items }));
}));

// The only two statuses ever set through this endpoint (see ProcurementPage's
// approve()) — both are the approval decision, so both require the separate
// "procurement-approve" capability, distinct from ordinary procurement page
// access, so the person who raised the PO can't also approve their own.
const APPROVAL_STATUSES = new Set(['APPROVED', 'REJECTED']);

purchaseOrdersRouter.put('/:id/status', safe((req, res) => {
  const { status, actor, userId } = req.body ?? {};
  if (APPROVAL_STATUSES.has(status)) {
    accessControl.requirePageAccess(userId, 'procurement-approve', 'Procurement approvals');
  }
  const updated = procurement.setStatus(req.params.id, status, actor);
  if (!updated) { res.status(404).json({ error: 'Not found' }); return; }
  res.json(updated);
}));
