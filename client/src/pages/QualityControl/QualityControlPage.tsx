import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { api, apiPost } from '../../lib/apiClient';
import { number } from '../../lib/format';
import { useUi } from '../../lib/uiState';
import { Card } from '../../components/ui/Card';
import { KpiRow } from '../../components/ui/KpiCard';
import { Pill } from '../../components/ui/Pill';
import { Tabs } from '../../components/ui/Tabs';
import { Modal } from '../../components/ui/Modal';
import { EmptyState } from '../../components/ui/EmptyState';
import { PrintHeader } from '../../components/ui/PrintHeader';

interface PendingGoodsReceived { id: string; po_id: string; supplier_name: string; received_at: string }
interface PendingProductionBatch { id: string; product_name: string; line: string; shift: string; units_actual: number }
interface QcRecord { id: string; ref_type: 'GOODS_RECEIVED' | 'PRODUCTION_BATCH'; ref_id: string; inspector: string; parameter: string | null; result: string | null; verdict: 'PASS' | 'FAIL'; notes: string | null; tested_at: string }

type PendingItem =
  | { kind: 'GOODS_RECEIVED'; id: string; title: string; subtitle: string }
  | { kind: 'PRODUCTION_BATCH'; id: string; title: string; subtitle: string };

export default function QualityControlPage() {
  const ui = useUi();
  const [pendingGrn, setPendingGrn] = useState<PendingGoodsReceived[]>([]);
  const [pendingBatch, setPendingBatch] = useState<PendingProductionBatch[]>([]);
  const [history, setHistory] = useState<QcRecord[]>([]);
  const [reloadKey, setReloadKey] = useState(0);
  const [target, setTarget] = useState<PendingItem | null>(null);

  const refresh = useCallback(() => setReloadKey(k => k + 1), []);

  useEffect(() => {
    api<PendingGoodsReceived[]>('/quality-control/pending/goods-received').then(setPendingGrn);
    api<PendingProductionBatch[]>('/quality-control/pending/production-batches').then(setPendingBatch);
    api<QcRecord[]>('/quality-control/history').then(setHistory);
  }, [reloadKey]);

  const kpis = [
    { key: 'pending', label: 'Awaiting a verdict', icon: 'flask' as const, value: number(pendingGrn.length + pendingBatch.length) },
    { key: 'pass', label: 'Passed', icon: 'flask' as const, value: number(history.filter(h => h.verdict === 'PASS').length) },
    { key: 'fail', label: 'Failed', icon: 'clock' as const, value: number(history.filter(h => h.verdict === 'FAIL').length) },
  ];

  return (
    <>
      <PrintHeader />
      <div className="pagehead">
        <div><h1>Quality control</h1><p className="pagesub">Every goods receipt and production batch passes through here before it can move on.</p></div>
      </div>

      <KpiRow kpis={kpis} />

      <Tabs tabs={[
        {
          key: 'pending', label: 'Pending', content: (
            <div style={{ display: 'grid', gap: 20 }}>
              <Card title="Goods receipts awaiting QC" description="A PASS here is what posts the delivery into inventory.">
                <div style={{ overflowX: 'auto' }}>
                  <table>
                    <thead><tr><th>GRN</th><th>Purchase order</th><th>Supplier</th><th>Received</th><th className="no-print">Action</th></tr></thead>
                    <tbody>
                      {pendingGrn.map(g => (
                        <tr key={g.id}>
                          <td className="mono" style={{ fontSize: 12, color: 'rgb(var(--aqua-700))' }}>{g.id}</td>
                          <td className="mono" style={{ fontSize: 12 }}>{g.po_id}</td>
                          <td>{g.supplier_name}</td>
                          <td className="sub">{g.received_at}</td>
                          <td className="no-print"><button className="btn btn-secondary btn-sm" onClick={() => setTarget({ kind: 'GOODS_RECEIVED', id: g.id, title: g.id, subtitle: `${g.po_id} · ${g.supplier_name}` })}>Record result</button></td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                {pendingGrn.length === 0 && <EmptyState title="Nothing pending" description="Every goods receipt has a verdict." onClear={() => {}} />}
              </Card>

              <Card title="Production batches awaiting QC" description="A PASS here is what makes a batch eligible for packaging.">
                <div style={{ overflowX: 'auto' }}>
                  <table>
                    <thead><tr><th>Batch</th><th>Product</th><th>Line / shift</th><th className="num">Units</th><th className="no-print">Action</th></tr></thead>
                    <tbody>
                      {pendingBatch.map(b => (
                        <tr key={b.id}>
                          <td className="mono" style={{ fontSize: 12, color: 'rgb(var(--aqua-700))' }}>{b.id}</td>
                          <td>{b.product_name}</td>
                          <td className="sub">{b.line} · {b.shift}</td>
                          <td className="num tnum">{b.units_actual.toLocaleString('en-NG')}</td>
                          <td className="no-print"><button className="btn btn-secondary btn-sm" onClick={() => setTarget({ kind: 'PRODUCTION_BATCH', id: b.id, title: b.id, subtitle: `${b.product_name} · ${b.line}` })}>Record result</button></td>
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
            <Card title="QC history" description="Every verdict ever recorded, most recent first.">
              <div style={{ overflowX: 'auto' }}>
                <table>
                  <thead><tr><th>Record</th><th>Against</th><th>Parameter</th><th>Result</th><th>Inspector</th><th>Verdict</th></tr></thead>
                  <tbody>
                    {history.map(h => (
                      <tr key={h.id}>
                        <td className="mono" style={{ fontSize: 12, color: 'rgb(var(--aqua-700))' }}>{h.id}</td>
                        <td className="sub">{h.ref_type === 'GOODS_RECEIVED' ? 'Goods receipt' : 'Production batch'} {h.ref_id}</td>
                        <td>{h.parameter}</td>
                        <td className="sub">{h.result ?? h.notes}</td>
                        <td>{h.inspector}</td>
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
        <RecordResult
          target={target}
          onClose={() => setTarget(null)}
          onRecorded={() => { setTarget(null); refresh(); ui.toast('QC verdict recorded'); }}
        />
      )}
    </>
  );
}

function RecordResult({ target, onClose, onRecorded }: { target: PendingItem; onClose: () => void; onRecorded: () => void }) {
  const [inspector, setInspector] = useState('');
  const [parameter, setParameter] = useState('');
  const [result, setResult] = useState('');
  const [verdict, setVerdict] = useState<'PASS' | 'FAIL'>('PASS');
  const [notes, setNotes] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setSaving(true); setError(null);
    try {
      await apiPost('/quality-control', { refType: target.kind, refId: target.id, inspector, parameter, result, verdict, notes });
      onRecorded();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong');
    } finally { setSaving(false); }
  }

  return (
    <Modal title={`Record QC result — ${target.title}`} onClose={onClose} onSubmit={submit} submitLabel="Record verdict" saving={saving} error={error}>
      <p className="sub" style={{ marginBottom: 14 }}>{target.subtitle}</p>
      <div className="form-grid">
        <div className="form-row"><label htmlFor="qc-inspector">Inspector</label><input id="qc-inspector" value={inspector} onChange={e => setInspector(e.target.value)} required autoFocus /></div>
        <div className="form-row"><label htmlFor="qc-parameter">Parameter tested</label><input id="qc-parameter" value={parameter} onChange={e => setParameter(e.target.value)} placeholder="e.g. Fill volume & seal" /></div>
      </div>
      <div className="form-row"><label htmlFor="qc-result">Result</label><input id="qc-result" value={result} onChange={e => setResult(e.target.value)} placeholder="e.g. Within spec" /></div>
      <div className="form-row">
        <label htmlFor="qc-verdict">Verdict</label>
        <select id="qc-verdict" value={verdict} onChange={e => setVerdict(e.target.value as 'PASS' | 'FAIL')}>
          <option value="PASS">Pass</option>
          <option value="FAIL">Fail</option>
        </select>
      </div>
      <div className="form-row"><label htmlFor="qc-notes">Notes</label><input id="qc-notes" value={notes} onChange={e => setNotes(e.target.value)} /></div>
    </Modal>
  );
}
