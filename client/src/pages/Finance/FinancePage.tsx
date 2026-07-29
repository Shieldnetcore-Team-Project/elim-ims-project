import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { api, apiPost } from '../../lib/apiClient';
import { naira } from '../../lib/format';
import { useUi } from '../../lib/uiState';
import { Card } from '../../components/ui/Card';
import { KpiRow } from '../../components/ui/KpiCard';
import { Tabs } from '../../components/ui/Tabs';
import { Modal } from '../../components/ui/Modal';
import { EmptyState } from '../../components/ui/EmptyState';
import { Icon } from '../../components/ui/Icon';
import { PrintHeader } from '../../components/ui/PrintHeader';
import { DeleteButton } from '../../components/ui/DeleteButton';
import { NumberInput } from '../../components/ui/NumberInput';
import { usePendingDeletions } from '../../lib/pendingDeletions';

interface LedgerEntry { id: string; entry_date: string; account: string; debit: number; credit: number; description: string | null }
interface Payment { id: string; paid_to: string; amount: number; method: string | null; status: string; paid_at: string }
interface Receipt { id: string; received_from: string; amount: number; method: string | null; status: string; received_at: string }
interface Totals { revenue: number; outstandingReceivable: number; cashPosition: number }

export default function FinancePage() {
  const ui = useUi();
  const [ledger, setLedger] = useState<LedgerEntry[]>([]);
  const [payments, setPayments] = useState<Payment[]>([]);
  const [receipts, setReceipts] = useState<Receipt[]>([]);
  const [totals, setTotals] = useState<Totals | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [paymentOpen, setPaymentOpen] = useState(false);
  const [receiptOpen, setReceiptOpen] = useState(false);

  const refresh = useCallback(() => setReloadKey(k => k + 1), []);
  const paymentsPending = usePendingDeletions('payments', reloadKey);
  const receiptsPending = usePendingDeletions('receipts', reloadKey);

  useEffect(() => {
    api<LedgerEntry[]>('/finance/ledger').then(setLedger);
    api<Payment[]>('/finance/payments').then(setPayments);
    api<Receipt[]>('/finance/receipts').then(setReceipts);
    api<Totals>('/finance/totals').then(setTotals);
  }, [reloadKey]);

  const kpis = totals ? [
    { key: 'revenue', label: 'Revenue', icon: 'chart' as const, value: naira(totals.revenue) },
    { key: 'receivable', label: 'Outstanding receivable', icon: 'clock' as const, value: naira(totals.outstandingReceivable) },
    { key: 'cash', label: 'Cash position', icon: 'wallet' as const, value: naira(totals.cashPosition) },
  ] : [];

  return (
    <>
      <PrintHeader />
      <div className="pagehead">
        <div><h1>Finance</h1><p className="pagesub">The ledger, and every payment and receipt posted against it.</p></div>
      </div>

      <KpiRow kpis={kpis} />

      <Tabs tabs={[
        {
          key: 'ledger', label: 'Ledger', content: (
            <Card title="General ledger" description="Every entry posted by every other module — read-only here by design.">
              <div style={{ overflowX: 'auto' }}>
                <table>
                  <thead><tr><th>Ref</th><th>Account</th><th>Description</th><th className="num">Debit</th><th className="num">Credit</th></tr></thead>
                  <tbody>
                    {ledger.map(l => (
                      <tr key={l.id}>
                        <td className="mono" style={{ fontSize: 12, color: 'rgb(var(--aqua-700))' }}>{l.id}</td>
                        <td>{l.account}</td>
                        <td className="sub">{l.description}</td>
                        <td className="num tnum">{l.debit ? naira(l.debit) : ''}</td>
                        <td className="num tnum">{l.credit ? naira(l.credit) : ''}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {ledger.length === 0 && <EmptyState title="No ledger entries yet" description="Entries post automatically as sales, receipts and payments happen." onClear={() => {}} />}
            </Card>
          ),
        },
        {
          key: 'payments', label: 'Payments', content: (
            <Card title="Payments" description="Money paid out — suppliers, utilities, payroll." action={<button className="btn btn-primary no-print" onClick={() => setPaymentOpen(true)}><Icon name="plus" size={14} /> Record payment</button>}>
              <div style={{ overflowX: 'auto' }}>
                <table>
                  <thead><tr><th>Payment</th><th>Paid to</th><th>Method</th><th className="num">Amount</th><th className="no-print" /></tr></thead>
                  <tbody>
                    {payments.map(p => (
                      <tr key={p.id}>
                        <td className="mono" style={{ fontSize: 12, color: 'rgb(var(--aqua-700))' }}>{p.id}</td>
                        <td>{p.paid_to}</td>
                        <td className="sub">{p.method}</td>
                        <td className="num tnum">{naira(p.amount)}</td>
                        <td className="no-print">
                          <DeleteButton entityType="payments" entityId={p.id} entityLabel={p.id} pending={paymentsPending.has(p.id)} onRequested={() => { refresh(); ui.toast('Deletion requested — pending admin approval'); }} />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {payments.length === 0 && <EmptyState title="No payments recorded" description="Record a payment to a supplier or for an expense." onClear={() => {}} />}
            </Card>
          ),
        },
        {
          key: 'receipts', label: 'Receipts', content: (
            <Card title="Receipts" description="Money received — mostly customer payments against sales orders." action={<button className="btn btn-primary no-print" onClick={() => setReceiptOpen(true)}><Icon name="plus" size={14} /> Record receipt</button>}>
              <div style={{ overflowX: 'auto' }}>
                <table>
                  <thead><tr><th>Receipt</th><th>Received from</th><th>Method</th><th className="num">Amount</th><th className="no-print" /></tr></thead>
                  <tbody>
                    {receipts.map(r => (
                      <tr key={r.id}>
                        <td className="mono" style={{ fontSize: 12, color: 'rgb(var(--aqua-700))' }}>{r.id}</td>
                        <td>{r.received_from}</td>
                        <td className="sub">{r.method}</td>
                        <td className="num tnum">{naira(r.amount)}</td>
                        <td className="no-print">
                          <DeleteButton entityType="receipts" entityId={r.id} entityLabel={r.id} pending={receiptsPending.has(r.id)} onRequested={() => { refresh(); ui.toast('Deletion requested — pending admin approval'); }} />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {receipts.length === 0 && <EmptyState title="No receipts recorded" description="Record a receipt against an outstanding invoice." onClear={() => {}} />}
            </Card>
          ),
        },
      ]} />

      {paymentOpen && <RecordPayment onClose={() => setPaymentOpen(false)} onRecorded={() => { setPaymentOpen(false); refresh(); ui.toast('Payment recorded'); }} />}
      {receiptOpen && <RecordReceipt onClose={() => setReceiptOpen(false)} onRecorded={() => { setReceiptOpen(false); refresh(); ui.toast('Receipt recorded'); }} />}
    </>
  );
}

function RecordPayment({ onClose, onRecorded }: { onClose: () => void; onRecorded: () => void }) {
  const [paidTo, setPaidTo] = useState('');
  const [amount, setAmount] = useState('');
  const [method, setMethod] = useState('Bank transfer');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setSaving(true); setError(null);
    try { await apiPost('/finance/payments', { paidTo, amount: Number(amount), method }); onRecorded(); }
    catch (err) { setError(err instanceof Error ? err.message : 'Something went wrong'); }
    finally { setSaving(false); }
  }

  return (
    <Modal title="Record payment" onClose={onClose} onSubmit={submit} submitLabel="Record" saving={saving} error={error}>
      <div className="form-row"><label htmlFor="pay-to">Paid to</label><input id="pay-to" value={paidTo} onChange={e => setPaidTo(e.target.value)} required autoFocus /></div>
      <div className="form-grid">
        <div className="form-row"><label htmlFor="pay-amount">Amount</label><NumberInput id="pay-amount" value={amount} onChange={setAmount} required /></div>
        <div className="form-row">
          <label htmlFor="pay-method">Method</label>
          <select id="pay-method" value={method} onChange={e => setMethod(e.target.value)}>
            <option>Bank transfer</option><option>Cheque</option><option>Cash</option>
          </select>
        </div>
      </div>
    </Modal>
  );
}

function RecordReceipt({ onClose, onRecorded }: { onClose: () => void; onRecorded: () => void }) {
  const [receivedFrom, setReceivedFrom] = useState('');
  const [amount, setAmount] = useState('');
  const [method, setMethod] = useState('Bank transfer');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setSaving(true); setError(null);
    try { await apiPost('/finance/receipts', { receivedFrom, amount: Number(amount), method }); onRecorded(); }
    catch (err) { setError(err instanceof Error ? err.message : 'Something went wrong'); }
    finally { setSaving(false); }
  }

  return (
    <Modal title="Record receipt" onClose={onClose} onSubmit={submit} submitLabel="Record" saving={saving} error={error}>
      <div className="form-row"><label htmlFor="rct-from">Received from</label><input id="rct-from" value={receivedFrom} onChange={e => setReceivedFrom(e.target.value)} required autoFocus /></div>
      <div className="form-grid">
        <div className="form-row"><label htmlFor="rct-amount">Amount</label><NumberInput id="rct-amount" value={amount} onChange={setAmount} required /></div>
        <div className="form-row">
          <label htmlFor="rct-method">Method</label>
          <select id="rct-method" value={method} onChange={e => setMethod(e.target.value)}>
            <option>Bank transfer</option><option>Cheque</option><option>POS card</option><option>Cash</option>
          </select>
        </div>
      </div>
    </Modal>
  );
}
