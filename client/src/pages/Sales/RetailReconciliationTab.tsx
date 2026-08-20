import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import { api, apiPost } from '../../lib/apiClient';
import { naira, number } from '../../lib/format';
import { useUi } from '../../lib/uiState';
import { Card } from '../../components/ui/Card';
import { EmptyState } from '../../components/ui/EmptyState';
import { Icon } from '../../components/ui/Icon';
import { Pill } from '../../components/ui/Pill';
import { Modal } from '../../components/ui/Modal';
import { NumberInput } from '../../components/ui/NumberInput';

interface DailyReportLine { item_id: string; item_name: string; quantity: number }
interface CategoryPaymentLine { category: string; payment_method: string; amount: number }
interface RetailBalance { id: string; name: string; category: string; uom: string; unit_cost: number; on_hand: number }
interface DailyActivity { type: 'INTAKE' | 'SALE'; id: string; at: string; detail: string }
interface DailyReport {
  date: string; received: DailyReportLine[]; salesByCategoryAndPayment: CategoryPaymentLine[];
  remainingBalance: RetailBalance[]; activity: DailyActivity[];
}

function today(): string { return new Date().toISOString().slice(0, 10); }

export function RetailReconciliationTab() {
  const [date, setDate] = useState(today());
  const [report, setReport] = useState<DailyReport | null>(null);

  useEffect(() => { api<DailyReport>('/retail-stock/daily-report', { date }).then(setReport); }, [date]);

  const receivedTotal = report?.received.reduce((s, r) => s + r.quantity, 0) ?? 0;
  const salesTotal = report?.salesByCategoryAndPayment.reduce((s, r) => s + r.amount, 0) ?? 0;
  const remainingValue = report?.remainingBalance.reduce((s, b) => s + b.on_hand * b.unit_cost, 0) ?? 0;

  return (
    <>
      <TillCloseSection />
      <Card
        title="Daily reconciliation" description="End-of-day breakdown of what Retail received, sold, and still holds."
        action={
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }} className="no-print">
            <input aria-label="Business date" type="date" value={date} onChange={e => setDate(e.target.value)} max={today()} />
            <button className="btn btn-primary btn-sm" onClick={() => window.print()}><Icon name="print" size={14} /> Print</button>
          </div>
        }
      >
        <div style={{ display: 'flex', gap: 24, flexWrap: 'wrap', padding: '10px 20px 16px' }}>
          <p className="sub">Received {date} <strong style={{ color: 'rgb(var(--ink))' }}>{number(receivedTotal)}</strong></p>
          <p className="sub">Sales {date} <strong style={{ color: 'rgb(var(--ink))' }}>{naira(salesTotal)}</strong></p>
          <p className="sub">Remaining stock value <strong style={{ color: 'rgb(var(--ink))' }}>{naira(remainingValue)}</strong></p>
        </div>

        <p className="card-title" style={{ padding: '4px 20px', fontSize: 14 }}>Received today</p>
        <div className="table-wrap">
          <table>
            <thead><tr><th>Item</th><th className="num">Quantity</th></tr></thead>
            <tbody>
              {report?.received.map(r => <tr key={r.item_id}><td>{r.item_name}</td><td className="num tnum">{number(r.quantity)}</td></tr>)}
            </tbody>
          </table>
        </div>
        {report?.received.length === 0 && <EmptyState title="Nothing posted today" description="No intake from the warehouse was recorded on this date." onClear={() => {}} />}

        <p className="card-title" style={{ padding: '16px 20px 4px', fontSize: 14 }}>Sales by category and payment mode</p>
        <div className="table-wrap">
          <table>
            <thead><tr><th>Category</th><th>Payment mode</th><th className="num">Amount</th></tr></thead>
            <tbody>
              {report?.salesByCategoryAndPayment.map((r, i) => (
                <tr key={i}><td>{r.category}</td><td className="sub">{r.payment_method}</td><td className="num tnum">{naira(r.amount)}</td></tr>
              ))}
            </tbody>
          </table>
        </div>
        {report?.salesByCategoryAndPayment.length === 0 && <EmptyState title="No sales today" description="No retail sale was recorded on this date." onClear={() => {}} />}

        <p className="card-title" style={{ padding: '16px 20px 4px', fontSize: 14 }}>Remaining inventory balance</p>
        <div className="table-wrap">
          <table>
            <thead><tr><th>Item</th><th>Category</th><th className="num">On hand</th><th className="num">Value</th></tr></thead>
            <tbody>
              {report?.remainingBalance.map(b => (
                <tr key={b.id}><td>{b.name}</td><td className="sub">{b.category}</td><td className="num tnum">{number(b.on_hand)}</td><td className="num tnum">{naira(b.on_hand * b.unit_cost)}</td></tr>
              ))}
            </tbody>
          </table>
        </div>

        <p className="card-title" style={{ padding: '16px 20px 4px', fontSize: 14 }}>Activity breakdown</p>
        <div className="table-wrap">
          <table>
            <thead><tr><th>Type</th><th>Ref</th><th>Time</th><th>Detail</th></tr></thead>
            <tbody>
              {report?.activity.map(a => (
                <tr key={`${a.type}-${a.id}`}>
                  <td className="sub">{a.type === 'INTAKE' ? 'Posting' : 'Sale'}</td>
                  <td className="mono" style={{ fontSize: 12 }}>{a.id}</td>
                  <td className="sub">{a.at}</td>
                  <td>{a.detail}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {report?.activity.length === 0 && <EmptyState title="No activity" description="Nothing was posted or sold in Retail on this date." onClear={() => {}} />}
      </Card>
    </>
  );
}

interface TillCloseRow {
  id: string; business_date: string; till: string;
  opening_balance: number; cash_sales: number; cash_received: number; payments: number; transfers: number; adjustments: number;
  expected_closing: number; actual_closing: number; difference: number;
  closed_by: string | null; reviewed_by: string | null; status: 'CLOSED' | 'REVIEWED'; closed_at: string; reviewed_at: string | null;
}

/** Section 23: Daily Closing / Till Reconciliation — lives inside the same
 *  Retail "Daily reconciliation" tab as the stock/sales breakdown above,
 *  since a till close is fundamentally the same end-of-day event just
 *  focused on cash rather than stock. */
function TillCloseSection() {
  const ui = useUi();
  const [closes, setCloses] = useState<TillCloseRow[]>([]);
  const [reloadKey, setReloadKey] = useState(0);
  const [closeOpen, setCloseOpen] = useState(false);
  const refresh = useCallback(() => setReloadKey(k => k + 1), []);

  useEffect(() => { api<TillCloseRow[]>('/till-close').then(setCloses); }, [reloadKey]);

  const todaysClose = useMemo(() => closes.find(c => c.business_date === today()), [closes]);

  async function review(id: string) {
    const reviewedBy = window.prompt('Reviewed by');
    if (!reviewedBy) return;
    try {
      await apiPost(`/till-close/${encodeURIComponent(id)}/review`, { reviewedBy });
      refresh();
      ui.toast(`${id} reviewed`);
    } catch (err) { ui.toast(err instanceof Error ? err.message : 'Something went wrong'); }
  }

  return (
    <>
      <Card
        title="Till close" description="Opening balance, cash movement and the counted-vs-expected difference for each till, per business day."
        action={!todaysClose && <button className="btn btn-primary btn-sm no-print" onClick={() => setCloseOpen(true)}><Icon name="lock" size={14} /> Close till</button>}
      >
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Close</th><th>Date</th><th>Till</th><th className="num">Opening</th><th className="num">Cash sales</th>
                <th className="num">Cash received</th><th className="num">Payments</th><th className="num">Transfers</th><th className="num">Adjustments</th>
                <th className="num">Expected</th><th className="num">Actual</th><th className="num">Difference</th>
                <th>Closed by</th><th>Reviewed by</th><th>Status</th><th className="no-print" />
              </tr>
            </thead>
            <tbody>
              {closes.map(c => (
                <tr key={c.id}>
                  <td className="mono" style={{ fontSize: 12, color: 'rgb(var(--aqua-700))' }}>{c.id}</td>
                  <td className="sub">{c.business_date}</td>
                  <td>{c.till}</td>
                  <td className="num tnum">{naira(c.opening_balance)}</td>
                  <td className="num tnum">{naira(c.cash_sales)}</td>
                  <td className="num tnum">{naira(c.cash_received)}</td>
                  <td className="num tnum">{naira(c.payments)}</td>
                  <td className="num tnum">{naira(c.transfers)}</td>
                  <td className="num tnum">{naira(c.adjustments)}</td>
                  <td className="num tnum">{naira(c.expected_closing)}</td>
                  <td className="num tnum">{naira(c.actual_closing)}</td>
                  <td className="num tnum" style={{ color: c.difference === 0 ? undefined : 'rgb(var(--stop))', fontWeight: c.difference === 0 ? undefined : 600 }}>
                    {naira(c.difference)}
                  </td>
                  <td>{c.closed_by ?? '—'}</td>
                  <td>{c.reviewed_by ?? '—'}</td>
                  <td><Pill status={c.status} /></td>
                  <td className="no-print">
                    {c.status === 'CLOSED' && <button className="btn btn-secondary btn-sm" onClick={() => review(c.id)}>Review</button>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {closes.length === 0 && <EmptyState title="No till closes yet" description="Close today's till once trading is done to record it here." onClear={() => {}} />}
      </Card>

      {closeOpen && (
        <CloseTillModal onClose={() => setCloseOpen(false)} onClosed={() => { setCloseOpen(false); refresh(); ui.toast('Till closed'); }} />
      )}
    </>
  );
}

function CloseTillModal({ onClose, onClosed }: { onClose: () => void; onClosed: () => void }) {
  const [till, setTill] = useState('Retail Till');
  const [figures, setFigures] = useState<{ cashSales: number; cashReceived: number; transfers: number } | null>(null);
  const [openingBalance, setOpeningBalance] = useState('0');
  const [payments, setPayments] = useState('0');
  const [adjustments, setAdjustments] = useState('0');
  const [actualClosing, setActualClosing] = useState('');
  const [closedBy, setClosedBy] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => { api<{ cashSales: number; cashReceived: number; transfers: number }>('/till-close/today-figures').then(setFigures); }, []);

  const expectedClosing = (Number(openingBalance) || 0) + (figures?.cashReceived ?? 0) - (Number(payments) || 0) + (Number(adjustments) || 0);
  const difference = (Number(actualClosing) || 0) - expectedClosing;

  async function submit(e: FormEvent) {
    e.preventDefault();
    setSaving(true); setError(null);
    try {
      await apiPost('/till-close', {
        till, openingBalance: Number(openingBalance), payments: Number(payments), adjustments: Number(adjustments),
        actualClosing: Number(actualClosing), closedBy,
      });
      onClosed();
    } catch (err) { setError(err instanceof Error ? err.message : 'Something went wrong'); }
    finally { setSaving(false); }
  }

  return (
    <Modal title="Close till" onClose={onClose} onSubmit={submit} submitLabel="Close till" saving={saving} error={error} wide>
      <div className="form-grid">
        <div className="form-row"><label htmlFor="till-name">Till / counter</label><input id="till-name" value={till} onChange={e => setTill(e.target.value)} required /></div>
        <div className="form-row"><label htmlFor="till-closed-by">Closed by</label><input id="till-closed-by" value={closedBy} onChange={e => setClosedBy(e.target.value)} required autoFocus /></div>
        <div className="form-row"><label htmlFor="till-opening">Opening balance</label><NumberInput id="till-opening" value={openingBalance} onChange={setOpeningBalance} required /></div>
        <div className="form-row"><label htmlFor="till-payments">Payments (cash paid out)</label><NumberInput id="till-payments" value={payments} onChange={setPayments} required /></div>
        <div className="form-row"><label htmlFor="till-adjustments">Adjustments</label><NumberInput id="till-adjustments" value={adjustments} onChange={setAdjustments} required /></div>
        <div className="form-row"><label htmlFor="till-actual">Actual closing (counted)</label><NumberInput id="till-actual" value={actualClosing} onChange={setActualClosing} required /></div>
      </div>
      {figures && (
        <p className="sub" style={{ marginTop: 4 }}>
          Today so far — Cash sales {naira(figures.cashSales)}, Cash received {naira(figures.cashReceived)}, Transfers {naira(figures.transfers)} (read live, not editable).
        </p>
      )}
      <p className="sub" style={{ marginTop: 10, fontWeight: 600 }}>
        Expected closing: {naira(expectedClosing)} — {actualClosing ? (difference === 0 ? 'balanced' : `${naira(Math.abs(difference))} ${difference > 0 ? 'over' : 'short'}`) : 'enter actual closing to compare'}
      </p>
    </Modal>
  );
}
