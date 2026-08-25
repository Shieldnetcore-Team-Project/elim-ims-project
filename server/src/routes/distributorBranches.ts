import { Router } from 'express';
import * as distributorBranches from '../services/distributorBranches.js';
import { safe } from '../lib/errors.js';

export const distributorBranchesRouter = Router();

distributorBranchesRouter.get('/', safe(async (req, res) => {
  const companyId = typeof req.query.companyId === 'string' && req.query.companyId ? req.query.companyId : undefined;
  res.json(await distributorBranches.listBranches(companyId));
}));

distributorBranchesRouter.post('/', safe(async (req, res) => {
  const { companyId, name, location, contactPhone, actor } = req.body ?? {};
  if (!companyId || !name) {
    res.status(400).json({ error: 'companyId and name are required' });
    return;
  }
  res.status(201).json(await distributorBranches.createBranch({ companyId, name, location, contactPhone, actor }));
}));

distributorBranchesRouter.get('/:id', safe(async (req, res) => {
  const branch = await distributorBranches.getBranch(req.params.id);
  if (!branch) { res.status(404).json({ error: 'Not found' }); return; }
  res.json(branch);
}));

distributorBranchesRouter.put('/:id', safe(async (req, res) => {
  const { name, location, contactPhone, status, actor } = req.body ?? {};
  res.json(await distributorBranches.updateBranch(req.params.id, { name, location, contactPhone, status }, actor));
}));

distributorBranchesRouter.get('/:id/balance', safe(async (req, res) => {
  res.json(await distributorBranches.branchBalance(req.params.id));
}));

distributorBranchesRouter.get('/:id/statement', safe(async (req, res) => {
  res.json(await distributorBranches.branchStatement(req.params.id));
}));

distributorBranchesRouter.get('/:id/invoices', safe(async (req, res) => {
  res.json(await distributorBranches.branchInvoices(req.params.id));
}));
