import { useMemo, useState, type FormEvent } from 'react';
import type { ModuleConfig, ModuleRow } from '@shared/types';
import { FIELD_OPTIONS } from '@shared/moduleConfig';
import { humanize, singularLabel } from '../../lib/humanize';
import { apiPost, apiPut } from '../../lib/apiClient';
import { Icon } from './Icon';
import { NumberInput } from './NumberInput';

interface FieldSpec { key: string; label: string; kind: 'text' | 'num'; options?: string[] }

function fieldsFor(cfg: ModuleConfig): FieldSpec[] {
  const specs: FieldSpec[] = [];
  const optionsFor = FIELD_OPTIONS[cfg.key];
  for (const col of cfg.columns) {
    if (col.key === 'id' || col.key === 'status' || col.readOnly) continue;
    // col.label describes the combined table column ("Item & category"); once split into two
    // inputs, the primary one needs its own plain label rather than the pair's.
    const primaryLabel = col.subKey ? humanize(col.key) : col.label;
    specs.push({ key: col.key, label: primaryLabel, kind: col.kind === 'num' ? 'num' : 'text', options: optionsFor?.[col.key] });
    if (col.subKey) specs.push({ key: col.subKey, label: humanize(col.subKey), kind: 'text', options: optionsFor?.[col.subKey] });
  }
  return specs;
}

export function RecordForm({ cfg, mode, initial, onClose, onSaved }: {
  cfg: ModuleConfig;
  mode: 'create' | 'edit';
  initial?: ModuleRow;
  onClose: () => void;
  onSaved: (row: ModuleRow) => void;
}) {
  const fields = useMemo(() => fieldsFor(cfg), [cfg]);
  const idColumn = cfg.columns.find(c => c.key === 'id');
  const showIdField = !!idColumn && (mode === 'edit' || cfg.idInput === 'text');
  const idEditable = mode === 'create' && cfg.idInput === 'text';
  const isUsers = cfg.key === 'users';

  const [idValue, setIdValue] = useState(initial?.id ?? '');
  const [status, setStatus] = useState(initial?.status ?? cfg.statusOptions[0]?.value ?? '');
  const [values, setValues] = useState<Record<string, string>>(() => {
    const init: Record<string, string> = {};
    for (const f of fields) init[f.key] = initial ? String(initial.fields[f.key] ?? '') : (f.options?.[0] ?? '');
    return init;
  });
  const [password, setPassword] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError(null);
    const fieldValues: Record<string, string | number> = {};
    for (const f of fields) fieldValues[f.key] = f.kind === 'num' ? Number(values[f.key] || 0) : values[f.key];
    const body: Record<string, unknown> = { id: idValue, status, fields: fieldValues };
    // Required on create; on edit, only sent if the admin actually typed a new
    // one — blank means "leave the current password alone".
    if (isUsers && (mode === 'create' || password)) body.password = password;
    try {
      const row = mode === 'create'
        ? await apiPost<ModuleRow>(`/modules/${cfg.key}`, body)
        : await apiPut<ModuleRow>(`/modules/${cfg.key}/${encodeURIComponent(initial!.id)}`, body);
      onSaved(row);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="overlay" onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="dialog" role="dialog" aria-modal="true" aria-labelledby="recordFormTitle" style={{ maxWidth: 560 }}>
        <div className="dialog-head">
          <h2 id="recordFormTitle" className="card-title">
            {mode === 'create'
              ? `New ${singularLabel(cfg.label)}`
              : isUsers ? 'Edit user' : `Edit ${idColumn?.label.toLowerCase() ?? 'record'}`}
          </h2>
          <button className="iconbtn" onClick={onClose} aria-label="Close" style={{ width: 28, height: 28 }}>
            <Icon name="x" size={16} />
          </button>
        </div>
        <form onSubmit={handleSubmit}>
          <div style={{ padding: 20, maxHeight: '60vh', overflowY: 'auto' }}>
            {error && <p style={{ color: 'rgb(var(--stop))', fontSize: 13, marginBottom: 12 }}>{error}</p>}

            {showIdField && (
              <div className="form-row">
                <label htmlFor="f-id">{idColumn!.label}</label>
                <input
                  id="f-id" value={idValue} disabled={!idEditable} required={idEditable}
                  autoFocus={idEditable} className={idEditable ? undefined : 'mono'}
                  onChange={idEditable ? e => setIdValue(e.target.value) : undefined}
                />
              </div>
            )}

            <div className="form-grid">
              {fields.map(f => (
                <div className="form-row" key={f.key}>
                  <label htmlFor={`f-${f.key}`}>{f.label}</label>
                  {f.options ? (
                    <select
                      id={`f-${f.key}`}
                      value={values[f.key] ?? ''}
                      onChange={e => setValues(v => ({ ...v, [f.key]: e.target.value }))}
                    >
                      {f.options.map(o => <option key={o} value={o}>{o}</option>)}
                    </select>
                  ) : f.kind === 'num' ? (
                    <NumberInput
                      id={`f-${f.key}`}
                      value={values[f.key] ?? ''}
                      onChange={v => setValues(vs => ({ ...vs, [f.key]: v }))}
                      autoFocus={!showIdField && f === fields[0]}
                      required
                    />
                  ) : (
                    <input
                      id={`f-${f.key}`}
                      type="text"
                      value={values[f.key] ?? ''}
                      onChange={e => setValues(v => ({ ...v, [f.key]: e.target.value }))}
                      autoFocus={!showIdField && f === fields[0]}
                      required
                    />
                  )}
                </div>
              ))}
            </div>

            {isUsers && (
              <div className="form-row">
                <label htmlFor="f-password">{mode === 'create' ? 'Password' : 'New password (leave blank to keep current)'}</label>
                <input
                  id="f-password" type="password" value={password}
                  onChange={e => setPassword(e.target.value)}
                  minLength={6} required={mode === 'create'} autoComplete="new-password"
                />
              </div>
            )}

            <div className="form-row">
              <label htmlFor="f-status">Status</label>
              <select id="f-status" value={status} onChange={e => setStatus(e.target.value)}>
                {cfg.statusOptions.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
            </div>
          </div>
          <div className="dialog-foot">
            <button type="button" className="btn btn-secondary" onClick={onClose}>Cancel</button>
            <button type="submit" className="btn btn-primary" disabled={saving}>
              {saving ? 'Saving…' : mode === 'create' ? 'Create' : 'Save changes'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
