import { Router } from 'express';
import * as accessControl from '../services/accessControl.js';
import { safe } from '../lib/errors.js';

export const accessControlRouter = Router();

accessControlRouter.get('/:userId', safe(async (req, res) => {
  res.json({ userId: req.params.userId, pages: await accessControl.getAccess(req.params.userId) });
}));

accessControlRouter.put('/:userId', safe(async (req, res) => {
  const { pages, actor } = req.body ?? {};
  if (!Array.isArray(pages)) { res.status(400).json({ error: '"pages" must be an array of page keys' }); return; }
  const saved = await accessControl.setAccess(req.params.userId, pages, actor ?? 'System Administrator');
  res.json({ userId: req.params.userId, pages: saved });
}));
