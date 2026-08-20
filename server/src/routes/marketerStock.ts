import { Router } from 'express';
import * as marketerStock from '../services/marketerStock.js';
import { safe } from '../lib/errors.js';

export const marketerStockRouter = Router();

marketerStockRouter.get('/:marketerId/balances', safe((req, res) => {
  res.json(marketerStock.listBalances(req.params.marketerId));
}));

marketerStockRouter.get('/:marketerId/statement', safe((req, res) => {
  const date = typeof req.query.date === 'string' ? req.query.date : undefined;
  res.json(marketerStock.dailyStatement(req.params.marketerId, date));
}));

marketerStockRouter.get('/:marketerId/pending-verification', safe((req, res) => {
  res.json(marketerStock.pendingVerification(req.params.marketerId));
}));

marketerStockRouter.get('/:marketerId/pending-assignments', safe((req, res) => {
  res.json(marketerStock.pendingAssignments(req.params.marketerId));
}));

marketerStockRouter.get('/:marketerId/assignments', safe((req, res) => {
  res.json(marketerStock.listAssignments(req.params.marketerId));
}));

marketerStockRouter.get('/assignments/:id', safe((req, res) => {
  const a = marketerStock.getAssignment(req.params.id);
  if (!a) return res.status(404).json({ error: 'Not found' });
  res.json({ ...a, items: marketerStock.listAssignmentItems(req.params.id) });
}));

marketerStockRouter.post('/assignments/:id/verify', safe((req, res) => {
  const { verifiedBy, actor } = req.body ?? {};
  if (!verifiedBy) {
    res.status(400).json({ error: 'verifiedBy is required' });
    return;
  }
  res.json(marketerStock.verifyAssignment(req.params.id, { verifiedBy, actor }));
}));

marketerStockRouter.get('/returns', safe((_req, res) => {
  res.json(marketerStock.listReturns());
}));

marketerStockRouter.get('/returns/:id', safe((req, res) => {
  const ret = marketerStock.getReturn(req.params.id);
  if (!ret) return res.status(404).json({ error: 'Not found' });
  res.json({ ...ret, items: marketerStock.listReturnItems(req.params.id) });
}));

marketerStockRouter.post('/returns/:id/verify', safe((req, res) => {
  const { verifiedBy, lines, actor } = req.body ?? {};
  if (!verifiedBy || !Array.isArray(lines) || lines.length === 0) {
    res.status(400).json({ error: 'verifiedBy and at least one line are required' });
    return;
  }
  res.json(marketerStock.verifyReturn(req.params.id, { verifiedBy, lines, actor }));
}));

marketerStockRouter.post('/issue', safe((req, res) => {
  const { marketerId, items, issuedBy, actor, overrideUserId } = req.body ?? {};
  if (!marketerId || !Array.isArray(items) || items.length === 0 || !issuedBy) {
    res.status(400).json({ error: 'marketerId, issuedBy and at least one item are required' });
    return;
  }
  res.status(201).json(marketerStock.issueStock({ marketerId, items, issuedBy, actor, overrideUserId }));
}));

marketerStockRouter.post('/returns', safe((req, res) => {
  const { marketerId, items, actor } = req.body ?? {};
  if (!marketerId || !Array.isArray(items) || items.length === 0) {
    res.status(400).json({ error: 'marketerId and at least one item are required' });
    return;
  }
  res.status(201).json(marketerStock.recordReturn({ marketerId, items, actor: actor ?? 'System Administrator' }));
}));

marketerStockRouter.post('/sales', safe((req, res) => {
  const { marketerId, items, cashReceived, actor } = req.body ?? {};
  if (!marketerId || !Array.isArray(items) || items.length === 0) {
    res.status(400).json({ error: 'marketerId and at least one item are required' });
    return;
  }
  res.status(201).json(marketerStock.recordSale({ marketerId, items, cashReceived: Number(cashReceived) || 0, actor: actor ?? 'System Administrator' }));
}));
