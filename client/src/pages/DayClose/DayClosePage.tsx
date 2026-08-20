import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import { api, apiPost } from '../../lib/apiClient';
import { number } from '../../lib/format';
import { useUi } from '../../lib/uiState';
import { Card } from '../../components/ui/Card';
import { KpiRow } from '../../components/ui/KpiCard';
import { Pill } from '../../components/ui/Pill';
import { Modal } from '../../components/ui/Modal';
import { EmptyState } from '../../components/ui/EmptyState';
import { Icon } from '../../components/ui/Icon';
import { PrintHeader } from '../../components/ui/PrintHeader';

interface DiscrepancyRecord { id: string; detail: string }
// blocking is absent on the plain /day-close/check and CloseResult shapes
// (every check there blocks, by definition) and present on the richer
// /day-close/attention-list response — missing is treated as blocking.
interface DiscrepancyCheck { category: string; description: string; count: number; records: DiscrepancyRecord[]; blocking?: boolean }
interface DiscrepancyReport { balanced: boolean; checks: DiscrepancyCheck[] }
interface DayCloseRow { id: string; business_date: string; status: string; checked_by: string | null; actor: string | null; closed_at: string }
interface CloseResult { alreadyClosed: boolean; balanced: boolean; dayClose?: DayCloseRow; checks?: DiscrepancyCheck[] }

export default function DayClosePage() {
  const ui = useUi();
  const [report, setReport] = useState<DiscrepancyReport | null>(null);
  const [history, setHistory] = useState<DayCloseRow[]>([]);
  const [reloadKey, setReloadKey] = useState(0);
  const [closeOpen, setCloseOpen] = useState(false);
  const refresh = useCallback(() => setReloadKey(k => k + 1), []);

  useEffect(() => { api<DiscrepancyReport>('/day-close/attention-list').then(setReport); }, [reloadKey]);
  useEffect(() => { api<DayCloseRow[]>('/day-close/history').then(setHistory); }, [reloadKey]);

  const blockingOpenCount = useMemo(() => report?.checks.filter(c => c.blocking !== false).reduce((s, c) => s + c.count, 0) ?? 0, [report]);
  const attentionOpenCount = useMemo(() => report?.checks.filter(c => c.blocking === false).reduce((s, c) => s + c.count, 0) ?? 0, [report]);
  const statusIcon: 'shield' | 'clock' = report?.balanced ? 'shield' : 'clock';
  const kpis = useMemo(() => [
    { key: 'status', label: 'Status', icon: statusIcon, value: report ? (report.balanced ? 'Balanced' : 'Discrepancies found') : 'Loading…' },
    { key: 'blocking', label: 'Blocking close', icon: 'clock' as const, value: number(blockingOpenCount) },
    { key: 'attention', label: 'Needs attention (non-blocking)', icon: 'clock' as const, value: number(attentionOpenCount) },
    { key: 'closes', label: 'Days closed', icon: 'scroll' as const, value: number(history.length) },
  ], [report, blockingOpenCount, attentionOpenCount, history, statusIcon]);

  return (
    <>
      <PrintHeader />
      <div className="pagehead">
        <div><h1>Day Close</h1><p className="pagesub">The business reconciliation dashboard — what requires attention before today can close. Every open record across production, warehouse and finished goods must be resolved to close; approvals and deliveries are shown for visibility but don't block it.</p></div>
        <div className="no-print"><button className="btn btn-primary" onClick={() => setCloseOpen(true)} disabled={!report}><Icon name="lock" size={14} /> Close today</button></div>
      </div>

      <KpiRow kpis={kpis} />

      <Card
        title="Reconciliation checks" description="Live — always reflects current state, not a snapshot of today's activity."
        action={<button className="btn btn-secondary btn-sm no-print" onClick={refresh}><Icon name="switch" size={14} /> Re-run</button>}
      >
        <div className="table-wrap">
          <table>
            <thead><tr><th>Category</th><th>Description</th><th className="num">Open</th><th>Blocks closing?</th><th>Status</th></tr></thead>
            <tbody>
              {report?.checks.map(c => (
                <tr key={c.category}>
                  <td style={{ fontWeight: 500 }}>{c.category}</td>
                  <td className="sub">{c.description}</td>
                  <td className="num tnum">{number(c.count)}</td>
                  <td className="sub">{c.blocking === false ? 'No' : 'Yes'}</td>
                  <td><Pill status={c.count === 0 ? 'RESOLVED' : 'PENDING'} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {!report && <p className="sub" style={{ padding: 20 }}>Loading…</p>}
        {report && report.checks.some(c => c.count > 0) && (
          <div style={{ padding: '4px 20px 16px' }}>
            {report.checks.filter(c => c.count > 0).map(c => (
              <div key={c.category} style={{ marginBottom: 12 }}>
                <p style={{ fontWeight: 600, fontSize: 13 }}>{c.category}</p>
                <ul style={{ margin: '4px 0 0', paddingLeft: 18, fontSize: 13 }}>
                  {c.records.map((r, i) => <li key={i} className="sub">{r.id !== '—' ? `${r.id} — ` : ''}{r.detail}</li>)}
                </ul>
              </div>
            ))}
          </div>
        )}
      </Card>

      <Card title="Close history" description="Every business day successfully closed, most recent first.">
        <div className="table-wrap">
          <table>
            <thead><tr><th>Close</th><th>Business date</th><th>Checked by</th><th>Closed at</th><th>Status</th></tr></thead>
            <tbody>
              {history.map(h => (
                <tr key={h.id}>
                  <td className="mono" style={{ fontSize: 12, color: 'rgb(var(--aqua-700))' }}>{h.id}</td>
                  <td className="sub">{h.business_date}</td>
                  <td>{h.checked_by ?? '—'}</td>
                  <td className="sub">{h.closed_at}</td>
                  <td><Pill status={h.status} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {history.length === 0 && <EmptyState title="No days closed yet" description="Close today once every check above is balanced." onClear={() => {}} />}
      </Card>

      {closeOpen && (
        <CloseDayModal onClose={() => setCloseOpen(false)} onDone={() => { setCloseOpen(false); refresh(); }} />
      )}
    </>
  );
}

function CloseDayModal({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const ui = useUi();
  const [checkedBy, setCheckedBy] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<CloseResult | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setSaving(true); setError(null);
    try {
      const res = await apiPost<CloseResult>('/day-close', { checkedBy });
      setResult(res);
      if (res.balanced || res.alreadyClosed) {
        ui.toast(res.alreadyClosed ? 'Today is already closed' : 'Day closed');
        onDone();
      }
    } catch (err) { setError(err instanceof Error ? err.message : 'Something went wrong'); }
    finally { setSaving(false); }
  }

  return (
    <Modal title="Close today" onClose={onClose} onSubmit={submit} submitLabel="Close" saving={saving} error={error} wide>
      <div className="form-row"><label htmlFor="dc-checked-by">Checked by</label><input id="dc-checked-by" value={checkedBy} onChange={e => setCheckedBy(e.target.value)} required autoFocus /></div>
      {result && !result.balanced && !result.alreadyClosed && (
        <div style={{ marginTop: 10, padding: '10px 12px', border: '1px solid rgb(var(--border))', borderRadius: 8 }}>
          <p className="sub" style={{ fontWeight: 600, marginBottom: 6 }}>⚠ Cannot close — discrepancies found:</p>
          {result.checks?.filter(c => c.count > 0).map(c => (
            <p key={c.category} className="sub">{c.category}: {c.count} open</p>
          ))}
        </div>
      )}
    </Modal>
  );
}
