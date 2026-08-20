import { Router } from 'express';
import * as dayClose from '../services/dayClose.js';
import { safe } from '../lib/errors.js';

export const dayCloseRouter = Router();

dayCloseRouter.get('/check', safe((_req, res) => {
  res.json(dayClose.runDiscrepancyChecks());
}));

// Section 22: the Business Reconciliation dashboard — every check above,
// plus categories that inform without blocking the close-day gate.
dayCloseRouter.get('/attention-list', safe((_req, res) => {
  res.json(dayClose.attentionList());
}));

dayCloseRouter.get('/history', safe((_req, res) => {
  res.json(dayClose.listDayCloses());
}));

dayCloseRouter.post('/', safe((req, res) => {
  const { checkedBy, actor } = req.body ?? {};
  if (!checkedBy) {
    res.status(400).json({ error: 'checkedBy is required' });
    return;
  }
  const result = dayClose.closeDay({ checkedBy, actor });
  // Always a 2xx: a blocked close is a normal, expected outcome carrying its
  // own discrepancy payload, not a request error — the client's apiPost
  // throws on any non-2xx and would lose that payload, so `balanced`/
  // `alreadyClosed` on the body is the real signal here, not the status code.
  res.status(result.alreadyClosed ? 200 : result.balanced ? 201 : 200).json(result);
}));
