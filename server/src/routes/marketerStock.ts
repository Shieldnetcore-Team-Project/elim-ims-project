import { Router } from 'express';
import * as marketerStock from '../services/marketerStock.js';
import { safe } from '../lib/errors.js';

export const marketerStockRouter = Router();

marketerStockRouter.get('/:marketerId/balances', safe(async (req, res) => {
  res.json(await marketerStock.listBalances(req.params.marketerId));
}));

marketerStockRouter.get('/:marketerId/statement', safe(async (req, res) => {
  const date = typeof req.query.date === 'string' ? req.query.date : undefined;
  res.json(await marketerStock.dailyStatement(req.params.marketerId, date));
}));

marketerStockRouter.get('/:marketerId/pending-verification', safe(async (req, res) => {
  res.json(await marketerStock.pendingVerification(req.params.marketerId));
}));

marketerStockRouter.get('/:marketerId/pending-assignments', safe(async (req, res) => {
  res.json(await marketerStock.pendingAssignments(req.params.marketerId));
}));

marketerStockRouter.get('/:marketerId/assignments', safe(async (req, res) => {
  res.json(await marketerStock.listAssignments(req.params.marketerId));
}));

marketerStockRouter.get('/assignments/:id', safe(async (req, res) => {
  const a = await marketerStock.getAssignment(req.params.id);
  if (!a) { res.status(404).json({ error: 'Not found' }); return; }
  res.json({ ...a, items: await marketerStock.listAssignmentItems(req.params.id) });
}));

marketerStockRouter.post('/assignments/:id/verify', safe(async (req, res) => {
  const { verifiedBy, actor } = req.body ?? {};
  if (!verifiedBy) {
    res.status(400).json({ error: 'verifiedBy is required' });
    return;
  }
  res.json(await marketerStock.verifyAssignment(req.params.id, { verifiedBy, actor }));
}));

marketerStockRouter.get('/returns', safe(async (_req, res) => {
  res.json(await marketerStock.listReturns());
}));

marketerStockRouter.get('/returns/:id', safe(async (req, res) => {
  const ret = await marketerStock.getReturn(req.params.id);
  if (!ret) { res.status(404).json({ error: 'Not found' }); return; }
  res.json({ ...ret, items: await marketerStock.listReturnItems(req.params.id) });
}));

marketerStockRouter.post('/returns/:id/verify', safe(async (req, res) => {
  const { verifiedBy, lines, actor } = req.body ?? {};
  if (!verifiedBy || !Array.isArray(lines) || lines.length === 0) {
    res.status(400).json({ error: 'verifiedBy and at least one line are required' });
    return;
  }
  res.json(await marketerStock.verifyReturn(req.params.id, { verifiedBy, lines, actor }));
}));

marketerStockRouter.post('/issue', safe(async (req, res) => {
  const { marketerId, items, issuedBy, actor, overrideUserId } = req.body ?? {};
  if (!marketerId || !Array.isArray(items) || items.length === 0 || !issuedBy) {
    res.status(400).json({ error: 'marketerId, issuedBy and at least one item are required' });
    return;
  }
  res.status(201).json(await marketerStock.issueStock({ marketerId, items, issuedBy, actor, overrideUserId }));
}));

marketerStockRouter.post('/returns', safe(async (req, res) => {
  const { marketerId, items, actor } = req.body ?? {};
  if (!marketerId || !Array.isArray(items) || items.length === 0) {
    res.status(400).json({ error: 'marketerId and at least one item are required' });
    return;
  }
  res.status(201).json(await marketerStock.recordReturn({ marketerId, items, actor: actor ?? 'System Administrator' }));
}));

marketerStockRouter.post('/sales', safe(async (req, res) => {
  const { marketerId, items, cashReceived, actor } = req.body ?? {};
  if (!marketerId || !Array.isArray(items) || items.length === 0) {
    res.status(400).json({ error: 'marketerId and at least one item are required' });
    return;
  }
  res.status(201).json(await marketerStock.recordSale({ marketerId, items, cashReceived: Number(cashReceived) || 0, actor: actor ?? 'System Administrator' }));
}));
