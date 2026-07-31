import { db } from '../db/client.js';
import { nextBusinessId } from '../db/ids.js';
import * as activityLog from './activityLog.js';
import { GENERIC_MODULES } from '../../../shared/src/moduleConfig.js';
import { toneOf } from '../../../shared/src/types.js';
import type { ModuleRow, ModuleConfig, KpiMetric } from '../../../shared/src/types.js';

const MONEY_FIELDS = new Set(['gross', 'net']);

export function computeKpis(cfg: ModuleConfig, rows: ModuleRow[]): KpiMetric[] {
  const kpis: KpiMetric[] = [
    { key: 'total', label: `Total ${cfg.label.toLowerCase()}`, icon: cfg.icon, value: rows.length.toLocaleString('en-NG') },
  ];

  const numCol = cfg.columns.find(c => c.kind === 'num');
  if (numCol) {
    const sum = rows.reduce((s, r) => s + (Number(r.fields[numCol.key]) || 0), 0);
    kpis.push({
      key: numCol.key, label: numCol.label, icon: 'chart',
      value: MONEY_FIELDS.has(numCol.key) ? `₦${Math.round(sum).toLocaleString('en-NG')}` : Math.round(sum).toLocaleString('en-NG'),
    });
  }

  if (cfg.key !== 'activity-log') {
    const positive = cfg.statusOptions.find(o => toneOf(o.value) === 'ok') ?? cfg.statusOptions[0];
    if (positive) kpis.push({ key: 'positive', label: positive.label, icon: cfg.icon, value: rows.filter(r => r.status === positive.value).length.toLocaleString('en-NG') });
    const attention = cfg.statusOptions.find(o => toneOf(o.value) === 'stop') ?? cfg.statusOptions.find(o => toneOf(o.value) === 'wait');
    if (attention) kpis.push({ key: 'attention', label: attention.label, icon: 'clock', value: rows.filter(r => r.status === attention.value).length.toLocaleString('en-NG') });
  }

  return kpis.slice(0, 4);
}

interface TableSpec { table: string; idPrefix: string; idDigits: number; hasStatus: boolean }

// One real table per generic module. `table` and every column name used below comes
// only from this static map / from shared/moduleConfig.ts (never from a request body),
// so building SQL by string-joining them is safe.
const TABLES: Record<string, TableSpec> = {
  'water-treatment': { table: 'water_treatment_runs', idPrefix: 'TR-', idDigits: 4, hasStatus: true },
  warehouse: { table: 'warehouse_requisitions', idPrefix: 'WR-', idDigits: 4, hasStatus: true },
  hr: { table: 'employees', idPrefix: 'EMP-', idDigits: 4, hasStatus: true },
  payroll: { table: 'payroll_runs', idPrefix: 'PYR-2026-', idDigits: 4, hasStatus: true },
  assets: { table: 'assets', idPrefix: 'AST-', idDigits: 3, hasStatus: true },
  reports: { table: 'reports', idPrefix: 'RPT-', idDigits: 3, hasStatus: true },
  users: { table: 'users', idPrefix: 'USR-', idDigits: 4, hasStatus: true },
  roles: { table: 'roles', idPrefix: '', idDigits: 0, hasStatus: true },
  'activity-log': { table: 'activity_log', idPrefix: '', idDigits: 0, hasStatus: false },
  settings: { table: 'settings', idPrefix: '', idDigits: 0, hasStatus: true },
};

/** `writable: true` excludes system-generated columns (e.g. a created_at timestamp) —
 *  used to build INSERT/UPDATE column lists so those keep their SQL-computed value
 *  instead of whatever a stale form field would otherwise overwrite them with. */
function fieldColumns(key: string, opts: { writable?: boolean } = {}): string[] {
  const cfg = GENERIC_MODULES.find(m => m.key === key);
  if (!cfg) return [];
  const cols = new Set<string>();
  for (const c of cfg.columns) {
    if (c.key === 'id' || c.key === 'status') continue;
    if (opts.writable && c.readOnly) continue;
    cols.add(c.key);
    if (c.subKey) cols.add(c.subKey);
  }
  return [...cols];
}

function toRow(key: string, spec: TableSpec, raw: Record<string, unknown>): ModuleRow {
  const fields: Record<string, string | number> = {};
  for (const col of fieldColumns(key)) {
    if (col in raw) fields[col] = raw[col] as string | number;
  }
  return { id: String(raw.id), status: spec.hasStatus ? String(raw.status ?? '') : 'COMPLETED', fields };
}

export function list(key: string): ModuleRow[] {
  const spec = TABLES[key];
  if (!spec) return [];
  const orderBy = key === 'activity-log' ? 'id DESC' : 'id';
  const rows = db.prepare(`SELECT * FROM ${spec.table} ORDER BY ${orderBy}`).all() as Record<string, unknown>[];
  return rows.map(r => toRow(key, spec, r));
}

export function get(key: string, id: string): ModuleRow | null {
  const spec = TABLES[key];
  if (!spec) return null;
  const row = db.prepare(`SELECT * FROM ${spec.table} WHERE id = ?`).get(id) as Record<string, unknown> | undefined;
  return row ? toRow(key, spec, row) : null;
}

export function create(key: string, actor: string, requestedId: string | undefined, status: string, fields: Record<string, string | number>): ModuleRow | null {
  const spec = TABLES[key];
  if (!spec) return null;
  const cols = fieldColumns(key, { writable: true });
  const id = spec.idPrefix ? nextBusinessId(spec.table, spec.idPrefix, spec.idDigits) : (requestedId?.trim() || `Untitled ${Date.now()}`);
  const insertCols = ['id', ...(spec.hasStatus ? ['status'] : []), ...cols];
  const values = [id, ...(spec.hasStatus ? [status] : []), ...cols.map(c => fields[c] ?? '')];
  db.prepare(`INSERT INTO ${spec.table} (${insertCols.join(', ')}) VALUES (${insertCols.map(() => '?').join(',')})`).run(...values);
  activityLog.record(actor, 'created', key, id, `${key} record ${id} created`);
  return get(key, id);
}

export function update(key: string, id: string, actor: string, status: string, fields: Record<string, string | number>): ModuleRow | null {
  const spec = TABLES[key];
  if (!spec) return null;
  const cols = fieldColumns(key, { writable: true });
  // Settings' "updated_at" means what it says — bump it to now on every edit, rather
  // than leaving it frozen at creation time like the other modules' readOnly timestamps.
  const touchCol = key === 'settings' ? "updated_at = datetime('now')" : null;
  const setCols = [...(spec.hasStatus ? ['status = ?'] : []), ...cols.map(c => `${c} = ?`), ...(touchCol ? [touchCol] : [])];
  const values = [...(spec.hasStatus ? [status] : []), ...cols.map(c => fields[c] ?? '')];
  const res = db.prepare(`UPDATE ${spec.table} SET ${setCols.join(', ')} WHERE id = ?`).run(...values, id);
  if (res.changes === 0) return null;
  activityLog.record(actor, 'updated', key, id, `${key} record ${id} updated`);
  return get(key, id);
}
