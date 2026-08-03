import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
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
import { ReverseButton } from '../../components/ui/ReverseButton';
import { NumberInput } from '../../components/ui/NumberInput';
import { useReversedEntities } from '../../lib/reversedEntities';
import { ReportToolbar } from '../../components/ui/ReportToolbar';
import { inRange, type DateRange } from '../../lib/reportExport';
import type { CsvColumn } from '../../lib/csv';

interface LedgerEntry { id: string; entry_date: string; account: string; debit: number; credit: number; description: string | null }
interface Payment {
  id: string; paid_to: string; amount: number; method: string | null; status: string; paid_at: string;
  supplier_id?: string | null; reference_type?: string | null; reference_id?: string | null;
}
interface Receipt { id: string; received_from: string; amount: number; method: string | null; status: string; received_at: string }
interface Totals { revenue: number; outstandingReceivable: number; cashPosition: number }
interface Supplier { id: string; name: string; location?: string | null }
interface PayableRow { supplier_id: string; supplier_name: string; invoiced: number; paid: number; outstanding: number }
interface AgingRow { supplierId: string; supplierName: string; current: number; d31to60: number; d61to90: number; d90plus: number; total: number }

export default function FinancePage() {
  const ui = useUi();
  const [ledger, setLedger] = useState<LedgerEntry[]>([]);
  const [payments, setPayments] = useState<Payment[]>([]);
  const [receipts, setReceipts] = useState<Receipt[]>([]);
  const [totals, setTotals] = useState<Totals | null>(null);
  const [suppliers, setSuppliers] = useState<Supplier[]>([]);
  const [payables, setPayables] = useState<PayableRow[]>([]);
  const [aging, setAging] = useState<AgingRow[]>([]);
  const [reloadKey, setReloadKey] = useState(0);
  const [paymentOpen, setPaymentOpen] = useState(false);
  const [receiptOpen, setReceiptOpen] = useState(false);
  const [statementSupplierId, setStatementSupplierId] = useState<string | null>(null);
  const [receiptRange, setReceiptRange] = useState<DateRange | null>(null);

  const refresh = useCallback(() => setReloadKey(k => k + 1), []);
  const paymentsReversed = useReversedEntities('payments', reloadKey);
  const receiptsReversed = useReversedEntities('receipts', reloadKey);

  useEffect(() => {
    api<LedgerEntry[]>('/finance/ledger').then(setLedger);
    api<Payment[]>('/finance/payments').then(setPayments);
    api<Receipt[]>('/finance/receipts').then(setReceipts);
    api<Totals>('/finance/totals').then(setTotals);
    api<PayableRow[]>('/finance/payables').then(setPayables);
    api<AgingRow[]>('/finance/aging').then(setAging);
  }, [reloadKey]);

  useEffect(() => { api<Supplier[]>('/masters/suppliers').then(setSuppliers); }, []);

  const filteredReceipts = useMemo(() => receipts.filter(r => inRange(r.received_at, receiptRange)), [receipts, receiptRange]);
  const receiptColumns: CsvColumn<Receipt>[] = useMemo(() => [
    { label: 'Receipt', get: r => r.id },
    { label: 'Received from', get: r => r.received_from },
    { label: 'Method', get: r => r.method ?? '' },
    { label: 'Date', get: r => r.received_at },
    { label: 'Amount', get: r => r.amount },
    { label: 'Status', get: r => r.status },
  ], []);

  const totalPayable = payables.reduce((s, p) => s + p.outstanding, 0);
  const kpis = totals ? [
    { key: 'revenue', label: 'Revenue', icon: 'chart' as const, value: naira(totals.revenue) },
    { key: 'receivable', label: 'Outstanding receivable', icon: 'clock' as const, value: naira(totals.outstandingReceivable) },
    { key: 'payable', label: 'Outstanding payable', icon: 'receipt' as const, value: naira(Math.max(totalPayable, 0)) },
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
              <div className="table-wrap">
                <table>
                  <thead><tr><th>Ref</th><th>Account</th><th>Description</th><th>Date</th><th className="num">Debit</th><th className="num">Credit</th></tr></thead>
                  <tbody>
                    {ledger.map(l => (
                      <tr key={l.id}>
                        <td className="mono" style={{ fontSize: 12, color: 'rgb(var(--aqua-700))' }}>{l.id}</td>
                        <td>{l.account}</td>
                        <td className="sub">{l.description}</td>
                        <td className="sub">{l.entry_date}</td>
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
              <div className="table-wrap">
                <table>
                  <thead><tr><th>Payment</th><th>Paid to</th><th>Method</th><th>Date</th><th className="num">Amount</th><th className="no-print" /></tr></thead>
                  <tbody>
                    {payments.map(p => (
                      <tr key={p.id}>
                        <td className="mono" style={{ fontSize: 12, color: 'rgb(var(--aqua-700))' }}>{p.id}</td>
                        <td>{p.paid_to}</td>
                        <td className="sub">{p.method}</td>
                        <td className="sub">{p.paid_at}</td>
                        <td className="num tnum">{naira(p.amount)}</td>
                        <td className="no-print">
                          <ReverseButton entityType="payments" entityId={p.id} entityLabel={p.id} reversed={paymentsReversed.has(p.id)} onReversed={() => { refresh(); ui.toast('Payment reversed'); }} />
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
            <Card title="Receipts" description={`${filteredReceipts.length} of ${receipts.length} receipts shown — money received, mostly customer payments against sales orders.`} action={<button className="btn btn-primary no-print" onClick={() => setReceiptOpen(true)}><Icon name="plus" size={14} /> Record receipt</button>}>
              <ReportToolbar rows={filteredReceipts} columns={receiptColumns} filenameBase="elim-receipts" onRangeChange={setReceiptRange} />
              <div className="table-wrap">
                <table>
                  <thead><tr><th>Receipt</th><th>Received from</th><th>Method</th><th>Date</th><th className="num">Amount</th><th className="no-print" /></tr></thead>
                  <tbody>
                    {filteredReceipts.map(r => (
                      <tr key={r.id}>
                        <td className="mono" style={{ fontSize: 12, color: 'rgb(var(--aqua-700))' }}>{r.id}</td>
                        <td>{r.received_from}</td>
                        <td className="sub">{r.method}</td>
                        <td className="sub">{r.received_at}</td>
                        <td className="num tnum">{naira(r.amount)}</td>
                        <td className="no-print">
                          <ReverseButton entityType="receipts" entityId={r.id} entityLabel={r.id} reversed={receiptsReversed.has(r.id)} onReversed={() => { refresh(); ui.toast('Receipt reversed'); }} />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {filteredReceipts.length === 0 && <EmptyState title={receipts.length === 0 ? 'No receipts recorded' : 'No receipts match that range'} description="Record a receipt against an outstanding invoice." onClear={() => {}} />}
            </Card>
          ),
        },
        {
          key: 'supplier-accounts', label: 'Supplier accounts', content: (
            statementSupplierId ? (
              <SupplierStatement
                supplierId={statementSupplierId}
                supplier={suppliers.find(s => s.id === statementSupplierId) ?? null}
                onBack={() => setStatementSupplierId(null)}
              />
            ) : (
              <Card title="Supplier accounts" description="Every supplier's account — invoiced, paid, and what's outstanding. Every supplier becomes an account automatically the moment goods are accepted or paid for.">
                <div className="table-wrap">
                  <table>
                    <thead><tr><th>Supplier</th><th className="num">Invoiced</th><th className="num">Paid</th><th className="num">Balance</th><th /><th className="no-print" /></tr></thead>
                    <tbody>
                      {payables.map(p => (
                        <tr key={p.supplier_id} style={{ cursor: 'pointer' }} onClick={() => setStatementSupplierId(p.supplier_id)}>
                          <td>{p.supplier_name}</td>
                          <td className="num tnum">{naira(p.invoiced)}</td>
                          <td className="num tnum">{naira(p.paid)}</td>
                          <td className="num tnum">{naira(Math.abs(p.outstanding))}</td>
                          <td className="sub">{p.outstanding > 0 ? 'Debit balance' : p.outstanding < 0 ? 'Credit balance' : 'Settled'}</td>
                          <td className="no-print"><button className="btn btn-secondary btn-sm" onClick={e => { e.stopPropagation(); setStatementSupplierId(p.supplier_id); }}>Statement</button></td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                {payables.length === 0 && <EmptyState title="No supplier accounts yet" description="An account appears the moment a GRN is accepted or a supplier is paid." onClear={() => {}} />}
              </Card>
            )
          ),
        },
        {
          key: 'supplier-aging', label: 'Supplier aging', content: (
            <Card title="Supplier aging" description="Outstanding balances, bucketed by how long the invoice behind them has been open — payments applied oldest-invoice-first.">
              <div className="table-wrap">
                <table>
                  <thead><tr><th>Supplier</th><th className="num">Current</th><th className="num">31–60 days</th><th className="num">61–90 days</th><th className="num">90+ days</th><th className="num">Total</th></tr></thead>
                  <tbody>
                    {aging.map(a => (
                      <tr key={a.supplierId}>
                        <td>{a.supplierName}</td>
                        <td className="num tnum">{naira(a.current)}</td>
                        <td className="num tnum">{naira(a.d31to60)}</td>
                        <td className="num tnum">{naira(a.d61to90)}</td>
                        <td className="num tnum">{naira(a.d90plus)}</td>
                        <td className="num tnum">{naira(a.total)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {aging.length === 0 && <EmptyState title="Nothing outstanding" description="Every supplier is fully paid up." onClear={() => {}} />}
            </Card>
          ),
        },
      ]} />

      {paymentOpen && <RecordPayment suppliers={suppliers} onClose={() => setPaymentOpen(false)} onRecorded={() => { setPaymentOpen(false); refresh(); ui.toast('Payment recorded'); }} />}
      {receiptOpen && <RecordReceipt onClose={() => setReceiptOpen(false)} onRecorded={() => { setReceiptOpen(false); refresh(); ui.toast('Receipt recorded'); }} />}
    </>
  );
}

function SupplierStatement({ supplierId, supplier, onBack }: { supplierId: string; supplier: Supplier | null; onBack: () => void }) {
  const [balance, setBalance] = useState<{ invoiced: number; paid: number; outstanding: number } | null>(null);
  const [lines, setLines] = useState<(LedgerEntry & { running_balance: number })[]>([]);
  const [history, setHistory] = useState<Payment[]>([]);

  useEffect(() => {
    api<{ invoiced: number; paid: number; outstanding: number }>(`/finance/suppliers/${encodeURIComponent(supplierId)}/balance`).then(setBalance);
    api<(LedgerEntry & { running_balance: number })[]>(`/finance/suppliers/${encodeURIComponent(supplierId)}/statement`).then(setLines);
    api<Payment[]>('/finance/payments', { supplierId }).then(setHistory);
  }, [supplierId]);

  return (
    <Card
      title={`Statement — ${supplier?.name ?? supplierId}`}
      description={supplier?.location ?? undefined}
      action={
        <div style={{ display: 'flex', gap: 8 }} className="no-print">
          <button className="btn btn-secondary btn-sm" onClick={onBack}>Back to accounts</button>
          <button className="btn btn-primary btn-sm" onClick={() => window.print()}><Icon name="print" size={14} /> Print statement</button>
        </div>
      }
    >
      {balance && (
        <div style={{ display: 'flex', gap: 24, padding: '4px 20px 16px' }}>
          <p className="sub">Invoiced <strong style={{ color: 'rgb(var(--ink))' }}>{naira(balance.invoiced)}</strong></p>
          <p className="sub">Paid <strong style={{ color: 'rgb(var(--ink))' }}>{naira(balance.paid)}</strong></p>
          <p className="sub">{balance.outstanding >= 0 ? 'Debit balance' : 'Credit balance'} <strong style={{ color: 'rgb(var(--ink))' }}>{naira(Math.abs(balance.outstanding))}</strong></p>
        </div>
      )}

      <div className="table-wrap">
        <table>
          <thead><tr><th>Ref</th><th>Date</th><th>Description</th><th className="num">Debit</th><th className="num">Credit</th><th className="num">Balance</th></tr></thead>
          <tbody>
            {lines.map(l => (
              <tr key={l.id}>
                <td className="mono" style={{ fontSize: 12 }}>{l.id}</td>
                <td className="sub">{l.entry_date}</td>
                <td className="sub">{l.description}</td>
                <td className="num tnum">{l.debit ? naira(l.debit) : ''}</td>
                <td className="num tnum">{l.credit ? naira(l.credit) : ''}</td>
                <td className="num tnum">{naira(l.running_balance)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {lines.length === 0 && <EmptyState title="No activity yet" description="Nothing invoiced or paid against this supplier yet." onClear={() => {}} />}

      <p className="card-title" style={{ padding: '16px 20px 4px', fontSize: 14 }}>Payment history</p>
      <div className="table-wrap">
        <table>
          <thead><tr><th>Payment</th><th>Date</th><th>Method</th><th>Reference</th><th className="num">Amount</th></tr></thead>
          <tbody>
            {history.map(p => (
              <tr key={p.id}>
                <td className="mono" style={{ fontSize: 12 }}>{p.id}</td>
                <td className="sub">{p.paid_at}</td>
                <td className="sub">{p.method}</td>
                <td className="sub">{p.reference_id ?? '—'}</td>
                <td className="num tnum">{naira(p.amount)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {history.length === 0 && <EmptyState title="No payments yet" description="Payments recorded against this supplier show up here." onClear={() => {}} />}
    </Card>
  );
}

function RecordPayment({ suppliers, onClose, onRecorded }: { suppliers: Supplier[]; onClose: () => void; onRecorded: () => void }) {
  const [supplierId, setSupplierId] = useState('');
  const [paidTo, setPaidTo] = useState('');
  const [amount, setAmount] = useState('');
  const [method, setMethod] = useState('Bank transfer');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setSaving(true); setError(null);
    try { await apiPost('/finance/payments', { paidTo, amount: Number(amount), method, supplierId: supplierId || undefined }); onRecorded(); }
    catch (err) { setError(err instanceof Error ? err.message : 'Something went wrong'); }
    finally { setSaving(false); }
  }

  return (
    <Modal title="Record payment" onClose={onClose} onSubmit={submit} submitLabel="Record" saving={saving} error={error}>
      <div className="form-row">
        <label htmlFor="pay-supplier">Supplier (optional)</label>
        <select id="pay-supplier" value={supplierId} onChange={e => {
          const id = e.target.value;
          setSupplierId(id);
          const s = suppliers.find(x => x.id === id);
          if (s) setPaidTo(s.name);
        }}>
          <option value="">Not a registered supplier</option>
          {suppliers.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
        </select>
      </div>
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
      {supplierId && <p className="sub">This will be applied against {paidTo}'s outstanding balance (Accounts payable) rather than booked as a general expense.</p>}
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
