import { Router } from 'express';
import * as peripheral from '../services/peripheral.js';
import * as deletionRequests from '../services/deletionRequests.js';
import * as auth from '../services/auth.js';
import { safe } from '../lib/errors.js';
import { filterModuleRows } from '../lib/filters.js';
import { paginate } from '../lib/pagination.js';
import { moduleByKey } from '../../../shared/src/moduleConfig.js';

export const modulesRouter = Router();

modulesRouter.get('/:key', safe(async (req, res) => {
  const cfg = moduleByKey(req.params.key);
  if (!cfg) { res.status(404).json({ error: `Unknown module "${req.params.key}"` }); return; }

  const rows = await deletionRequests.filterDeleted(req.params.key, await peripheral.list(req.params.key));
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
}));

modulesRouter.post('/:key', safe(async (req, res) => {
  const cfg = moduleByKey(req.params.key);
  if (cfg?.readOnly) { res.status(403).json({ error: `"${cfg.label}" is a read-only audit trail and cannot be edited` }); return; }

  const { status, fields, id, actor, password } = req.body ?? {};
  if (typeof status !== 'string' || typeof fields !== 'object' || fields === null) {
    res.status(400).json({ error: '"status" and "fields" are required' });
    return;
  }
  if (req.params.key === 'users' && (typeof password !== 'string' || password.length < 6)) {
    res.status(400).json({ error: 'A password of at least 6 characters is required' });
    return;
  }
  const row = await peripheral.create(req.params.key, actor ?? 'System Administrator', id, status, fields);
  if (!row) { res.status(404).json({ error: `Unknown module "${req.params.key}"` }); return; }
  if (req.params.key === 'users') await auth.setPassword(row.id, password);
  res.status(201).json(row);
}));

modulesRouter.put('/:key/:id', safe(async (req, res) => {
  const cfg = moduleByKey(req.params.key);
  if (cfg?.readOnly) { res.status(403).json({ error: `"${cfg.label}" is a read-only audit trail and cannot be edited` }); return; }

  const { status, fields, actor, password } = req.body ?? {};
  if (typeof status !== 'string' || typeof fields !== 'object' || fields === null) {
    res.status(400).json({ error: '"status" and "fields" are required' });
    return;
  }
  // Optional on edit (unlike creation, where it's required) — blank means
  // "leave the current password alone"; a System admin resetting it types a
  // new one here instead of the user going through self-service change-password.
  if (req.params.key === 'users' && typeof password === 'string' && password.length > 0 && password.length < 6) {
    res.status(400).json({ error: 'A password of at least 6 characters is required' });
    return;
  }
  const row = await peripheral.update(req.params.key, req.params.id, actor ?? 'System Administrator', status, fields);
  if (!row) { res.status(404).json({ error: `Unknown record "${req.params.id}" in module "${req.params.key}"` }); return; }
  if (req.params.key === 'users' && typeof password === 'string' && password.length > 0) {
    await auth.adminSetPassword(row.id, password, actor ?? 'System Administrator');
  }
  res.json(row);
}));
