import { Router } from 'express';
import * as posReceipts from '../services/posReceipts.js';
import { safe } from '../lib/errors.js';

export const posReceiptsRouter = Router();

posReceiptsRouter.get('/:salesId', safe((req, res) => {
  res.json(posReceipts.getReceipt(req.params.salesId));
}));

posReceiptsRouter.post('/:salesId/print', safe((req, res) => {
  const { actor, documentType, overrideUserId, reason } = req.body ?? {};
  res.status(201).json(posReceipts.recordPrint({ salesId: req.params.salesId, actor: actor ?? 'System Administrator', documentType, overrideUserId, reason }));
}));
