import { Router } from 'express';
import * as reversals from '../services/reversals.js';
import { safe } from '../lib/errors.js';

export const reversalsRouter = Router();

reversalsRouter.get('/', safe(async (req, res) => {
  res.json(await reversals.list(typeof req.query.entityType === 'string' ? req.query.entityType : undefined));
}));
