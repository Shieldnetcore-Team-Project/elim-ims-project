import { Router } from 'express';
import * as distributorBranches from '../services/distributorBranches.js';
import { safe } from '../lib/errors.js';

export const distributorBranchesRouter = Router();

distributorBranchesRouter.get('/', safe((req, res) => {
  const companyId = typeof req.query.companyId === 'string' && req.query.companyId ? req.query.companyId : undefined;
  res.json(distributorBranches.listBranches(companyId));
}));

distributorBranchesRouter.post('/', safe((req, res) => {
  const { companyId, name, location, contactPhone, actor } = req.body ?? {};
  if (!companyId || !name) {
    res.status(400).json({ error: 'companyId and name are required' });
    return;
  }
  res.status(201).json(distributorBranches.createBranch({ companyId, name, location, contactPhone, actor }));
}));

distributorBranchesRouter.get('/:id', safe((req, res) => {
  const branch = distributorBranches.getBranch(req.params.id);
  if (!branch) return res.status(404).json({ error: 'Not found' });
  res.json(branch);
}));

distributorBranchesRouter.put('/:id', safe((req, res) => {
  const { name, location, contactPhone, status, actor } = req.body ?? {};
  res.json(distributorBranches.updateBranch(req.params.id, { name, location, contactPhone, status }, actor));
}));

distributorBranchesRouter.get('/:id/balance', safe((req, res) => {
  res.json(distributorBranches.branchBalance(req.params.id));
}));

distributorBranchesRouter.get('/:id/statement', safe((req, res) => {
  res.json(distributorBranches.branchStatement(req.params.id));
}));

distributorBranchesRouter.get('/:id/invoices', safe((req, res) => {
  res.json(distributorBranches.branchInvoices(req.params.id));
}));
