import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { api, apiPost } from '../../lib/apiClient';
import { number } from '../../lib/format';
import { useUi } from '../../lib/uiState';
import { Card } from '../../components/ui/Card';
import { KpiRow } from '../../components/ui/KpiCard';
import { Pill } from '../../components/ui/Pill';
import { Tabs } from '../../components/ui/Tabs';
import { Modal } from '../../components/ui/Modal';
import { NumberInput } from '../../components/ui/NumberInput';
import { Icon } from '../../components/ui/Icon';
import { EmptyState } from '../../components/ui/EmptyState';
import { PrintHeader } from '../../components/ui/PrintHeader';

interface PendingProductionBatch { id: string; product_name: string; line: string; shift: string; units_actual: number; started_at: string }
type ProductType = 'RAW_WATER' | 'TREATED_WATER' | 'UNTREATED_WATER' | 'OTHER';
interface QcRecord {
  id: string; ref_type: 'GOODS_RECEIVED' | 'PRODUCTION_BATCH'; ref_id: string; inspector: string;
  parameter: string | null; result: string | null; verdict: 'PASS' | 'FAIL'; notes: string | null;
  product_type: ProductType | null; reviewed_by: string | null; tested_at: string;
}
interface QcParameter {
  id: number; parameter_name: string; measured_value: string; unit: string | null;
  min_value: number | null; max_value: number | null; expected_value: string | null; result: 'PASS' | 'FAIL';
}
interface QcDetail extends QcRecord { parameters: QcParameter[] }

type PendingItem = { kind: 'PRODUCTION_BATCH'; id: string; title: string; subtitle: string };

const PRODUCT_TYPE_LABEL: Record<ProductType, string> = {
  RAW_WATER: 'Raw water', TREATED_WATER: 'Treated water', UNTREATED_WATER: 'Untreated water', OTHER: 'Other',
};

export default function QualityControlPage() {
  const ui = useUi();
  const [pendingBatch, setPendingBatch] = useState<PendingProductionBatch[]>([]);
  const [history, setHistory] = useState<QcRecord[]>([]);
  const [reloadKey, setReloadKey] = useState(0);
  const [target, setTarget] = useState<PendingItem | null>(null);
  const [detailFor, setDetailFor] = useState<string | null>(null);

  const refresh = useCallback(() => setReloadKey(k => k + 1), []);

  useEffect(() => {
    api<PendingProductionBatch[]>('/quality-control/pending/production-batches').then(setPendingBatch);
    api<QcRecord[]>('/quality-control/history').then(setHistory);
  }, [reloadKey]);

  const kpis = [
    { key: 'pending', label: 'Awaiting a verdict', icon: 'flask' as const, value: number(pendingBatch.length) },
    { key: 'pass', label: 'Passed', icon: 'flask' as const, value: number(history.filter(h => h.verdict === 'PASS').length) },
    { key: 'fail', label: 'Failed', icon: 'clock' as const, value: number(history.filter(h => h.verdict === 'FAIL').length) },
  ];

  return (
    <>
      <PrintHeader />
      <div className="pagehead">
        <div><h1>Quality control</h1><p className="pagesub">Every production batch passes through here before it's eligible for packaging. A pass always comes with the parameters that support it. (Goods-receipt inspection — accepted/rejected quantities — lives on the Procurement page, next to Receive.)</p></div>
      </div>

      <KpiRow kpis={kpis} />

      <Tabs tabs={[
        {
          key: 'pending', label: 'Pending', content: (
            <div style={{ display: 'grid', gap: 20 }}>
              <Card title="Production batches awaiting QC" description="A PASS here is what makes a batch eligible for packaging.">
                <div className="table-wrap">
                  <table>
                    <thead><tr><th>Batch</th><th>Product</th><th>Line / shift</th><th className="num">Units</th><th>Started</th><th className="no-print">Action</th></tr></thead>
                    <tbody>
                      {pendingBatch.map(b => (
                        <tr key={b.id}>
                          <td className="mono" style={{ fontSize: 12, color: 'rgb(var(--aqua-700))' }}>{b.id}</td>
                          <td>{b.product_name}</td>
                          <td className="sub">{b.line} · {b.shift}</td>
                          <td className="num tnum">{b.units_actual.toLocaleString('en-NG')}</td>
                          <td className="sub">{b.started_at}</td>
                          <td className="no-print"><button className="btn btn-secondary btn-sm" onClick={() => setTarget({ kind: 'PRODUCTION_BATCH', id: b.id, title: b.id, subtitle: `${b.product_name} · ${b.line}` })}>Record test</button></td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                {pendingBatch.length === 0 && <EmptyState title="Nothing pending" description="Every completed batch has a verdict." onClear={() => {}} />}
              </Card>
            </div>
          ),
        },
        {
          key: 'history', label: 'History', content: (
            <Card title="QC history" description="Every verdict ever recorded, most recent first — click a row to see the parameters that explain it.">
              <div className="table-wrap">
                <table>
                  <thead><tr><th>Record</th><th>Against</th><th>Product/water type</th><th>Parameters</th><th>Inspector</th><th>Reviewed by</th><th>Tested</th><th>Verdict</th></tr></thead>
                  <tbody>
                    {history.map(h => (
                      <tr key={h.id} className="row-clickable" onClick={() => setDetailFor(h.id)}>
                        <td className="mono" style={{ fontSize: 12, color: 'rgb(var(--aqua-700))' }}>{h.id}</td>
                        <td className="sub">{h.ref_type === 'GOODS_RECEIVED' ? 'Goods receipt' : 'Production batch'} {h.ref_id}</td>
                        <td className="sub">{h.product_type ? PRODUCT_TYPE_LABEL[h.product_type] : '—'}</td>
                        <td>{h.parameter ?? '—'}</td>
                        <td>{h.inspector}</td>
                        <td className="sub">{h.reviewed_by ?? '—'}</td>
                        <td className="sub">{h.tested_at}</td>
                        <td><Pill status={h.verdict} /></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {history.length === 0 && <EmptyState title="No QC records yet" description="Verdicts recorded from the Pending tab show up here." onClear={() => {}} />}
            </Card>
          ),
        },
      ]} />

      {target && (
        <RecordTest
          target={target}
          onClose={() => setTarget(null)}
          onRecorded={() => { setTarget(null); refresh(); ui.toast('QC test recorded'); }}
        />
      )}
      {detailFor && <QcDetailModal qcId={detailFor} onClose={() => setDetailFor(null)} />}
    </>
  );
}

function QcDetailModal({ qcId, onClose }: { qcId: string; onClose: () => void }) {
  const [detail, setDetail] = useState<QcDetail | null>(null);

  useEffect(() => { api<QcDetail>(`/quality-control/${encodeURIComponent(qcId)}/detail`).then(setDetail); }, [qcId]);

  return (
    <Modal title={`Why did ${qcId} ${detail?.verdict === 'FAIL' ? 'fail' : 'pass'}?`} onClose={onClose} onSubmit={e => { e.preventDefault(); onClose(); }} submitLabel="Close" saving={false} wide>
      {!detail && <p className="sub">Loading…</p>}
      {detail && (
        <>
          <div style={{ display: 'flex', gap: 24, flexWrap: 'wrap', marginBottom: 12 }}>
            <p className="sub">Against <strong style={{ color: 'rgb(var(--ink))' }}>{detail.ref_type === 'GOODS_RECEIVED' ? 'Goods receipt' : 'Production batch'} {detail.ref_id}</strong></p>
            <p className="sub">Product/water type <strong style={{ color: 'rgb(var(--ink))' }}>{detail.product_type ? PRODUCT_TYPE_LABEL[detail.product_type] : '—'}</strong></p>
            <p className="sub">Inspector <strong style={{ color: 'rgb(var(--ink))' }}>{detail.inspector}</strong></p>
            <p className="sub">Reviewed by <strong style={{ color: 'rgb(var(--ink))' }}>{detail.reviewed_by ?? '—'}</strong></p>
            <p className="sub">Tested <strong style={{ color: 'rgb(var(--ink))' }}>{detail.tested_at}</strong></p>
          </div>
          {detail.parameters.length > 0 ? (
            <>
              <div className="table-wrap">
                <table>
                  <thead><tr><th>Parameter</th><th>Measured</th><th>Required range / expected</th><th>Result</th></tr></thead>
                  <tbody>
                    {detail.parameters.map(p => (
                      <tr key={p.id}>
                        <td>{p.parameter_name}</td>
                        <td>{p.measured_value}{p.unit ? ` ${p.unit}` : ''}</td>
                        <td className="sub">
                          {p.min_value != null && p.max_value != null ? `${p.min_value} – ${p.max_value}${p.unit ? ` ${p.unit}` : ''}` : p.expected_value ?? '—'}
                        </td>
                        <td><Pill status={p.result} /></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <p className="sub" style={{ marginTop: 10 }}>
                Overall verdict is PASS only when every parameter above is PASS — {detail.parameters.filter(p => p.result === 'PASS').length} of {detail.parameters.length} passed.
              </p>
            </>
          ) : (
            <p className="sub">Recorded before multi-parameter tests (Section 19) — only a single summary result is on file: {detail.parameter} — {detail.result}.</p>
          )}
          {detail.notes && <p className="sub" style={{ marginTop: 6 }}>Notes: {detail.notes}</p>}
        </>
      )}
    </Modal>
  );
}

interface ParamRow {
  name: string; measuredValue: string; unit: string; minValue: string; maxValue: string; expectedValue: string; result: 'PASS' | 'FAIL';
}

function emptyParamRow(): ParamRow {
  return { name: '', measuredValue: '', unit: '', minValue: '', maxValue: '', expectedValue: '', result: 'PASS' };
}

function computeResult(row: ParamRow): 'PASS' | 'FAIL' {
  const measured = Number(row.measuredValue);
  const hasRange = row.minValue.trim() !== '' && row.maxValue.trim() !== '';
  if (hasRange && Number.isFinite(measured)) {
    return measured >= Number(row.minValue) && measured <= Number(row.maxValue) ? 'PASS' : 'FAIL';
  }
  return row.result;
}

function RecordTest({ target, onClose, onRecorded }: { target: PendingItem; onClose: () => void; onRecorded: () => void }) {
  const [inspector, setInspector] = useState('');
  const [reviewedBy, setReviewedBy] = useState('');
  const [productType, setProductType] = useState<ProductType | ''>('');
  const [parameterOptions, setParameterOptions] = useState<string[]>([]);
  const [rows, setRows] = useState<ParamRow[]>([emptyParamRow()]);
  const [notes, setNotes] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => { api<string[]>('/quality-control/parameters').then(setParameterOptions); }, []);

  function updateRow(i: number, patch: Partial<ParamRow>) {
    setRows(rs => rs.map((r, idx) => (idx === i ? { ...r, ...patch } : r)));
  }
  function addRow() { setRows(rs => [...rs, emptyParamRow()]); }
  function removeRow(i: number) { setRows(rs => rs.filter((_, idx) => idx !== i)); }

  const overallVerdict = rows.length > 0 && rows.every(r => r.name.trim() && r.measuredValue.trim())
    ? (rows.every(r => computeResult(r) === 'PASS') ? 'PASS' : 'FAIL')
    : null;

  async function submit(e: FormEvent) {
    e.preventDefault();
    const cleanRows = rows.filter(r => r.name.trim() && r.measuredValue.trim());
    if (cleanRows.length === 0) { setError('At least one parameter with a name and measured value is required'); return; }
    setSaving(true); setError(null);
    try {
      await apiPost('/quality-control/tests', {
        refType: target.kind, refId: target.id, inspector, reviewedBy: reviewedBy || undefined, productType: productType || undefined, notes,
        parameters: cleanRows.map(r => ({
          name: r.name, measuredValue: r.measuredValue, unit: r.unit || undefined,
          minValue: r.minValue.trim() !== '' ? Number(r.minValue) : undefined,
          maxValue: r.maxValue.trim() !== '' ? Number(r.maxValue) : undefined,
          expectedValue: r.expectedValue || undefined, result: computeResult(r),
        })),
      });
      onRecorded();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong');
    } finally { setSaving(false); }
  }

  return (
    <Modal title={`Record QC test — ${target.title}`} onClose={onClose} onSubmit={submit} submitLabel="Record test" saving={saving} error={error} wide>
      <p className="sub" style={{ marginBottom: 14 }}>{target.subtitle}</p>
      <div className="form-grid">
        <div className="form-row"><label htmlFor="qc-inspector">Inspector</label><input id="qc-inspector" value={inspector} onChange={e => setInspector(e.target.value)} required autoFocus /></div>
        <div className="form-row"><label htmlFor="qc-reviewer">Reviewed by (optional)</label><input id="qc-reviewer" value={reviewedBy} onChange={e => setReviewedBy(e.target.value)} /></div>
        <div className="form-row">
          <label htmlFor="qc-product-type">Product / water type</label>
          <select id="qc-product-type" value={productType} onChange={e => setProductType(e.target.value as ProductType | '')}>
            <option value="">Not specified</option>
            <option value="RAW_WATER">Raw water</option>
            <option value="TREATED_WATER">Treated water</option>
            <option value="UNTREATED_WATER">Untreated water</option>
            <option value="OTHER">Other</option>
          </select>
        </div>
      </div>

      <div className="form-row">
        <label>Parameters</label>
        <datalist id="qc-parameter-options">
          {parameterOptions.map(p => <option key={p} value={p} />)}
        </datalist>
        {rows.map((r, i) => {
          const hasRange = r.minValue.trim() !== '' && r.maxValue.trim() !== '';
          const rowResult = computeResult(r);
          return (
            <div key={i} style={{ padding: '8px 0', borderBottom: '1px solid rgb(var(--border))' }}>
              <div className="lineitem-row">
                <div style={{ flex: 2 }}>
                  <input aria-label="Parameter name" list="qc-parameter-options" placeholder="e.g. pH" value={r.name} onChange={e => updateRow(i, { name: e.target.value })} required />
                </div>
                <div style={{ width: 100 }}>
                  <input aria-label="Measured value" placeholder="Value" value={r.measuredValue} onChange={e => updateRow(i, { measuredValue: e.target.value })} required />
                </div>
                <div style={{ width: 70 }}>
                  <input aria-label="Unit" placeholder="Unit" value={r.unit} onChange={e => updateRow(i, { unit: e.target.value })} />
                </div>
                <button type="button" className="iconbtn" onClick={() => removeRow(i)} aria-label="Remove parameter" disabled={rows.length <= 1}>
                  <Icon name="x" size={16} />
                </button>
              </div>
              <div className="lineitem-row" style={{ marginTop: 6 }}>
                <div style={{ width: 90 }}>
                  <NumberInput ariaLabel="Minimum" allowNegative value={r.minValue} onChange={v => updateRow(i, { minValue: v })} placeholder="Min" />
                </div>
                <div style={{ width: 90 }}>
                  <NumberInput ariaLabel="Maximum" allowNegative value={r.maxValue} onChange={v => updateRow(i, { maxValue: v })} placeholder="Max" />
                </div>
                {!hasRange && (
                  <div style={{ flex: 1 }}>
                    <input aria-label="Expected value" placeholder="Expected (e.g. None, Clear) — for a qualitative parameter" value={r.expectedValue} onChange={e => updateRow(i, { expectedValue: e.target.value })} />
                  </div>
                )}
                {hasRange ? (
                  <p className="sub" style={{ fontSize: 12, alignSelf: 'center' }}>Result computed from range: <strong>{rowResult}</strong></p>
                ) : (
                  <select aria-label="Result for this parameter" value={r.result} onChange={e => updateRow(i, { result: e.target.value as 'PASS' | 'FAIL' })} style={{ width: 100 }}>
                    <option value="PASS">Pass</option>
                    <option value="FAIL">Fail</option>
                  </select>
                )}
              </div>
            </div>
          );
        })}
        <button type="button" className="btn btn-secondary btn-sm" onClick={addRow} style={{ marginTop: 8 }}>
          <Icon name="plus" size={12} /> Add parameter
        </button>
      </div>

      {overallVerdict && (
        <p className="sub" style={{ marginTop: 10 }}>
          Overall verdict (all parameters must pass): <Pill status={overallVerdict} />
        </p>
      )}

      <div className="form-row" style={{ marginTop: 10 }}><label htmlFor="qc-notes">Notes</label><input id="qc-notes" value={notes} onChange={e => setNotes(e.target.value)} /></div>
    </Modal>
  );
}
