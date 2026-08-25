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

/** Section 25: "do not use Tenure as a manually maintained field" — the
 *  employees.tenure column is never read from or written to; this always
 *  overwrites it in memory before toRow() maps it, computed live from
 *  date_engaged and (date_disengaged ?? today). */
function formatTenure(dateEngaged: unknown, dateDisengaged: unknown): string {
  if (!dateEngaged) return '';
  const start = new Date(String(dateEngaged));
  if (Number.isNaN(start.getTime())) return '';
  const end = dateDisengaged ? new Date(String(dateDisengaged)) : new Date();
  if (Number.isNaN(end.getTime()) || end < start) return '';
  let months = (end.getFullYear() - start.getFullYear()) * 12 + (end.getMonth() - start.getMonth());
  if (end.getDate() < start.getDate()) months -= 1;
  months = Math.max(months, 0);
  const years = Math.floor(months / 12);
  const remMonths = months % 12;
  const parts: string[] = [];
  if (years > 0) parts.push(`${years} yr${years !== 1 ? 's' : ''}`);
  if (remMonths > 0 || years === 0) parts.push(`${remMonths} mo${remMonths !== 1 ? 's' : ''}`);
  return parts.join(' ');
}

/** Module-specific derived fields injected into the raw DB row before
 *  toRow() maps it — same idea as update()'s settings-only touchCol below,
 *  just for reads. Only 'hr' has one today (tenure). */
function applyComputedFields(key: string, raw: Record<string, unknown>): Record<string, unknown> {
  if (key === 'hr') return { ...raw, tenure: formatTenure(raw.date_engaged, raw.date_disengaged) };
  return raw;
}

function toRow(key: string, spec: TableSpec, raw: Record<string, unknown>): ModuleRow {
  raw = applyComputedFields(key, raw);
  const fields: Record<string, string | number> = {};
  for (const col of fieldColumns(key)) {
    if (col in raw) fields[col] = raw[col] as string | number;
  }
  return { id: String(raw.id), status: spec.hasStatus ? String(raw.status ?? '') : 'COMPLETED', fields };
}

/** Section 25: configurable employee status values, read from the Settings
 *  module's "Employee status options" row — same mechanism as
 *  inventory.listCategories()/qualityControl.parameterNames(). Each label is
 *  turned into a DB-safe enum value ("On Leave" -> "ON_LEAVE") the same way
 *  every other status in this app is spelled. */
export async function employeeStatusOptions(): Promise<{ value: string; label: string }[]> {
  const row = await db.prepare(`SELECT value FROM settings WHERE id = 'Employee status options'`).get() as { value: string } | undefined;
  const fallback = ['Active', 'Inactive', 'On Leave', 'Resigned', 'Terminated', 'Disengaged', 'Absconded'];
  const labels = row ? row.value.split(',').map(s => s.trim()).filter(Boolean) : [];
  return (labels.length > 0 ? labels : fallback).map(label => ({
    value: label.toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, ''),
    label,
  }));
}

export async function list(key: string): Promise<ModuleRow[]> {
  const spec = TABLES[key];
  if (!spec) return [];
  const orderBy = key === 'activity-log' ? 'id DESC' : 'id';
  const rows = await db.prepare(`SELECT * FROM ${spec.table} ORDER BY ${orderBy}`).all() as Record<string, unknown>[];
  return rows.map(r => toRow(key, spec, r));
}

export async function get(key: string, id: string): Promise<ModuleRow | null> {
  const spec = TABLES[key];
  if (!spec) return null;
  const row = await db.prepare(`SELECT * FROM ${spec.table} WHERE id = ?`).get(id) as Record<string, unknown> | undefined;
  return row ? toRow(key, spec, row) : null;
}

export async function create(key: string, actor: string, requestedId: string | undefined, status: string, fields: Record<string, string | number>): Promise<ModuleRow | null> {
  const spec = TABLES[key];
  if (!spec) return null;
  const cols = fieldColumns(key, { writable: true });
  const id = spec.idPrefix ? await nextBusinessId(spec.table, spec.idPrefix, spec.idDigits) : (requestedId?.trim() || `Untitled ${Date.now()}`);
  const insertCols = ['id', ...(spec.hasStatus ? ['status'] : []), ...cols];
  const values = [id, ...(spec.hasStatus ? [status] : []), ...cols.map(c => fields[c] ?? '')];
  await db.prepare(`INSERT INTO ${spec.table} (${insertCols.join(', ')}) VALUES (${insertCols.map(() => '?').join(',')})`).run(...values);
  await activityLog.record(actor, 'created', key, id, `${key} record ${id} created`);
  return get(key, id);
}

/** Module 17: the one place a real field-level edit of a stored master-data row
 *  happens anywhere in this app (transactions are reversal-only — see reversals.ts).
 *  Diffs old vs new before writing so activityLog gets real old_value/new_value,
 *  populated only for fields that actually changed. */
export async function update(key: string, id: string, actor: string, status: string, fields: Record<string, string | number>): Promise<ModuleRow | null> {
  const spec = TABLES[key];
  if (!spec) return null;
  const cols = fieldColumns(key, { writable: true });
  const before = await db.prepare(`SELECT * FROM ${spec.table} WHERE id = ?`).get(id) as Record<string, unknown> | undefined;
  if (!before) return null;

  const changedCols = spec.hasStatus && status !== String(before.status ?? '')
    ? ['status', ...cols.filter(c => String(fields[c] ?? '') !== String(before[c] ?? ''))]
    : cols.filter(c => String(fields[c] ?? '') !== String(before[c] ?? ''));
  const oldDiff: Record<string, unknown> = {};
  const newDiff: Record<string, unknown> = {};
  for (const c of changedCols) {
    oldDiff[c] = c === 'status' ? before.status : before[c];
    newDiff[c] = c === 'status' ? status : fields[c];
  }

  // Settings' "updated_at" means what it says — bump it to now on every edit, rather
  // than leaving it frozen at creation time like the other modules' readOnly timestamps.
  const touchCol = key === 'settings' ? "updated_at = to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')" : null;
  const setCols = [...(spec.hasStatus ? ['status = ?'] : []), ...cols.map(c => `${c} = ?`), ...(touchCol ? [touchCol] : [])];
  const values = [...(spec.hasStatus ? [status] : []), ...cols.map(c => fields[c] ?? '')];
  const res = await db.prepare(`UPDATE ${spec.table} SET ${setCols.join(', ')} WHERE id = ?`).run(...values, id);
  if (res.changes === 0) return null;
  await activityLog.record(actor, 'updated', key, id, `${key} record ${id} updated`, changedCols.length > 0
    ? { oldValue: JSON.stringify(oldDiff), newValue: JSON.stringify(newDiff) }
    : undefined);
  return get(key, id);
}
