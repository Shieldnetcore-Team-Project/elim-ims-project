import { Router } from 'express';
import * as procurement from '../services/procurement.js';
import * as deletionRequests from '../services/deletionRequests.js';
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

purchaseOrdersRouter.put('/:id/status', safe((req, res) => {
  const updated = procurement.setStatus(req.params.id, req.body?.status, req.body?.actor);
  if (!updated) { res.status(404).json({ error: 'Not found' }); return; }
  res.json(updated);
}));
