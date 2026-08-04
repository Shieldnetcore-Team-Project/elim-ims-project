import { Router } from 'express';
import * as peripheral from '../services/peripheral.js';
import * as deletionRequests from '../services/deletionRequests.js';
import * as auth from '../services/auth.js';
import { filterModuleRows } from '../lib/filters.js';
import { paginate } from '../lib/pagination.js';
import { moduleByKey } from '../../../shared/src/moduleConfig.js';

export const modulesRouter = Router();

modulesRouter.get('/:key', (req, res) => {
  const cfg = moduleByKey(req.params.key);
  if (!cfg) return res.status(404).json({ error: `Unknown module "${req.params.key}"` });

  const rows = deletionRequests.filterDeleted(req.params.key, peripheral.list(req.params.key));
  const query = String(req.query.query ?? '');
  const status = String(req.query.status ?? '');
  const page = Number(req.query.page ?? 1);
  const pageSize = Number(req.query.pageSize ?? 10);

  const filtered = filterModuleRows(rows, query, status);
  res.json({
    config: { key: cfg.key, label: cfg.label, subtitle: cfg.subtitle },
    kpis: peripheral.computeKpis(cfg, rows),
    data: paginate(filtered, page, pageSize),
  });
});

modulesRouter.post('/:key', (req, res) => {
  const cfg = moduleByKey(req.params.key);
  if (cfg?.readOnly) return res.status(403).json({ error: `"${cfg.label}" is a read-only audit trail and cannot be edited` });

  const { status, fields, id, actor, password } = req.body ?? {};
  if (typeof status !== 'string' || typeof fields !== 'object' || fields === null) {
    return res.status(400).json({ error: '"status" and "fields" are required' });
  }
  if (req.params.key === 'users' && (typeof password !== 'string' || password.length < 6)) {
    return res.status(400).json({ error: 'A password of at least 6 characters is required' });
  }
  const row = peripheral.create(req.params.key, actor ?? 'System Administrator', id, status, fields);
  if (!row) return res.status(404).json({ error: `Unknown module "${req.params.key}"` });
  if (req.params.key === 'users') auth.setPassword(row.id, password);
  res.status(201).json(row);
});

modulesRouter.put('/:key/:id', (req, res) => {
  const cfg = moduleByKey(req.params.key);
  if (cfg?.readOnly) return res.status(403).json({ error: `"${cfg.label}" is a read-only audit trail and cannot be edited` });

  const { status, fields, actor } = req.body ?? {};
  if (typeof status !== 'string' || typeof fields !== 'object' || fields === null) {
    return res.status(400).json({ error: '"status" and "fields" are required' });
  }
  const row = peripheral.update(req.params.key, req.params.id, actor ?? 'System Administrator', status, fields);
  if (!row) return res.status(404).json({ error: `Unknown record "${req.params.id}" in module "${req.params.key}"` });
  res.json(row);
});
