import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import { api, apiPost, apiPut } from '../../lib/apiClient';
import { naira, number } from '../../lib/format';
import { useUi } from '../../lib/uiState';
import { Card } from '../../components/ui/Card';
import { Pill } from '../../components/ui/Pill';
import { Modal } from '../../components/ui/Modal';
import { EmptyState } from '../../components/ui/EmptyState';
import { Icon } from '../../components/ui/Icon';
import { NumberInput } from '../../components/ui/NumberInput';

type CustomerType = 'RETAIL' | 'MARKETER' | 'DISTRIBUTOR';
interface Customer { id: string; name: string; location: string | null; customer_type: CustomerType }

interface MarketerCustomer {
  id: string; marketer_id: string; name: string; phone: string | null; location: string | null;
  route: string | null; credit_limit: number; status: 'ACTIVE' | 'INACTIVE'; created_at: string; outstanding: number;
}
type ClassificationRow = MarketerCustomer & { last_sale_at?: string | null };
interface CustomerBalance { invoiced: number; paid: number; outstanding: number }
interface StatementLine { id: number; entry_date: string; debit: number; credit: number; description: string | null; reference_id: string | null; running_balance: number }
interface ProductPurchased { item_id: string; item_name: string; total_quantity: number; total_value: number }
interface CustomerSale { id: string; marketer_id: string; customer_id: string; cash_received: number; created_by: string | null; created_at: string }
interface CustomerPayment { id: string; customer_id: string; amount: number; method: string | null; reference_id: string | null; actor: string | null; paid_at: string }
interface AgingRow { customerId: string; customerName: string; current: number; d31to60: number; d61to90: number; d90plus: number; total: number }
interface MarketerBalance { item_id: string; item_name: string; on_hand: number; unit_price: number }
interface Invoice {
  id: string; customer_id: string; created_at: string; due_date: string | null; collector: string | null;
  products: string; quantity: number; amount: number; balance: number;
  last_payment_date: string | null; last_payment_method: string | null; remarks_count: number;
}
interface CollectionRow extends Invoice {
  customer_name: string; marketer_id: string; marketer_name: string; bucket: 'OVERDUE' | 'DUE_SOON' | 'NO_DUE_DATE' | 'ON_TRACK';
}
interface Remark { id: number; sale_id: string; remark: string; actor: string | null; created_at: string }

const REPORT_VIEWS = ['aging', 'dormant', 'inactive', 'credit', 'cash', 'reminders'] as const;
type ReportView = typeof REPORT_VIEWS[number];

export function CustomersTab({ customers, onAddCompanyCustomer }: { customers: Customer[]; onAddCompanyCustomer: () => void }) {
  const ui = useUi();
  const marketers = useMemo(() => customers.filter(c => c.customer_type === 'MARKETER'), [customers]);
  const [marketerId, setMarketerId] = useState('');
  const [custList, setCustList] = useState<MarketerCustomer[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [balance, setBalance] = useState<CustomerBalance | null>(null);
  const [statement, setStatement] = useState<StatementLine[]>([]);
  const [products, setProducts] = useState<ProductPurchased[]>([]);
  const [payments, setPayments] = useState<CustomerPayment[]>([]);
  const [invoices, setInvoices] = useState<Invoice[]>([]);
  const [reloadKey, setReloadKey] = useState(0);
  const [newCustOpen, setNewCustOpen] = useState(false);
  const [saleOpen, setSaleOpen] = useState(false);
  const [paymentOpen, setPaymentOpen] = useState(false);
  const [followUpTarget, setFollowUpTarget] = useState<Invoice | null>(null);
  const [remarksTarget, setRemarksTarget] = useState<Invoice | null>(null);
  const [invoicePaymentTarget, setInvoicePaymentTarget] = useState<Invoice | null>(null);
  const [reportView, setReportView] = useState<ReportView>('aging');
  const refresh = useCallback(() => setReloadKey(k => k + 1), []);

  useEffect(() => { if (!marketerId && marketers[0]) setMarketerId(marketers[0].id); }, [marketers, marketerId]);
  useEffect(() => {
    if (!marketerId) { setCustList([]); return; }
    api<MarketerCustomer[]>('/marketer-customers', { marketerId }).then(setCustList);
  }, [marketerId, reloadKey]);

  useEffect(() => {
    if (!selectedId) { setBalance(null); setStatement([]); setProducts([]); setPayments([]); setInvoices([]); return; }
    api<CustomerBalance>(`/marketer-customers/${encodeURIComponent(selectedId)}/balance`).then(setBalance);
    api<StatementLine[]>(`/marketer-customers/${encodeURIComponent(selectedId)}/statement`).then(setStatement);
    api<ProductPurchased[]>(`/marketer-customers/${encodeURIComponent(selectedId)}/products-purchased`).then(setProducts);
    api<CustomerPayment[]>(`/marketer-customers/${encodeURIComponent(selectedId)}/payments`).then(setPayments);
    api<Invoice[]>(`/marketer-customers/${encodeURIComponent(selectedId)}/invoices`).then(setInvoices);
  }, [selectedId, reloadKey]);

  const selected = custList.find(c => c.id === selectedId) ?? null;

  return (
    <>
      <Card
        title="Customers" description="Each marketer's own field customers — profile, credit limit, and running balance."
        action={
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }} className="no-print">
            {marketers.length > 0 && (
              <select aria-label="Marketer" value={marketerId} onChange={e => { setMarketerId(e.target.value); setSelectedId(null); }} style={{ minWidth: 160 }}>
                {marketers.map(m => <option key={m.id} value={m.id}>{m.name}</option>)}
              </select>
            )}
            <button className="btn btn-primary btn-sm" onClick={() => (marketerId ? setNewCustOpen(true) : onAddCompanyCustomer())}>
              <Icon name="plus" size={14} /> {marketerId ? 'New field customer' : 'New customer'}
            </button>
          </div>
        }
      >
        {marketers.length === 0 && <EmptyState title="No marketers yet" description="Use “New customer” above to add a Marketer — then you can manage their own field customers here." onClear={() => {}} />}
        <div className="table-wrap">
          <table>
            <thead><tr><th>Name</th><th>Phone</th><th>Route</th><th className="num">Credit limit</th><th className="num">Outstanding</th><th>Status</th></tr></thead>
            <tbody>
              {custList.map(c => (
                <tr key={c.id} className="row-clickable" onClick={() => setSelectedId(c.id)}>
                  <td style={{ fontWeight: c.id === selectedId ? 700 : 500 }}>{c.name}</td>
                  <td className="sub">{c.phone ?? '—'}</td>
                  <td className="sub">{c.route ?? '—'}</td>
                  <td className="num tnum">{c.credit_limit > 0 ? naira(c.credit_limit) : 'Cash only'}</td>
                  <td className="num tnum">{naira(c.outstanding)}</td>
                  <td><Pill status={c.status} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {custList.length === 0 && marketers.length > 0 && <EmptyState title="No customers yet" description="Add this marketer's first field customer." onClear={() => {}} />}
      </Card>

      {selected && balance && (
        <Card
          title={selected.name} description={[selected.phone, selected.location, selected.route].filter(Boolean).join(' · ') || undefined}
          action={
            <div style={{ display: 'flex', gap: 8 }} className="no-print">
              <button className="btn btn-secondary btn-sm" onClick={() => setSaleOpen(true)}>Record sale</button>
              <button className="btn btn-secondary btn-sm" onClick={() => setPaymentOpen(true)} disabled={balance.outstanding <= 0}>Record payment</button>
              <button className="btn btn-primary btn-sm" onClick={() => window.print()}><Icon name="print" size={14} /> Print</button>
            </div>
          }
        >
          <div style={{ display: 'flex', gap: 24, flexWrap: 'wrap', padding: '10px 20px 16px' }}>
            <p className="sub">Invoiced <strong style={{ color: 'rgb(var(--ink))' }}>{naira(balance.invoiced)}</strong></p>
            <p className="sub">Paid <strong style={{ color: 'rgb(var(--ink))' }}>{naira(balance.paid)}</strong></p>
            <p className="sub">Outstanding <strong style={{ color: 'rgb(var(--ink))' }}>{naira(balance.outstanding)}</strong></p>
          </div>

          <p className="card-title" style={{ padding: '4px 20px', fontSize: 14 }}>Invoices</p>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Invoice</th><th>Date</th><th>Product</th><th className="num">Qty</th><th className="num">Amount</th>
                  <th>Due date</th><th>Collector</th><th className="num">Balance</th><th>Last payment</th><th className="no-print">Action</th>
                </tr>
              </thead>
              <tbody>
                {invoices.map(inv => (
                  <tr key={inv.id}>
                    <td className="mono" style={{ fontSize: 12, color: 'rgb(var(--aqua-700))' }}>{inv.id}</td>
                    <td className="sub">{inv.created_at}</td>
                    <td>{inv.products}</td>
                    <td className="num tnum">{number(inv.quantity)}</td>
                    <td className="num tnum">{naira(inv.amount)}</td>
                    <td className="sub">{inv.due_date ?? '—'}</td>
                    <td className="sub">{inv.collector ?? '—'}</td>
                    <td className="num tnum">{naira(inv.balance)}</td>
                    <td className="sub">{inv.last_payment_date ? `${inv.last_payment_date} (${inv.last_payment_method})` : '—'}</td>
                    <td className="no-print">
                      <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                        <button className="btn btn-secondary btn-sm" onClick={() => setFollowUpTarget(inv)}>Follow-up</button>
                        <button className="btn btn-secondary btn-sm" onClick={() => setRemarksTarget(inv)}>Remarks ({inv.remarks_count})</button>
                        {inv.balance > 0 && <button className="btn btn-secondary btn-sm" onClick={() => setInvoicePaymentTarget(inv)}>Pay</button>}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {invoices.length === 0 && <EmptyState title="No invoices yet" description="Appears once a sale is recorded against this customer." onClear={() => {}} />}

          <p className="card-title" style={{ padding: '16px 20px 4px', fontSize: 14 }}>Statement</p>
          <div className="table-wrap">
            <table>
              <thead><tr><th>Ref</th><th>Date</th><th>Description</th><th className="num">Debit</th><th className="num">Credit</th><th className="num">Balance</th></tr></thead>
              <tbody>
                {statement.map(l => (
                  <tr key={l.id}>
                    <td className="mono" style={{ fontSize: 12 }}>{l.reference_id ?? l.id}</td>
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
          {statement.length === 0 && <EmptyState title="No activity yet" description="Nothing sold or paid against this customer yet." onClear={() => {}} />}

          <p className="card-title" style={{ padding: '16px 20px 4px', fontSize: 14 }}>Products purchased</p>
          <div className="table-wrap">
            <table>
              <thead><tr><th>Item</th><th className="num">Quantity</th><th className="num">Value</th></tr></thead>
              <tbody>
                {products.map(p => (
                  <tr key={p.item_id}><td>{p.item_name}</td><td className="num tnum">{number(p.total_quantity)}</td><td className="num tnum">{naira(p.total_value)}</td></tr>
                ))}
              </tbody>
            </table>
          </div>
          {products.length === 0 && <EmptyState title="Nothing purchased yet" description="Appears once a sale is recorded against this customer." onClear={() => {}} />}

          <p className="card-title" style={{ padding: '16px 20px 4px', fontSize: 14 }}>Payment history</p>
          <div className="table-wrap">
            <table>
              <thead><tr><th>Payment</th><th>Date</th><th>Method</th><th className="num">Amount</th></tr></thead>
              <tbody>
                {payments.map(p => (
                  <tr key={p.id}><td className="mono" style={{ fontSize: 12 }}>{p.id}</td><td className="sub">{p.paid_at}</td><td className="sub">{p.method}</td><td className="num tnum">{naira(p.amount)}</td></tr>
                ))}
              </tbody>
            </table>
          </div>
          {payments.length === 0 && <EmptyState title="No payments yet" description="Recorded when this customer pays down their balance." onClear={() => {}} />}
        </Card>
      )}

      <Card
        title="Reports" description="Aging, dormancy, credit/cash classification, and collection reminders across every marketer's customers."
        action={
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }} className="no-print">
            {REPORT_VIEWS.map(v => (
              <button key={v} className={`btn btn-sm ${reportView === v ? 'btn-primary' : 'btn-secondary'}`} onClick={() => setReportView(v)}>{v[0].toUpperCase() + v.slice(1)}</button>
            ))}
          </div>
        }
      >
        <ReportTable view={reportView} reloadKey={reloadKey} />
      </Card>

      {newCustOpen && (
        <NewCustomerModal marketerId={marketerId} onClose={() => setNewCustOpen(false)} onCreated={() => { setNewCustOpen(false); refresh(); ui.toast('Customer added'); }} />
      )}
      {saleOpen && selected && (
        <RecordCustomerSale marketerId={marketerId} customer={selected} onClose={() => setSaleOpen(false)}
          onRecorded={() => { setSaleOpen(false); refresh(); ui.toast('Sale recorded'); }} />
      )}
      {paymentOpen && selected && balance && (
        <RecordCustomerPayment customer={selected} outstanding={balance.outstanding} onClose={() => setPaymentOpen(false)}
          onRecorded={() => { setPaymentOpen(false); refresh(); ui.toast('Payment recorded'); }} />
      )}
      {followUpTarget && (
        <AssignFollowUpModal invoice={followUpTarget} onClose={() => setFollowUpTarget(null)}
          onAssigned={() => { setFollowUpTarget(null); refresh(); ui.toast('Follow-up assigned'); }} />
      )}
      {remarksTarget && (
        <RemarksModal invoice={remarksTarget} onClose={() => setRemarksTarget(null)} onAdded={refresh} />
      )}
      {invoicePaymentTarget && selected && (
        <RecordInvoicePayment customer={selected} invoice={invoicePaymentTarget} onClose={() => setInvoicePaymentTarget(null)}
          onRecorded={() => { setInvoicePaymentTarget(null); refresh(); ui.toast('Payment recorded'); }} />
      )}
    </>
  );
}

function ReportTable({ view, reloadKey }: { view: ReportView; reloadKey: number }) {
  const [aging, setAging] = useState<AgingRow[]>([]);
  const [rows, setRows] = useState<ClassificationRow[]>([]);
  const [collections, setCollections] = useState<CollectionRow[]>([]);

  useEffect(() => {
    if (view === 'aging') { api<AgingRow[]>('/marketer-customers/reports/aging').then(setAging); return; }
    if (view === 'reminders') { api<CollectionRow[]>('/marketer-customers/reports/collections').then(setCollections); return; }
    api<ClassificationRow[]>(`/marketer-customers/reports/${view}`).then(setRows);
  }, [view, reloadKey]);

  if (view === 'aging') {
    return (
      <>
        <div className="table-wrap">
          <table>
            <thead><tr><th>Customer</th><th className="num">Current</th><th className="num">31–60 days</th><th className="num">61–90 days</th><th className="num">90+ days</th><th className="num">Total</th></tr></thead>
            <tbody>
              {aging.map(a => (
                <tr key={a.customerId}>
                  <td>{a.customerName}</td>
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
        {aging.length === 0 && <EmptyState title="Nothing outstanding" description="No customer currently owes a balance." onClear={() => {}} />}
      </>
    );
  }

  if (view === 'reminders') {
    return (
      <>
        <div className="table-wrap">
          <table>
            <thead><tr><th>Marketer</th><th>Customer</th><th>Invoice</th><th>Product</th><th className="num">Balance</th><th>Due date</th><th>Collector</th><th>Status</th></tr></thead>
            <tbody>
              {collections.map(c => (
                <tr key={c.id}>
                  <td>{c.marketer_name}</td>
                  <td>{c.customer_name}</td>
                  <td className="mono" style={{ fontSize: 12 }}>{c.id}</td>
                  <td className="sub">{c.products}</td>
                  <td className="num tnum">{naira(c.balance)}</td>
                  <td className="sub">{c.due_date ?? '—'}</td>
                  <td className="sub">{c.collector ?? '—'}</td>
                  <td><Pill status={c.bucket} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {collections.length === 0 && <EmptyState title="Nothing to follow up" description="Every credit invoice is either settled or not yet due." onClear={() => {}} />}
      </>
    );
  }

  return (
    <>
      <div className="table-wrap">
        <table>
          <thead>
            <tr><th>Name</th><th>Phone</th><th>Route</th><th className="num">Credit limit</th><th>Status</th>{view === 'dormant' && <th>Last sale</th>}</tr>
          </thead>
          <tbody>
            {rows.map(c => (
              <tr key={c.id}>
                <td>{c.name}</td>
                <td className="sub">{c.phone ?? '—'}</td>
                <td className="sub">{c.route ?? '—'}</td>
                <td className="num tnum">{c.credit_limit > 0 ? naira(c.credit_limit) : 'Cash only'}</td>
                <td><Pill status={c.status} /></td>
                {view === 'dormant' && <td className="sub">{c.last_sale_at ?? 'Never purchased'}</td>}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {rows.length === 0 && <EmptyState title="Nothing here" description="No customers currently match this view." onClear={() => {}} />}
    </>
  );
}

function NewCustomerModal({ marketerId, onClose, onCreated }: { marketerId: string; onClose: () => void; onCreated: () => void }) {
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [location, setLocation] = useState('');
  const [route, setRoute] = useState('');
  const [creditLimit, setCreditLimit] = useState('0');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setSaving(true); setError(null);
    try {
      await apiPost('/marketer-customers', {
        marketerId, name, phone: phone || undefined, location: location || undefined, route: route || undefined, creditLimit: Number(creditLimit) || 0,
      });
      onCreated();
    } catch (err) { setError(err instanceof Error ? err.message : 'Something went wrong'); }
    finally { setSaving(false); }
  }

  return (
    <Modal title="New customer" onClose={onClose} onSubmit={submit} submitLabel="Add customer" saving={saving} error={error}>
      <div className="form-row"><label htmlFor="mc-name">Name</label><input id="mc-name" value={name} onChange={e => setName(e.target.value)} required autoFocus /></div>
      <div className="form-grid">
        <div className="form-row"><label htmlFor="mc-phone">Phone</label><input id="mc-phone" value={phone} onChange={e => setPhone(e.target.value)} /></div>
        <div className="form-row"><label htmlFor="mc-location">Location</label><input id="mc-location" value={location} onChange={e => setLocation(e.target.value)} /></div>
        <div className="form-row"><label htmlFor="mc-route">Route</label><input id="mc-route" value={route} onChange={e => setRoute(e.target.value)} /></div>
        <div className="form-row">
          <label htmlFor="mc-credit">Credit limit (0 = cash only)</label>
          <NumberInput id="mc-credit" value={creditLimit} onChange={setCreditLimit} />
        </div>
      </div>
    </Modal>
  );
}

function RecordCustomerSale({ marketerId, customer, onClose, onRecorded }: {
  marketerId: string; customer: MarketerCustomer; onClose: () => void; onRecorded: () => void;
}) {
  const [lines, setLines] = useState<{ itemId: string; name: string; onHand: number; unitPrice: number; quantity: string }[]>([]);
  const [cashReceived, setCashReceived] = useState('0');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api<MarketerBalance[]>(`/marketer-stock/${encodeURIComponent(marketerId)}/balances`).then(rows => {
      setLines(rows.map(b => ({ itemId: b.item_id, name: b.item_name, onHand: b.on_hand, unitPrice: b.unit_price, quantity: '0' })));
    });
  }, [marketerId]);

  const totalValue = lines.reduce((s, l) => s + (Number(l.quantity) || 0) * l.unitPrice, 0);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setSaving(true); setError(null);
    try {
      await apiPost(`/marketer-customers/${encodeURIComponent(customer.id)}/sales`, {
        marketerId, cashReceived: Number(cashReceived) || 0,
        items: lines.filter(l => Number(l.quantity) > 0).map(l => ({ itemId: l.itemId, quantity: Number(l.quantity) })),
      });
      onRecorded();
    } catch (err) { setError(err instanceof Error ? err.message : 'Something went wrong'); }
    finally { setSaving(false); }
  }

  return (
    <Modal title={`Record sale — ${customer.name}`} onClose={onClose} onSubmit={submit} submitLabel="Record" saving={saving} error={error} wide>
      {lines.length === 0 && <p className="sub">This marketer isn't currently holding any stock.</p>}
      {lines.map((l, i) => (
        <div className="lineitem-row" key={l.itemId}>
          <div style={{ flex: 2 }}><p style={{ fontSize: 13 }}>{l.name}</p><p className="sub" style={{ fontSize: 12 }}>Holding {l.onHand.toLocaleString('en-NG')} @ {naira(l.unitPrice)}</p></div>
          <div style={{ width: 100 }}>
            <NumberInput ariaLabel={`Quantity sold for ${l.name}`} allowDecimal={false} value={l.quantity}
              onChange={v => setLines(ls => ls.map((x, idx) => idx === i ? { ...x, quantity: v } : x))} />
          </div>
        </div>
      ))}
      <div className="form-row">
        <label htmlFor="mcs-cash">Cash received (of {naira(totalValue)} sold)</label>
        <NumberInput id="mcs-cash" ariaLabel="Cash received" value={cashReceived} onChange={setCashReceived} />
      </div>
      {customer.credit_limit <= 0 ? (
        <p className="sub">{customer.name} is a cash customer (no credit limit) — full payment is required.</p>
      ) : (
        <p className="sub">Credit limit {naira(customer.credit_limit)}. Currently owes {naira(customer.outstanding)}.</p>
      )}
    </Modal>
  );
}

function RecordCustomerPayment({ customer, outstanding, onClose, onRecorded }: {
  customer: MarketerCustomer; outstanding: number; onClose: () => void; onRecorded: () => void;
}) {
  const [amount, setAmount] = useState(String(outstanding));
  const [method, setMethod] = useState('Cash');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setSaving(true); setError(null);
    try {
      await apiPost(`/marketer-customers/${encodeURIComponent(customer.id)}/payments`, { amount: Number(amount), method });
      onRecorded();
    } catch (err) { setError(err instanceof Error ? err.message : 'Something went wrong'); }
    finally { setSaving(false); }
  }

  return (
    <Modal title={`Record payment — ${customer.name}`} onClose={onClose} onSubmit={submit} submitLabel="Record" saving={saving} error={error}>
      <p className="sub" style={{ marginBottom: 10 }}>Currently owes {naira(outstanding)}.</p>
      <div className="form-row"><label htmlFor="mcp-amount">Amount</label><NumberInput id="mcp-amount" value={amount} onChange={setAmount} required autoFocus /></div>
      <div className="form-row">
        <label htmlFor="mcp-method">Method</label>
        <select id="mcp-method" value={method} onChange={e => setMethod(e.target.value)}>
          <option value="Cash">Cash</option>
          <option value="Bank transfer">Bank transfer</option>
          <option value="POS card">POS card</option>
        </select>
      </div>
    </Modal>
  );
}

function AssignFollowUpModal({ invoice, onClose, onAssigned }: { invoice: Invoice; onClose: () => void; onAssigned: () => void }) {
  const [dueDate, setDueDate] = useState(invoice.due_date ?? '');
  const [collector, setCollector] = useState(invoice.collector ?? '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setSaving(true); setError(null);
    try {
      await apiPut(`/marketer-customers/sales/${encodeURIComponent(invoice.id)}/follow-up`, {
        dueDate: dueDate || undefined, collector: collector || undefined,
      });
      onAssigned();
    } catch (err) { setError(err instanceof Error ? err.message : 'Something went wrong'); }
    finally { setSaving(false); }
  }

  return (
    <Modal title={`Assign follow-up — ${invoice.id}`} onClose={onClose} onSubmit={submit} submitLabel="Save" saving={saving} error={error}>
      <div className="form-grid">
        <div className="form-row"><label htmlFor="fu-due">Due date</label><input id="fu-due" type="date" value={dueDate} onChange={e => setDueDate(e.target.value)} /></div>
        <div className="form-row"><label htmlFor="fu-collector">Collector</label><input id="fu-collector" value={collector} onChange={e => setCollector(e.target.value)} placeholder="Who's chasing this invoice" /></div>
      </div>
    </Modal>
  );
}

function RemarksModal({ invoice, onClose, onAdded }: { invoice: Invoice; onClose: () => void; onAdded: () => void }) {
  const [remarks, setRemarks] = useState<Remark[] | null>(null);
  const [text, setText] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    api<Remark[]>(`/marketer-customers/sales/${encodeURIComponent(invoice.id)}/remarks`).then(setRemarks);
  }, [invoice.id]);
  useEffect(() => { load(); }, [load]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!text.trim()) return;
    setSaving(true); setError(null);
    try {
      await apiPost(`/marketer-customers/sales/${encodeURIComponent(invoice.id)}/remarks`, { remark: text.trim() });
      setText('');
      load();
      onAdded();
    } catch (err) { setError(err instanceof Error ? err.message : 'Something went wrong'); }
    finally { setSaving(false); }
  }

  return (
    <Modal title={`Remarks — ${invoice.id}`} onClose={onClose} onSubmit={submit} submitLabel="Add remark" saving={saving} error={error} wide>
      <div className="form-row">
        <label>History</label>
        {remarks === null && <p className="sub">Loading…</p>}
        {remarks?.length === 0 && <p className="sub">No remarks yet.</p>}
        {remarks?.map(r => (
          <div key={r.id} style={{ padding: '8px 0', borderBottom: '1px solid rgb(var(--border))' }}>
            <p style={{ fontSize: 13 }}>{r.remark}</p>
            <p className="sub" style={{ fontSize: 12 }}>{r.actor ?? 'Unknown'} · {r.created_at}</p>
          </div>
        ))}
      </div>
      <div className="form-row"><label htmlFor="remark-text">New remark</label><input id="remark-text" value={text} onChange={e => setText(e.target.value)} autoFocus /></div>
    </Modal>
  );
}

function RecordInvoicePayment({ customer, invoice, onClose, onRecorded }: {
  customer: MarketerCustomer; invoice: Invoice; onClose: () => void; onRecorded: () => void;
}) {
  const [amount, setAmount] = useState(String(invoice.balance));
  const [method, setMethod] = useState('Cash');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setSaving(true); setError(null);
    try {
      await apiPost(`/marketer-customers/${encodeURIComponent(customer.id)}/payments`, { amount: Number(amount), method, saleId: invoice.id });
      onRecorded();
    } catch (err) { setError(err instanceof Error ? err.message : 'Something went wrong'); }
    finally { setSaving(false); }
  }

  return (
    <Modal title={`Record payment — ${invoice.id}`} onClose={onClose} onSubmit={submit} submitLabel="Record" saving={saving} error={error}>
      <p className="sub" style={{ marginBottom: 10 }}>{customer.name} owes {naira(invoice.balance)} on this invoice.</p>
      <div className="form-row"><label htmlFor="ip-amount">Amount</label><NumberInput id="ip-amount" value={amount} onChange={setAmount} required autoFocus /></div>
      <div className="form-row">
        <label htmlFor="ip-method">Method</label>
        <select id="ip-method" value={method} onChange={e => setMethod(e.target.value)}>
          <option value="Cash">Cash</option>
          <option value="Bank transfer">Bank transfer</option>
          <option value="POS card">POS card</option>
        </select>
      </div>
    </Modal>
  );
}
