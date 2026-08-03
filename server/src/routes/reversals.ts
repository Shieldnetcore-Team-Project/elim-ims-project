import { Router } from 'express';
import * as reversals from '../services/reversals.js';

export const reversalsRouter = Router();

reversalsRouter.get('/', (req, res) => {
  res.json(reversals.list(typeof req.query.entityType === 'string' ? req.query.entityType : undefined));
});
