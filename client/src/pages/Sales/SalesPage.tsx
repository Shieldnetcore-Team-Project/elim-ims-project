import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import { api, apiPost } from '../../lib/apiClient';
import { naira, number } from '../../lib/format';
import { useUi } from '../../lib/uiState';
import { Card } from '../../components/ui/Card';
import { KpiRow } from '../../components/ui/KpiCard';
import { Pill } from '../../components/ui/Pill';
import { Tabs } from '../../components/ui/Tabs';
import { Modal } from '../../components/ui/Modal';
import { LineItemsInput, type LineItemValue } from '../../components/ui/LineItemsInput';
import { EmptyState } from '../../components/ui/EmptyState';
import { Icon } from '../../components/ui/Icon';
import { PrintHeader } from '../../components/ui/PrintHeader';
import { DeleteButton } from '../../components/ui/DeleteButton';
import { ReverseButton } from '../../components/ui/ReverseButton';
import { DispatchButton } from '../../components/ui/DispatchButton';
import { NumberInput } from '../../components/ui/NumberInput';
import { usePendingDeletions } from '../../lib/pendingDeletions';
import { useReversedEntities } from '../../lib/reversedEntities';
import { useCurrentUser } from '../../lib/currentUser';
import { refreshPendingCounts, usePendingCounts } from '../../lib/pendingCounts';
import { CustomersTab } from './CustomersTab';
import { DistributorBranchesTab } from './DistributorBranchesTab';
import { PosReceiptModal } from './PosReceiptModal';
import { PosInvoiceModal } from './PosInvoiceModal';
import { RetailExchangeModal } from './RetailExchangeModal';
import { RetailExchangesTab } from './RetailExchangesTab';
import { MarketerReconciliationTab } from './MarketerReconciliationTab';
import { CreditSalesTab } from './CreditSalesTab';
import { MarketerPerformanceTab } from './MarketerPerformanceTab';
import { RetailIntakeTab } from './RetailIntakeTab';
import { RetailCustomersTab } from './RetailCustomersTab';
import { RetailReconciliationTab } from './RetailReconciliationTab';

type CustomerType = 'RETAIL' | 'MARKETER' | 'DISTRIBUTOR';
type PaymentTerms = 'CASH' | 'ADVANCE' | 'CREDIT';
const POS_METHODS = ['Cash', 'Transfer', 'POS Terminal'] as const;
type PosMethod = typeof POS_METHODS[number];

interface SalesOrder {
  id: string; customer_id: string | null; customer_name: string; customer_location: string | null; customer_type: CustomerType | null;
  channel: 'INVOICE' | 'POS'; rep: string; status: string; payment_terms: PaymentTerms; total_amount: number; created_at: string;
  branch_id: string | null; manual_invoice_number: string | null;
}
interface Customer { id: string; name: string; location: string | null; phone: string | null; customer_type: CustomerType }
interface Item { id: string; name: string; type: string; unit_cost: number }
interface SalesItem { id: number; sales_id: string; item_id: string; quantity: number; unit_price: number; line_total: number }
interface SalesReturn {
  id: string; sales_id: string; customer_name: string; status: string; created_at: string; inspected_by: string | null;
}
interface SalesReturnItem { item_id: string; item_name?: string; quantity_returned: number; quantity_accepted: number | null; quantity_rejected: number | null; rejection_reason: string | null }
interface MarketerBalance { item_id: string; item_name: string; on_hand: number; unit_price: number }
interface MarketerStatement { date: string; expectedAmount: number; returnedGoods: number; cashReceived: number; creditGiven: number; outstandingBalance: number }
interface MarketerReturn {
  id: string; marketer_id: string; marketer_name: string; status: string;
  created_by: string | null; created_at: string; verified_by: string | null; verified_at: string | null;
}
interface MarketerReturnItem { item_id: string; item_name: string; quantity: number; unit_price: number; verified_quantity: number | null }
interface PendingVerification { item_id: string; item_name: string; pending_quantity: number }
interface StockAssignment {
  id: string; marketer_id: string; issued_by: string | null; status: 'ASSIGNED' | 'VERIFIED';
  verified_by: string | null; verified_at: string | null; issued_at: string;
}
interface ReturnableItem { id: string; name: string; uom: string }
interface CustodyBalance { expected: number; returned: number; outstanding: number; explainedMissing: number; unexplainedMissing: number }
interface MarketerWiseRow {
  marketer_id: string; marketer_name: string; item_id: string; item_name: string;
  expected: number; returned: number; outstanding: number; explained_missing: number; unexplained_missing: number;
}
interface CustomerWiseRow { customer_name: string; item_id: string; item_name: string; quantity: number; last_event_at: string }
interface MovementRow { period: string; returned: number; sold_with_bottle: number }

const COPY: Record<'INVOICE' | 'POS', { title: string; subtitle: string; newLabel: string; empty: string }> = {
  INVOICE: { title: 'Sales', subtitle: 'Customer orders invoiced for delivery — Marketers on credit, Distributors cash/advance/credit-with-approval.', newLabel: 'New sales order', empty: 'No sales orders yet' },
  POS: { title: 'Retail', subtitle: 'Walk-in and depot till transactions — cash, every sale tied to a customer, posts to stock and the ledger immediately.', newLabel: 'New retail sale', empty: 'No till transactions yet' },
};

export default function SalesPage({ channel }: { channel: 'INVOICE' | 'POS' }) {
  const ui = useUi();
  const copy = COPY[channel];
  const { user, isSuperAdmin, hasAccess } = useCurrentUser();
  const canApprove = isSuperAdmin || hasAccess('sales-approve');
  const [orders, setOrders] = useState<SalesOrder[]>([]);
  const [returns, setReturns] = useState<SalesReturn[]>([]);
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [items, setItems] = useState<Item[]>([]);
  const [reloadKey, setReloadKey] = useState(0);
  const [mastersReloadKey, setMastersReloadKey] = useState(0);
  const [query, setQuery] = useState('');
  const [receiptFor, setReceiptFor] = useState<string | null>(null);
  const [invoiceFor, setInvoiceFor] = useState<string | null>(null);
  const [exchangeFor, setExchangeFor] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [newCustomerOpen, setNewCustomerOpen] = useState(false);
  const [newReturnOpen, setNewReturnOpen] = useState(false);
  const [inspectReturnFor, setInspectReturnFor] = useState<SalesReturn | null>(null);
  const [marketerPendingCount, setMarketerPendingCount] = useState(0);

  const refresh = useCallback(() => { setReloadKey(k => k + 1); refreshPendingCounts(); }, []);
  const globalPendingCounts = usePendingCounts();
  useEffect(() => {
    if (channel !== 'INVOICE') return;
    api<MarketerReturn[]>('/marketer-stock/returns').then(rows => setMarketerPendingCount(rows.filter(r => r.status === 'PENDING_VERIFICATION').length));
  }, [channel, reloadKey, globalPendingCounts.sales]);
  const refreshMasters = useCallback(() => setMastersReloadKey(k => k + 1), []);
  const pendingDeletions = usePendingDeletions('sales', reloadKey);
  const reversedOrders = useReversedEntities('sales', reloadKey);

  useEffect(() => {
    api<SalesOrder[]>('/sales', { channel }).then(setOrders);
    if (channel === 'INVOICE') api<SalesReturn[]>('/sales-returns').then(setReturns);
  }, [channel, reloadKey]);
  useEffect(() => {
    api<Customer[]>('/masters/customers').then(setCustomers);
    api<Item[]>('/masters/items').then(rows => setItems(rows.filter(i => i.type === 'FINISHED_GOOD')));
  }, [mastersReloadKey]);

  const eligibleCustomers = useMemo(
    () => channel === 'INVOICE' ? customers.filter(c => c.customer_type !== 'RETAIL') : customers,
    [customers, channel],
  );

  // Both the ERP-generated id and the manual (paper invoice book) number are
  // searchable — Module 12. Client-side, since every order is already loaded.
  const filteredOrders = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return orders;
    return orders.filter(o => o.id.toLowerCase().includes(q) || (o.manual_invoice_number ?? '').toLowerCase().includes(q));
  }, [orders, query]);

  async function approveCredit(id: string) {
    await apiPost(`/sales/${encodeURIComponent(id)}/approve-credit`, { userId: user?.id });
    ui.toast(`${id} credit approved`);
    refresh();
  }
  async function rejectCredit(id: string) {
    await apiPost(`/sales/${encodeURIComponent(id)}/reject-credit`, { userId: user?.id });
    ui.toast(`${id} credit rejected`);
    refresh();
  }

  const kpis = useMemo(() => [
    { key: 'orders', label: `Total ${channel === 'POS' ? 'transactions' : 'orders'}`, icon: channel === 'POS' ? 'wallet' as const : 'cart' as const, value: number(orders.length) },
    { key: 'revenue', label: 'Revenue', icon: 'chart' as const, value: naira(orders.reduce((s, o) => s + o.total_amount, 0)) },
    { key: 'pending', label: channel === 'POS' ? 'Paid' : 'Pending', icon: 'clock' as const, value: number(orders.filter(o => o.status === (channel === 'POS' ? 'PAID' : 'PENDING')).length) },
    { key: 'approval', label: 'Awaiting approval', icon: 'clock' as const, value: number(orders.filter(o => o.status === 'AWAITING_APPROVAL').length) },
  ], [orders, channel]);

  const ordersTable = (
    <>
      <div className="filters no-print">
        <div className="searchfield">
          <input id="sales-search" type="search" value={query} onChange={e => setQuery(e.target.value)} placeholder="Search ERP # or manual invoice #" aria-label="Search orders" />
          <kbd>/</kbd>
        </div>
      </div>
      <Card
        title={copy.title} description={`${filteredOrders.length} of ${orders.length} record(s).`}
        action={<button className="btn btn-secondary btn-sm no-print" onClick={() => setNewCustomerOpen(true)}><Icon name="plus" size={14} /> New customer</button>}
      >
        <div className="table-wrap">
          <table>
            <thead><tr><th>Order</th><th>Manual #</th><th>Customer</th><th className="num">Amount</th><th>Terms</th><th>Rep</th><th>Date</th><th>Status</th><th className="no-print">Action</th><th className="no-print" /></tr></thead>
            <tbody>
              {filteredOrders.map(o => (
                <tr key={o.id}>
                  <td className="mono" style={{ fontSize: 12, color: 'rgb(var(--aqua-700))' }}>{o.id}</td>
                  <td className="sub">{o.manual_invoice_number ?? '—'}</td>
                  <td><p style={{ fontWeight: 500 }}>{o.customer_name}</p><p className="sub">{o.customer_location}</p></td>
                  <td className="num tnum">{naira(o.total_amount)}</td>
                  <td className="sub">{o.payment_terms}</td>
                  <td>{o.rep}</td>
                  <td className="sub">{o.created_at}</td>
                  <td><Pill status={o.status} /></td>
                  <td className="no-print">
                    {o.status === 'AWAITING_APPROVAL' && canApprove && (
                      <div style={{ display: 'flex', gap: 6 }}>
                        <button className="btn btn-secondary btn-sm" onClick={() => approveCredit(o.id)}>Approve</button>
                        <button className="btn btn-secondary btn-sm" onClick={() => rejectCredit(o.id)}>Reject</button>
                      </div>
                    )}
                    {channel === 'POS' && o.status === 'PAID' && (
                      <div style={{ display: 'flex', gap: 6 }}>
                        <button className="btn btn-secondary btn-sm" onClick={() => setReceiptFor(o.id)}>Receipt</button>
                        <button className="btn btn-secondary btn-sm" onClick={() => setInvoiceFor(o.id)}>Invoice</button>
                        <button className="btn btn-secondary btn-sm" onClick={() => setExchangeFor(o.id)}>Return/Exchange</button>
                      </div>
                    )}
                    {channel === 'INVOICE' && o.status === 'PENDING' && (
                      <DispatchButton
                        salesId={o.id} customerName={o.customer_name} customerLocation={o.customer_location}
                        onDispatched={() => { refresh(); ui.toast(`${o.id} dispatched`); }}
                      />
                    )}
                  </td>
                  <td className="no-print">
                    {o.status === 'AWAITING_APPROVAL' ? (
                      <DeleteButton entityType="sales" entityId={o.id} entityLabel={o.id} pending={pendingDeletions.has(o.id)} onRequested={() => { refresh(); ui.toast('Deletion requested — pending admin approval'); }} />
                    ) : (
                      <ReverseButton entityType="sales" entityId={o.id} entityLabel={o.id} reversed={reversedOrders.has(o.id)} onReversed={() => { refresh(); ui.toast('Sales order reversed'); }} />
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {filteredOrders.length === 0 && <EmptyState title={copy.empty} description="Create one to see it flow through inventory and finance." onClear={() => setQuery('')} />}
      </Card>
    </>
  );

  return (
    <>
      <PrintHeader />
      <div className="pagehead">
        <div><h1>{copy.title}</h1><p className="pagesub">{copy.subtitle}</p></div>
        <div className="no-print"><button className="btn btn-primary" onClick={() => setCreateOpen(true)}><Icon name="plus" size={14} /> {copy.newLabel}</button></div>
      </div>

      <KpiRow kpis={kpis} />

      {channel === 'INVOICE' ? (
        <Tabs tabs={[
          { key: 'orders', label: 'Orders', badge: orders.filter(o => o.status === 'AWAITING_APPROVAL').length, content: ordersTable },
          {
            key: 'returns', label: 'Returns', badge: returns.filter(r => r.status === 'PENDING_INSPECTION').length, content: (
              <Card
                title="Returned goods" description="Unsold stock a Marketer has brought back — only the accepted quantity re-enters inventory."
                action={<button className="btn btn-primary btn-sm no-print" onClick={() => setNewReturnOpen(true)}><Icon name="plus" size={14} /> New return</button>}
              >
                <div className="table-wrap">
                  <table>
                    <thead><tr><th>Return</th><th>Order</th><th>Customer</th><th>Status</th><th>Raised</th><th className="no-print">Action</th></tr></thead>
                    <tbody>
                      {returns.map(r => (
                        <tr key={r.id}>
                          <td className="mono" style={{ fontSize: 12, color: 'rgb(var(--aqua-700))' }}>{r.id}</td>
                          <td className="mono" style={{ fontSize: 12 }}>{r.sales_id}</td>
                          <td>{r.customer_name}</td>
                          <td><Pill status={r.status} /></td>
                          <td className="sub">{r.created_at}</td>
                          <td className="no-print">
                            {r.status === 'PENDING_INSPECTION' && <button className="btn btn-secondary btn-sm" onClick={() => setInspectReturnFor(r)}>Inspect</button>}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                {returns.length === 0 && <EmptyState title="No returns yet" description="Raised when a Marketer brings unsold stock back against a delivered order." onClear={() => {}} />}
              </Card>
            ),
          },
          { key: 'marketer-stock', label: 'Marketer stock', badge: marketerPendingCount, content: <MarketerStockTab customers={customers} items={items} /> },
          { key: 'marketer-reconciliation', label: 'Reconciliation', content: <MarketerReconciliationTab reloadKey={reloadKey} /> },
          { key: 'credit-sales', label: 'Credit sales', content: <CreditSalesTab reloadKey={reloadKey} /> },
          { key: 'marketer-performance', label: 'Performance & commission', content: <MarketerPerformanceTab reloadKey={reloadKey} /> },
          { key: 'bottle-tracking', label: 'Bottle tracking', content: <BottleTrackingTab customers={customers} /> },
          { key: 'customers', label: 'Customers', content: <CustomersTab customers={customers} /> },
          { key: 'distributor-branches', label: 'Distributor branches', content: <DistributorBranchesTab customers={customers} /> },
        ]} />
      ) : (
        <Tabs tabs={[
          { key: 'orders', label: 'Orders', badge: orders.filter(o => o.status === 'AWAITING_APPROVAL').length, content: ordersTable },
          { key: 'retail-stock', label: 'Retail stock', content: <RetailIntakeTab items={items} /> },
          { key: 'returns-exchanges', label: 'Returns & exchanges', content: <RetailExchangesTab reloadKey={reloadKey} /> },
          { key: 'customers', label: 'Customers', badge: globalPendingCounts.pos, content: <RetailCustomersTab reloadKey={reloadKey} /> },
          { key: 'reconciliation', label: 'Daily reconciliation', content: <RetailReconciliationTab /> },
        ]} />
      )}

      {createOpen && (
        <NewOrder
          channel={channel} customers={eligibleCustomers} items={items}
          onClose={() => setCreateOpen(false)}
          onCreated={() => { setCreateOpen(false); refresh(); ui.toast(`${copy.newLabel} created`); }}
        />
      )}
      {newCustomerOpen && (
        <NewCustomer
          defaultType={channel === 'POS' ? 'RETAIL' : 'MARKETER'}
          onClose={() => setNewCustomerOpen(false)}
          onCreated={() => { setNewCustomerOpen(false); refreshMasters(); ui.toast('Customer added'); }}
        />
      )}
      {newReturnOpen && (
        <NewReturn
          orders={orders.filter(o => ['DELIVERED', 'PAID'].includes(o.status) && o.customer_type === 'MARKETER')}
          onClose={() => setNewReturnOpen(false)}
          onCreated={() => { setNewReturnOpen(false); refresh(); ui.toast('Return raised, pending inspection'); }}
        />
      )}
      {inspectReturnFor && (
        <InspectReturn
          ret={inspectReturnFor}
          onClose={() => setInspectReturnFor(null)}
          onInspected={() => { setInspectReturnFor(null); refresh(); ui.toast(`${inspectReturnFor.id} inspected`); }}
        />
      )}
      {receiptFor && <PosReceiptModal salesId={receiptFor} onClose={() => setReceiptFor(null)} />}
      {invoiceFor && (
        <PosInvoiceModal
          salesId={invoiceFor}
          customerName={orders.find(o => o.id === invoiceFor)?.customer_name ?? 'Walk-in customer'}
          customerLocation={orders.find(o => o.id === invoiceFor)?.customer_location ?? null}
          onClose={() => setInvoiceFor(null)}
        />
      )}
      {exchangeFor && (
        <RetailExchangeModal
          salesId={exchangeFor}
          customerName={orders.find(o => o.id === exchangeFor)?.customer_name ?? 'Walk-in customer'}
          onClose={() => setExchangeFor(null)}
          onCompleted={() => { setExchangeFor(null); refresh(); ui.toast('Return/exchange recorded'); }}
        />
      )}
    </>
  );
}

function NewOrder({ channel, customers, items, onClose, onCreated }: {
  channel: 'INVOICE' | 'POS'; customers: Customer[]; items: Item[]; onClose: () => void; onCreated: () => void;
}) {
  const [customerId, setCustomerId] = useState(customers[0]?.id ?? '');
  const [paymentTerms, setPaymentTerms] = useState<PaymentTerms>('CREDIT');
  const [rep, setRep] = useState('');
  const [lines, setLines] = useState<LineItemValue[]>([{ itemId: items[0]?.id ?? '', quantity: '10', unitPrice: String(items[0]?.unit_cost ?? 0) }]);
  const [branches, setBranches] = useState<{ id: string; name: string }[]>([]);
  const [branchId, setBranchId] = useState('');
  const [manualInvoiceNumber, setManualInvoiceNumber] = useState('');
  const [payLines, setPayLines] = useState<{ method: PosMethod; amount: string }[]>([{ method: 'Cash', amount: '' }]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const selectedCustomer = customers.find(c => c.id === customerId);
  const isDistributor = channel === 'INVOICE' && selectedCustomer?.customer_type === 'DISTRIBUTOR';
  const orderTotal = lines.reduce((s, l) => s + (Number(l.quantity) || 0) * (Number(l.unitPrice) || 0), 0);
  const payTotal = payLines.reduce((s, l) => s + (Number(l.amount) || 0), 0);

  useEffect(() => {
    if (!isDistributor || !customerId) { setBranches([]); setBranchId(''); return; }
    api<{ id: string; name: string }[]>('/distributor-branches', { companyId: customerId }).then(rows => { setBranches(rows); setBranchId(''); });
  }, [isDistributor, customerId]);

  function updatePayLine(i: number, patch: Partial<{ method: PosMethod; amount: string }>) {
    setPayLines(ls => ls.map((l, idx) => idx === i ? { ...l, ...patch } : l));
  }
  function addPayLine() {
    const used = new Set(payLines.map(l => l.method));
    setPayLines(ls => [...ls, { method: POS_METHODS.find(m => !used.has(m)) ?? 'Cash', amount: '' }]);
  }
  function removePayLine(i: number) {
    setPayLines(ls => ls.filter((_, idx) => idx !== i));
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (channel === 'POS' && !customerId) {
      setError('Select or add a customer — every retail sale needs one');
      return;
    }
    if (channel === 'POS' && payLines.length > 1 && Math.abs(payTotal - orderTotal) > 0.01) {
      setError(`Payment lines total ${naira(payTotal)} — must equal the order total ${naira(orderTotal)}`);
      return;
    }
    setSaving(true); setError(null);
    try {
      await apiPost('/sales', {
        customerId: customerId || undefined, channel, rep,
        paymentTerms: channel === 'INVOICE' ? (isDistributor ? paymentTerms : 'CREDIT') : undefined,
        items: lines.map(l => ({ itemId: l.itemId, quantity: Number(l.quantity), unitPrice: Number(l.unitPrice) })),
        branchId: isDistributor ? (branchId || undefined) : undefined,
        manualInvoiceNumber: channel === 'INVOICE' ? (manualInvoiceNumber || undefined) : undefined,
        payments: channel === 'POS'
          ? (payLines.length === 1 ? [{ method: payLines[0].method, amount: orderTotal }] : payLines.map(l => ({ method: l.method, amount: Number(l.amount) || 0 })))
          : undefined,
      });
      onCreated();
    } catch (err) { setError(err instanceof Error ? err.message : 'Something went wrong'); }
    finally { setSaving(false); }
  }

  return (
    <Modal title={channel === 'POS' ? 'New retail sale' : 'New sales order'} onClose={onClose} onSubmit={submit} submitLabel="Create" saving={saving} error={error} wide>
      <div className="form-grid">
        <div className="form-row">
          <label htmlFor="so-customer">Customer</label>
          <select id="so-customer" value={customerId} onChange={e => setCustomerId(e.target.value)} required={channel === 'POS'}>
            {customers.length === 0 && <option value="" disabled>No customers yet — add one first</option>}
            {customers.map(c => <option key={c.id} value={c.id}>{c.name} ({c.customer_type.toLowerCase()})</option>)}
          </select>
        </div>
        <div className="form-row"><label htmlFor="so-rep">{channel === 'POS' ? 'Cashier' : 'Sales rep'}</label><input id="so-rep" value={rep} onChange={e => setRep(e.target.value)} required autoFocus /></div>
        {isDistributor && (
          <div className="form-row">
            <label htmlFor="so-terms">Payment terms</label>
            <select id="so-terms" value={paymentTerms} onChange={e => setPaymentTerms(e.target.value as PaymentTerms)}>
              <option value="CASH">Cash</option>
              <option value="ADVANCE">Paid in advance</option>
              <option value="CREDIT">Credit (requires approval)</option>
            </select>
          </div>
        )}
        {isDistributor && branches.length > 0 && (
          <div className="form-row">
            <label htmlFor="so-branch">Branch</label>
            <select id="so-branch" value={branchId} onChange={e => setBranchId(e.target.value)}>
              <option value="">No specific branch</option>
              {branches.map(b => <option key={b.id} value={b.id}>{b.name}</option>)}
            </select>
          </div>
        )}
        {channel === 'INVOICE' && (
          <div className="form-row">
            <label htmlFor="so-manual-invoice">Manual invoice number</label>
            <input id="so-manual-invoice" value={manualInvoiceNumber} onChange={e => setManualInvoiceNumber(e.target.value)} placeholder="Paper invoice book reference" />
          </div>
        )}
      </div>
      <LineItemsInput items={lines} options={items} onChange={setLines} />
      {channel === 'POS' && (
        <div className="form-row" style={{ marginTop: 10 }}>
          <label>Payment method{payLines.length > 1 ? 's' : ''}</label>
          {payLines.map((l, i) => (
            <div className="lineitem-row" key={i}>
              <div style={{ flex: 2 }}>
                <select aria-label="Payment method" value={l.method} onChange={e => updatePayLine(i, { method: e.target.value as PosMethod })}>
                  {POS_METHODS.map(m => <option key={m} value={m}>{m}</option>)}
                </select>
              </div>
              {payLines.length > 1 && (
                <div style={{ width: 120 }}>
                  <NumberInput ariaLabel={`Amount for ${l.method}`} value={l.amount} onChange={v => updatePayLine(i, { amount: v })} required />
                </div>
              )}
              {payLines.length > 1 && (
                <button type="button" className="iconbtn" onClick={() => removePayLine(i)} aria-label="Remove payment line"><Icon name="x" size={16} /></button>
              )}
            </div>
          ))}
          {payLines.length < POS_METHODS.length && (
            <button type="button" className="btn btn-secondary btn-sm" onClick={addPayLine} style={{ marginTop: 4 }}><Icon name="plus" size={12} /> Split payment</button>
          )}
          {payLines.length > 1 ? (
            <p className="sub" style={{ marginTop: 4 }}>
              {naira(payTotal)} of {naira(orderTotal)} allocated{Math.abs(payTotal - orderTotal) > 0.01 ? ' — must equal the order total' : ''}
            </p>
          ) : (
            <p className="sub" style={{ marginTop: 4 }}>Collected in full via the method above ({naira(orderTotal)}).</p>
          )}
        </div>
      )}
      {channel === 'POS' && <p className="sub">Posts immediately — stock and the ledger update as soon as this sale is created.</p>}
      {isDistributor && paymentTerms === 'CREDIT' && <p className="sub">This will be created as Awaiting approval — nothing posts to inventory until it's approved.</p>}
    </Modal>
  );
}

function NewCustomer({ defaultType, onClose, onCreated }: { defaultType?: CustomerType; onClose: () => void; onCreated: () => void }) {
  const [name, setName] = useState('');
  const [location, setLocation] = useState('');
  const [phone, setPhone] = useState('');
  const [customerType, setCustomerType] = useState<CustomerType>(defaultType ?? 'MARKETER');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setSaving(true); setError(null);
    try { await apiPost('/masters/customers', { name, location: location || undefined, phone: phone || undefined, customerType }); onCreated(); }
    catch (err) { setError(err instanceof Error ? err.message : 'Something went wrong'); }
    finally { setSaving(false); }
  }

  return (
    <Modal title="New customer" onClose={onClose} onSubmit={submit} submitLabel="Add customer" saving={saving} error={error}>
      <div className="form-row"><label htmlFor="cust-name">Name</label><input id="cust-name" value={name} onChange={e => setName(e.target.value)} required autoFocus /></div>
      <div className="form-grid">
        <div className="form-row"><label htmlFor="cust-location">Location (optional)</label><input id="cust-location" value={location} onChange={e => setLocation(e.target.value)} /></div>
        <div className="form-row"><label htmlFor="cust-phone">Phone (optional)</label><input id="cust-phone" value={phone} onChange={e => setPhone(e.target.value)} /></div>
        <div className="form-row">
          <label htmlFor="cust-type">Category</label>
          <select id="cust-type" value={customerType} onChange={e => setCustomerType(e.target.value as CustomerType)}>
            <option value="MARKETER">Marketer — carries stock to market, may sell on credit, may return unsold goods</option>
            <option value="DISTRIBUTOR">Major distributor — cash, advance, or credit with approval</option>
            <option value="RETAIL">Retail — a real customer profile, required for every retail sale</option>
          </select>
        </div>
      </div>
    </Modal>
  );
}

function NewReturn({ orders, onClose, onCreated }: { orders: SalesOrder[]; onClose: () => void; onCreated: () => void }) {
  const [salesId, setSalesId] = useState(orders[0]?.id ?? '');
  const [lines, setLines] = useState<{ itemId: string; name: string; sold: number; quantityReturned: string }[] | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!salesId) { setLines(null); return; }
    Promise.all([
      api<{ items: SalesItem[] }>(`/sales/${encodeURIComponent(salesId)}`),
      api<Item[]>('/masters/items'),
    ]).then(([full, items]) => {
      setLines(full.items.map(it => ({ itemId: it.item_id, name: items.find(i => i.id === it.item_id)?.name ?? it.item_id, sold: it.quantity, quantityReturned: '0' })));
    });
  }, [salesId]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!lines) return;
    setSaving(true); setError(null);
    try {
      await apiPost('/sales-returns', {
        salesId,
        items: lines.filter(l => Number(l.quantityReturned) > 0).map(l => ({ itemId: l.itemId, quantityReturned: Number(l.quantityReturned) })),
      });
      onCreated();
    } catch (err) { setError(err instanceof Error ? err.message : 'Something went wrong'); }
    finally { setSaving(false); }
  }

  return (
    <Modal title="New return" onClose={onClose} onSubmit={submit} submitLabel="Raise return" saving={saving} error={error} wide>
      <div className="form-row">
        <label htmlFor="ret-order">Delivered order (Marketer only)</label>
        <select id="ret-order" value={salesId} onChange={e => setSalesId(e.target.value)}>
          {orders.map(o => <option key={o.id} value={o.id}>{o.id} — {o.customer_name}</option>)}
        </select>
      </div>
      {orders.length === 0 && <p className="sub">No delivered Marketer orders available to return against.</p>}
      <div className="form-row">
        <label>Quantity returned</label>
        {lines === null && salesId && <p className="sub">Loading order lines…</p>}
        {lines?.map((l, i) => (
          <div className="lineitem-row" key={l.itemId}>
            <div style={{ flex: 2 }}><p style={{ fontSize: 13 }}>{l.name}</p><p className="sub" style={{ fontSize: 12 }}>Sold {l.sold.toLocaleString('en-NG')}</p></div>
            <div style={{ width: 100 }}>
              <NumberInput ariaLabel={`Quantity returned for ${l.name}`} allowDecimal={false} value={l.quantityReturned}
                onChange={v => setLines(ls => ls!.map((x, idx) => idx === i ? { ...x, quantityReturned: v } : x))} />
            </div>
          </div>
        ))}
      </div>
    </Modal>
  );
}

function InspectReturn({ ret, onClose, onInspected }: { ret: SalesReturn; onClose: () => void; onInspected: () => void }) {
  const [inspectorOfficer, setInspectorOfficer] = useState('');
  const [lines, setLines] = useState<{ itemId: string; name: string; returned: number; accepted: string; rejected: string; reason: string }[] | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    Promise.all([
      api<{ items: SalesReturnItem[] }>(`/sales-returns/${encodeURIComponent(ret.id)}`),
      api<Item[]>('/masters/items'),
    ]).then(([full, items]) => {
      setLines(full.items.map(it => ({
        itemId: it.item_id, name: items.find(i => i.id === it.item_id)?.name ?? it.item_id,
        returned: it.quantity_returned, accepted: String(it.quantity_returned), rejected: '0', reason: '',
      })));
    });
  }, [ret.id]);

  function setAccepted(i: number, accepted: string, returned: number) {
    const rejected = Math.max(returned - (Number(accepted) || 0), 0);
    setLines(ls => ls!.map((x, idx) => idx === i ? { ...x, accepted, rejected: String(rejected) } : x));
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!lines) return;
    setSaving(true); setError(null);
    try {
      await apiPost(`/sales-returns/${encodeURIComponent(ret.id)}/inspect`, {
        inspectorOfficer,
        lines: lines.map(l => ({
          itemId: l.itemId, acceptedQuantity: Number(l.accepted), rejectedQuantity: Number(l.rejected),
          rejectionReason: Number(l.rejected) > 0 ? (l.reason || undefined) : undefined,
        })),
      });
      onInspected();
    } catch (err) { setError(err instanceof Error ? err.message : 'Something went wrong'); }
    finally { setSaving(false); }
  }

  return (
    <Modal title={`Inspect ${ret.id}`} onClose={onClose} onSubmit={submit} submitLabel="Record inspection" saving={saving} error={error} wide>
      <div className="form-row">
        <label htmlFor="ret-insp">Inspection officer</label>
        <input id="ret-insp" value={inspectorOfficer} onChange={e => setInspectorOfficer(e.target.value)} required autoFocus />
      </div>
      <div className="form-row">
        <label>Returned / accepted / rejected</label>
        {lines === null && <p className="sub">Loading return lines…</p>}
        {lines?.map((l, i) => (
          <div key={l.itemId} style={{ padding: '10px 0', borderBottom: '1px solid rgb(var(--border))' }}>
            <div className="lineitem-row">
              <div style={{ flex: 2 }}>
                <p style={{ fontSize: 13 }}>{l.name}</p>
                <p className="sub" style={{ fontSize: 12 }}>Returned {l.returned.toLocaleString('en-NG')}</p>
              </div>
              <div style={{ width: 100 }}>
                <NumberInput ariaLabel={`Accepted for ${l.name}`} allowDecimal={false} value={l.accepted} onChange={v => setAccepted(i, v, l.returned)} required />
              </div>
              <div style={{ width: 100 }}>
                <NumberInput ariaLabel={`Rejected for ${l.name}`} allowDecimal={false} value={l.rejected}
                  onChange={v => setLines(ls => ls!.map((x, idx) => idx === i ? { ...x, rejected: v } : x))} required />
              </div>
            </div>
            {Number(l.rejected) > 0 && (
              <div className="form-row" style={{ marginTop: 6 }}>
                <input aria-label={`Rejection reason for ${l.name}`} placeholder="Reason for rejection"
                  value={l.reason} onChange={e => setLines(ls => ls!.map((x, idx) => idx === i ? { ...x, reason: e.target.value } : x))} required />
              </div>
            )}
          </div>
        ))}
      </div>
      <p className="sub">Only the accepted quantity returns to inventory; accepted value posts a credit note against the customer's account.</p>
    </Modal>
  );
}

function MarketerStockTab({ customers, items }: { customers: Customer[]; items: Item[] }) {
  const ui = useUi();
  const { user } = useCurrentUser();
  const marketers = useMemo(() => customers.filter(c => c.customer_type === 'MARKETER'), [customers]);
  const [marketerId, setMarketerId] = useState('');
  const [balances, setBalances] = useState<MarketerBalance[]>([]);
  const [statement, setStatement] = useState<MarketerStatement | null>(null);
  const [pending, setPending] = useState<PendingVerification[]>([]);
  const [assignments, setAssignments] = useState<StockAssignment[]>([]);
  const [returns, setReturns] = useState<MarketerReturn[]>([]);
  const [reloadKey, setReloadKey] = useState(0);
  const [issueOpen, setIssueOpen] = useState(false);
  const [returnOpen, setReturnOpen] = useState(false);
  const [saleOpen, setSaleOpen] = useState(false);
  const [verifyTarget, setVerifyTarget] = useState<MarketerReturn | null>(null);
  const refresh = useCallback(() => { setReloadKey(k => k + 1); refreshPendingCounts(); }, []);

  useEffect(() => {
    if (!marketerId && marketers[0]) setMarketerId(marketers[0].id);
  }, [marketers, marketerId]);

  useEffect(() => {
    if (!marketerId) { setBalances([]); setStatement(null); setPending([]); setAssignments([]); return; }
    api<MarketerBalance[]>(`/marketer-stock/${encodeURIComponent(marketerId)}/balances`).then(setBalances);
    api<MarketerStatement>(`/marketer-stock/${encodeURIComponent(marketerId)}/statement`).then(setStatement);
    api<PendingVerification[]>(`/marketer-stock/${encodeURIComponent(marketerId)}/pending-verification`).then(setPending);
    api<StockAssignment[]>(`/marketer-stock/${encodeURIComponent(marketerId)}/assignments`).then(setAssignments);
  }, [marketerId, reloadKey]);

  useEffect(() => {
    api<MarketerReturn[]>('/marketer-stock/returns').then(setReturns);
  }, [reloadKey]);

  const marketer = marketers.find(m => m.id === marketerId) ?? null;
  const unverifiedAssignments = assignments.filter(a => a.status === 'ASSIGNED');

  async function confirmReceipt(assignmentId: string) {
    try {
      await apiPost(`/marketer-stock/assignments/${encodeURIComponent(assignmentId)}/verify`, { verifiedBy: user?.name ?? marketer?.name ?? 'Marketer' });
      refresh();
      ui.toast(`${assignmentId} confirmed received`);
    } catch (err) { ui.toast(err instanceof Error ? err.message : 'Something went wrong'); }
  }

  return (
    <>
      {marketer && unverifiedAssignments.length > 0 && (
        <Card
          title={`Assigned to ${marketer.name} — awaiting confirmation`}
          description="Posted by the warehouse and already physically out — but not yet this marketer's held stock until they confirm what arrived."
        >
          <div className="table-wrap">
            <table>
              <thead><tr><th>Reference</th><th>Posted by</th><th>Date</th><th className="no-print">Action</th></tr></thead>
              <tbody>
                {unverifiedAssignments.map(a => (
                  <tr key={a.id}>
                    <td className="mono" style={{ fontSize: 12, color: 'rgb(var(--aqua-700))' }}>{a.id}</td>
                    <td>{a.issued_by ?? '—'}</td>
                    <td className="sub">{a.issued_at}</td>
                    <td className="no-print"><button className="btn btn-primary btn-sm" onClick={() => confirmReceipt(a.id)}>Confirm receipt</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      <Card title="Pending warehouse verification" description="A marketer's claimed return doesn't count as warehouse stock until it's been physically verified — sometimes goods never arrive.">
        <div className="table-wrap">
          <table>
            <thead><tr><th>Return</th><th>Marketer</th><th>Status</th><th>Raised</th><th>Verified by</th><th className="no-print">Action</th></tr></thead>
            <tbody>
              {returns.map(r => (
                <tr key={r.id}>
                  <td className="mono" style={{ fontSize: 12, color: 'rgb(var(--aqua-700))' }}>{r.id}</td>
                  <td>{r.marketer_name}</td>
                  <td><Pill status={r.status} /></td>
                  <td className="sub">{r.created_at}</td>
                  <td className="sub">{r.verified_by ?? '—'}</td>
                  <td className="no-print">
                    {r.status === 'PENDING_VERIFICATION' && <button className="btn btn-secondary btn-sm" onClick={() => setVerifyTarget(r)}>Verify</button>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {returns.length === 0 && <EmptyState title="No returns yet" description="Raised when a marketer reports unsold stock coming back." onClear={() => {}} />}
      </Card>

      <Card
        title="Marketer stock" description="Each marketer's mobile inventory — goods issued out of the warehouse on consignment, not yet a sale until reported."
        action={
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }} className="no-print">
            <select aria-label="Marketer" value={marketerId} onChange={e => setMarketerId(e.target.value)} style={{ minWidth: 160 }}>
              {marketers.map(m => <option key={m.id} value={m.id}>{m.name}</option>)}
            </select>
            <button className="btn btn-secondary btn-sm" onClick={() => setIssueOpen(true)}><Icon name="plus" size={14} /> Issue stock</button>
            <button className="btn btn-secondary btn-sm" onClick={() => setReturnOpen(true)} disabled={!marketerId}>Record return</button>
            <button className="btn btn-secondary btn-sm" onClick={() => setSaleOpen(true)} disabled={!marketerId}>Record sale</button>
            <button className="btn btn-primary btn-sm" onClick={() => window.print()} disabled={!marketerId}><Icon name="print" size={14} /> Print statement</button>
          </div>
        }
      >
        {marketers.length === 0 && <EmptyState title="No marketers yet" description="Add a customer of type Marketer to track their mobile inventory." onClear={() => {}} />}

        {marketer && statement && (
          <>
            <p className="sub" style={{ padding: '4px 20px 0' }}>{marketer.name}{marketer.location ? ` — ${marketer.location}` : ''} · Daily statement for {statement.date}</p>
            {pending.length > 0 && (
              <p className="sub" style={{ padding: '4px 20px 0', fontWeight: 600, color: 'rgb(var(--ink))' }}>
                ⚠ {pending.map(p => `${number(p.pending_quantity)} ${p.item_name}`).join(', ')} still pending warehouse verification — this limits how much fresh stock can be issued.
              </p>
            )}
            <div style={{ display: 'flex', gap: 24, flexWrap: 'wrap', padding: '10px 20px 16px' }}>
              <p className="sub">Expected amount <strong style={{ color: 'rgb(var(--ink))' }}>{naira(statement.expectedAmount)}</strong></p>
              <p className="sub">Returned goods <strong style={{ color: 'rgb(var(--ink))' }}>{naira(statement.returnedGoods)}</strong></p>
              <p className="sub">Cash received <strong style={{ color: 'rgb(var(--ink))' }}>{naira(statement.cashReceived)}</strong></p>
              <p className="sub">Credit given <strong style={{ color: 'rgb(var(--ink))' }}>{naira(statement.creditGiven)}</strong></p>
              <p className="sub">Outstanding balance <strong style={{ color: 'rgb(var(--ink))' }}>{naira(statement.outstandingBalance)}</strong></p>
            </div>

            <div className="table-wrap">
              <table>
                <thead><tr><th>Item</th><th className="num">On hand</th><th className="num">Unit price</th><th className="num">Value</th></tr></thead>
                <tbody>
                  {balances.map(b => (
                    <tr key={b.item_id}>
                      <td>{b.item_name}</td>
                      <td className="num tnum">{number(b.on_hand)}</td>
                      <td className="num tnum">{naira(b.unit_price)}</td>
                      <td className="num tnum">{naira(b.on_hand * b.unit_price)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {balances.length === 0 && <EmptyState title="No stock out" description="This marketer isn't currently holding any warehouse stock." onClear={() => {}} />}
          </>
        )}

        {issueOpen && (
          <IssueMarketerStock
            marketers={marketers} items={items} defaultMarketerId={marketerId} pending={pending}
            onClose={() => setIssueOpen(false)}
            onIssued={() => { setIssueOpen(false); refresh(); ui.toast('Stock assigned — awaiting the marketer\'s confirmation'); }}
          />
        )}
        {returnOpen && marketer && (
          <RecordMarketerReturn
            marketerId={marketer.id} balances={balances}
            onClose={() => setReturnOpen(false)}
            onRecorded={() => { setReturnOpen(false); refresh(); ui.toast('Return reported, pending warehouse verification'); }}
          />
        )}
        {saleOpen && marketer && (
          <RecordMarketerSale
            marketerId={marketer.id} balances={balances}
            onClose={() => setSaleOpen(false)}
            onRecorded={() => { setSaleOpen(false); refresh(); ui.toast('Sale recorded'); }}
          />
        )}
      </Card>

      {verifyTarget && (
        <VerifyMarketerReturn
          ret={verifyTarget} items={items}
          onClose={() => setVerifyTarget(null)}
          onVerified={() => { setVerifyTarget(null); refresh(); ui.toast(`${verifyTarget.id} verified`); }}
        />
      )}
    </>
  );
}

function IssueMarketerStock({ marketers, items, defaultMarketerId, pending, onClose, onIssued }: {
  marketers: Customer[]; items: Item[]; defaultMarketerId: string; pending: PendingVerification[]; onClose: () => void; onIssued: () => void;
}) {
  const { user } = useCurrentUser();
  const isWarehouseManager = user?.role === 'Warehouse Manager';
  const [marketerId, setMarketerId] = useState(defaultMarketerId || marketers[0]?.id || '');
  const [issuedBy, setIssuedBy] = useState('');
  const [lines, setLines] = useState<LineItemValue[]>([{ itemId: items[0]?.id ?? '', quantity: '50', unitPrice: String(items[0]?.unit_cost ?? 0) }]);
  const [override, setOverride] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const pendingByItem = useMemo(() => new Map(pending.map(p => [p.item_id, p])), [pending]);
  const blockers = lines
    .map(l => {
      const p = pendingByItem.get(l.itemId);
      if (!p || p.pending_quantity <= 0) return null;
      const requested = Number(l.quantity) || 0;
      return { itemName: p.item_name, pendingQuantity: p.pending_quantity, max: Math.max(0, requested - p.pending_quantity) };
    })
    .filter((b): b is { itemName: string; pendingQuantity: number; max: number } => b !== null);
  const canOverride = override && isWarehouseManager;

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (blockers.length > 0 && !canOverride) {
      setError(blockers.map(b => `${b.itemName}: ${number(b.pendingQuantity)} still pending warehouse verification — maximum issuable today is ${number(b.max)}.`).join(' '));
      return;
    }
    setSaving(true); setError(null);
    try {
      await apiPost('/marketer-stock/issue', {
        marketerId, issuedBy,
        items: lines.map(l => ({ itemId: l.itemId, quantity: Number(l.quantity), unitPrice: Number(l.unitPrice) })),
        overrideUserId: canOverride ? user!.id : undefined,
      });
      onIssued();
    } catch (err) { setError(err instanceof Error ? err.message : 'Something went wrong'); }
    finally { setSaving(false); }
  }

  return (
    <Modal title="Assign stock to marketer" onClose={onClose} onSubmit={submit} submitLabel="Assign" saving={saving} error={error} wide>
      <div className="form-grid">
        <div className="form-row">
          <label htmlFor="mkt-issue-marketer">Marketer</label>
          <select id="mkt-issue-marketer" value={marketerId} onChange={e => setMarketerId(e.target.value)}>
            {marketers.map(m => <option key={m.id} value={m.id}>{m.name}</option>)}
          </select>
        </div>
        <div className="form-row"><label htmlFor="mkt-issue-by">Issued by</label><input id="mkt-issue-by" value={issuedBy} onChange={e => setIssuedBy(e.target.value)} required autoFocus /></div>
      </div>
      <LineItemsInput items={lines} options={items} onChange={setLines} />
      {blockers.length > 0 && (
        <div style={{ marginTop: 10, padding: '10px 12px', border: '1px solid rgb(var(--border))', borderRadius: 8 }}>
          {blockers.map(b => (
            <p key={b.itemName} className="sub" style={{ fontWeight: 600 }}>⚠ {b.itemName}: {number(b.pendingQuantity)} still pending warehouse verification. Maximum issuable today: {number(b.max)}.</p>
          ))}
          {isWarehouseManager ? (
            <label style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 8 }}>
              <input type="checkbox" checked={override} onChange={e => setOverride(e.target.checked)} />
              <span className="sub">Override as Warehouse Manager ({user!.name}) — issue the full quantity anyway.</span>
            </label>
          ) : (
            <p className="sub" style={{ marginTop: 6 }}>Only a Warehouse Manager can override this block.</p>
          )}
        </div>
      )}
      <p className="sub">Moves stock from the warehouse into this marketer's mobile inventory — not a sale, nothing is invoiced yet.</p>
    </Modal>
  );
}

function RecordMarketerReturn({ marketerId, balances, onClose, onRecorded }: {
  marketerId: string; balances: MarketerBalance[]; onClose: () => void; onRecorded: () => void;
}) {
  const [lines, setLines] = useState(balances.map(b => ({ itemId: b.item_id, name: b.item_name, onHand: b.on_hand, quantity: '0' })));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setSaving(true); setError(null);
    try {
      await apiPost('/marketer-stock/returns', {
        marketerId,
        items: lines.filter(l => Number(l.quantity) > 0).map(l => ({ itemId: l.itemId, quantity: Number(l.quantity) })),
      });
      onRecorded();
    } catch (err) { setError(err instanceof Error ? err.message : 'Something went wrong'); }
    finally { setSaving(false); }
  }

  return (
    <Modal title="Record return from marketer" onClose={onClose} onSubmit={submit} submitLabel="Record return" saving={saving} error={error} wide>
      {lines.length === 0 && <p className="sub">This marketer isn't currently holding any stock.</p>}
      {lines.map((l, i) => (
        <div className="lineitem-row" key={l.itemId}>
          <div style={{ flex: 2 }}><p style={{ fontSize: 13 }}>{l.name}</p><p className="sub" style={{ fontSize: 12 }}>Holding {l.onHand.toLocaleString('en-NG')}</p></div>
          <div style={{ width: 100 }}>
            <NumberInput ariaLabel={`Quantity returned for ${l.name}`} allowDecimal={false} value={l.quantity}
              onChange={v => setLines(ls => ls.map((x, idx) => idx === i ? { ...x, quantity: v } : x))} />
          </div>
        </div>
      ))}
      <p className="sub">Decreases this marketer's mobile inventory right away, but the warehouse won't increase until it's physically verified — this goes into the pending warehouse verification queue.</p>
    </Modal>
  );
}

function RecordMarketerSale({ marketerId, balances, onClose, onRecorded }: {
  marketerId: string; balances: MarketerBalance[]; onClose: () => void; onRecorded: () => void;
}) {
  const [lines, setLines] = useState(balances.map(b => ({ itemId: b.item_id, name: b.item_name, onHand: b.on_hand, unitPrice: b.unit_price, quantity: '0' })));
  const [cashReceived, setCashReceived] = useState('0');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const totalValue = lines.reduce((s, l) => s + (Number(l.quantity) || 0) * l.unitPrice, 0);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setSaving(true); setError(null);
    try {
      await apiPost('/marketer-stock/sales', {
        marketerId, cashReceived: Number(cashReceived) || 0,
        items: lines.filter(l => Number(l.quantity) > 0).map(l => ({ itemId: l.itemId, quantity: Number(l.quantity) })),
      });
      onRecorded();
    } catch (err) { setError(err instanceof Error ? err.message : 'Something went wrong'); }
    finally { setSaving(false); }
  }

  return (
    <Modal title="Record sale by marketer" onClose={onClose} onSubmit={submit} submitLabel="Record sale" saving={saving} error={error} wide>
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
        <label htmlFor="mkt-sale-cash">Cash received (of {naira(totalValue)} sold)</label>
        <NumberInput id="mkt-sale-cash" ariaLabel="Cash received" value={cashReceived} onChange={setCashReceived} />
      </div>
      <p className="sub">Whatever isn't covered by cash becomes Credit given, added to this marketer's outstanding balance.</p>
    </Modal>
  );
}

function VerifyMarketerReturn({ ret, items, onClose, onVerified }: {
  ret: MarketerReturn; items: Item[]; onClose: () => void; onVerified: () => void;
}) {
  const [verifiedBy, setVerifiedBy] = useState('');
  const [lines, setLines] = useState<{ itemId: string; name: string; claimed: number; verified: string }[] | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api<{ items: MarketerReturnItem[] }>(`/marketer-stock/returns/${encodeURIComponent(ret.id)}`).then(full => {
      setLines(full.items.map(it => ({
        itemId: it.item_id, name: items.find(i => i.id === it.item_id)?.name ?? it.item_id,
        claimed: it.quantity, verified: String(it.quantity),
      })));
    });
  }, [ret.id, items]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!lines) return;
    setSaving(true); setError(null);
    try {
      await apiPost(`/marketer-stock/returns/${encodeURIComponent(ret.id)}/verify`, {
        verifiedBy,
        lines: lines.map(l => ({ itemId: l.itemId, verifiedQuantity: Number(l.verified) })),
      });
      onVerified();
    } catch (err) { setError(err instanceof Error ? err.message : 'Something went wrong'); }
    finally { setSaving(false); }
  }

  return (
    <Modal title={`Verify ${ret.id} — ${ret.marketer_name}`} onClose={onClose} onSubmit={submit} submitLabel="Record verification" saving={saving} error={error} wide>
      <div className="form-row">
        <label htmlFor="mkt-verify-by">Verified by</label>
        <input id="mkt-verify-by" value={verifiedBy} onChange={e => setVerifiedBy(e.target.value)} required autoFocus />
      </div>
      <div className="form-row">
        <label>Claimed / physically verified</label>
        {lines === null && <p className="sub">Loading return lines…</p>}
        {lines?.map((l, i) => (
          <div className="lineitem-row" key={l.itemId}>
            <div style={{ flex: 2 }}><p style={{ fontSize: 13 }}>{l.name}</p><p className="sub" style={{ fontSize: 12 }}>Claimed {l.claimed.toLocaleString('en-NG')}</p></div>
            <div style={{ width: 100 }}>
              <NumberInput ariaLabel={`Verified quantity for ${l.name}`} allowDecimal={false} value={l.verified}
                onChange={v => setLines(ls => ls!.map((x, idx) => idx === i ? { ...x, verified: v } : x))} required />
            </div>
          </div>
        ))}
      </div>
      <p className="sub">Only the verified quantity posts to warehouse inventory; a shortfall stays on record but isn't auto-adjusted.</p>
    </Modal>
  );
}

function BottleTrackingTab({ customers }: { customers: Customer[] }) {
  const ui = useUi();
  const marketers = useMemo(() => customers.filter(c => c.customer_type === 'MARKETER'), [customers]);
  const [returnableItems, setReturnableItems] = useState<ReturnableItem[]>([]);
  const [marketerId, setMarketerId] = useState('');
  const [itemId, setItemId] = useState('');
  const [balance, setBalance] = useState<CustodyBalance | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [recordOpen, setRecordOpen] = useState(false);
  const [reportView, setReportView] = useState<'marketer' | 'customer' | 'movement'>('marketer');
  const [marketerWise, setMarketerWise] = useState<MarketerWiseRow[]>([]);
  const [customerWise, setCustomerWise] = useState<CustomerWiseRow[]>([]);
  const [movement, setMovement] = useState<MovementRow[]>([]);
  const [bucket, setBucket] = useState<'day' | 'week' | 'month'>('day');
  const refresh = useCallback(() => { setReloadKey(k => k + 1); refreshPendingCounts(); }, []);

  useEffect(() => { api<ReturnableItem[]>('/dispenser-bottles/items').then(setReturnableItems); }, [reloadKey]);
  useEffect(() => { if (!marketerId && marketers[0]) setMarketerId(marketers[0].id); }, [marketers, marketerId]);
  useEffect(() => { if (!itemId && returnableItems[0]) setItemId(returnableItems[0].id); }, [returnableItems, itemId]);

  useEffect(() => {
    if (!marketerId || !itemId) { setBalance(null); return; }
    api<CustodyBalance>(`/dispenser-bottles/${encodeURIComponent(marketerId)}/${encodeURIComponent(itemId)}/balance`).then(setBalance);
  }, [marketerId, itemId, reloadKey]);

  useEffect(() => { api<MarketerWiseRow[]>('/dispenser-bottles/marketer-wise').then(setMarketerWise); }, [reloadKey]);
  useEffect(() => { api<CustomerWiseRow[]>('/dispenser-bottles/customer-wise').then(setCustomerWise); }, [reloadKey]);
  useEffect(() => { api<MovementRow[]>('/dispenser-bottles/movement', { bucket }).then(setMovement); }, [bucket, reloadKey]);

  const marketer = marketers.find(m => m.id === marketerId) ?? null;
  const item = returnableItems.find(i => i.id === itemId) ?? null;

  return (
    <>
      <Card
        title="Dispenser bottle custody" description="Dispenser bottles are company assets, tracked separately from ordinary stock — every filled bottle issued to a marketer is expected back empty."
        action={
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }} className="no-print">
            <select aria-label="Marketer" value={marketerId} onChange={e => setMarketerId(e.target.value)} style={{ minWidth: 160 }}>
              {marketers.map(m => <option key={m.id} value={m.id}>{m.name}</option>)}
            </select>
            {returnableItems.length > 1 && (
              <select aria-label="Item" value={itemId} onChange={e => setItemId(e.target.value)} style={{ minWidth: 140 }}>
                {returnableItems.map(i => <option key={i.id} value={i.id}>{i.name}</option>)}
              </select>
            )}
            <button className="btn btn-primary btn-sm" onClick={() => setRecordOpen(true)} disabled={!marketerId || !itemId}><Icon name="plus" size={14} /> Record empty return</button>
          </div>
        }
      >
        {marketers.length === 0 && <EmptyState title="No marketers yet" description="Add a customer of type Marketer to track dispenser-bottle custody." onClear={() => {}} />}
        {returnableItems.length === 0 && marketers.length > 0 && <EmptyState title="No returnable-asset items" description="No item is currently flagged as a returnable asset." onClear={() => {}} />}

        {marketer && item && balance && (
          <>
            <p className="sub" style={{ padding: '4px 20px 0' }}>{marketer.name} — {item.name}</p>
            <div style={{ display: 'flex', gap: 24, flexWrap: 'wrap', padding: '10px 20px 16px' }}>
              <p className="sub">Expected <strong style={{ color: 'rgb(var(--ink))' }}>{number(balance.expected)}</strong></p>
              <p className="sub">Returned <strong style={{ color: 'rgb(var(--ink))' }}>{number(balance.returned)}</strong></p>
              <p className="sub">Outstanding <strong style={{ color: 'rgb(var(--ink))' }}>{number(balance.outstanding)}</strong></p>
              <p className="sub">Missing — Sold With Bottle <strong style={{ color: 'rgb(var(--ink))' }}>{number(balance.explainedMissing)}</strong></p>
              <p className="sub">Unexplained <strong style={{ color: 'rgb(var(--ink))' }}>{number(balance.unexplainedMissing)}</strong></p>
            </div>
          </>
        )}
      </Card>

      <Card
        title="Reports" description="Marketer-wise and customer-wise standings, plus movement over time."
        action={
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }} className="no-print">
            <button className={`btn btn-sm ${reportView === 'marketer' ? 'btn-primary' : 'btn-secondary'}`} onClick={() => setReportView('marketer')}>Marketer wise</button>
            <button className={`btn btn-sm ${reportView === 'customer' ? 'btn-primary' : 'btn-secondary'}`} onClick={() => setReportView('customer')}>Customer wise</button>
            <button className={`btn btn-sm ${reportView === 'movement' ? 'btn-primary' : 'btn-secondary'}`} onClick={() => setReportView('movement')}>Movement</button>
            <button className="btn btn-secondary btn-sm" onClick={() => window.print()}><Icon name="print" size={14} /> Print</button>
          </div>
        }
      >
        {reportView === 'marketer' && (
          <div className="table-wrap">
            <table>
              <thead><tr><th>Marketer</th><th>Item</th><th className="num">Expected</th><th className="num">Returned</th><th className="num">Outstanding</th><th className="num">Sold with bottle</th><th className="num">Unexplained</th></tr></thead>
              <tbody>
                {marketerWise.map(r => (
                  <tr key={`${r.marketer_id}-${r.item_id}`}>
                    <td>{r.marketer_name}</td>
                    <td>{r.item_name}</td>
                    <td className="num tnum">{number(r.expected)}</td>
                    <td className="num tnum">{number(r.returned)}</td>
                    <td className="num tnum">{number(r.outstanding)}</td>
                    <td className="num tnum">{number(r.explained_missing)}</td>
                    <td className="num tnum">{number(r.unexplained_missing)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {reportView === 'marketer' && marketerWise.length === 0 && <EmptyState title="No activity yet" description="Nothing issued against a returnable-asset item yet." onClear={() => {}} />}

        {reportView === 'customer' && (
          <div className="table-wrap">
            <table>
              <thead><tr><th>Customer</th><th>Item</th><th className="num">Holding (sold with bottle)</th><th>Last activity</th></tr></thead>
              <tbody>
                {customerWise.map(r => (
                  <tr key={`${r.customer_name}-${r.item_id}`}>
                    <td>{r.customer_name}</td>
                    <td>{r.item_name}</td>
                    <td className="num tnum">{number(r.quantity)}</td>
                    <td className="sub">{r.last_event_at}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {reportView === 'customer' && customerWise.length === 0 && <EmptyState title="No sold-with-bottle activity yet" description="Recorded when a marketer reports a customer who bought a bottle with no empty to trade." onClear={() => {}} />}

        {reportView === 'movement' && (
          <>
            <div className="no-print" style={{ display: 'flex', gap: 8, padding: '0 20px 12px' }}>
              <button className={`btn btn-sm ${bucket === 'day' ? 'btn-primary' : 'btn-secondary'}`} onClick={() => setBucket('day')}>Daily</button>
              <button className={`btn btn-sm ${bucket === 'week' ? 'btn-primary' : 'btn-secondary'}`} onClick={() => setBucket('week')}>Weekly</button>
              <button className={`btn btn-sm ${bucket === 'month' ? 'btn-primary' : 'btn-secondary'}`} onClick={() => setBucket('month')}>Monthly</button>
            </div>
            <div className="table-wrap">
              <table>
                <thead><tr><th>Period</th><th className="num">Returned</th><th className="num">Sold with bottle</th></tr></thead>
                <tbody>
                  {movement.map(r => (
                    <tr key={r.period}>
                      <td className="sub">{r.period}</td>
                      <td className="num tnum">{number(r.returned)}</td>
                      <td className="num tnum">{number(r.sold_with_bottle)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {movement.length === 0 && <EmptyState title="No movement yet" description="Appears once a marketer records empties returned or sold-with-bottle." onClear={() => {}} />}
          </>
        )}
      </Card>

      {recordOpen && marketer && item && balance && (
        <RecordEmptyReturn
          marketerId={marketer.id} itemId={item.id} itemName={item.name} outstanding={balance.outstanding}
          onClose={() => setRecordOpen(false)}
          onRecorded={() => { setRecordOpen(false); refresh(); ui.toast('Bottle custody reconciled'); }}
        />
      )}
    </>
  );
}

function RecordEmptyReturn({ marketerId, itemId, itemName, outstanding, onClose, onRecorded }: {
  marketerId: string; itemId: string; itemName: string; outstanding: number; onClose: () => void; onRecorded: () => void;
}) {
  const [returnedBy, setReturnedBy] = useState('');
  const [quantityReturned, setQuantityReturned] = useState('0');
  const [soldWithBottle, setSoldWithBottle] = useState<{ customerName: string; quantity: string }[]>([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const explainedTotal = (Number(quantityReturned) || 0) + soldWithBottle.reduce((s, l) => s + (Number(l.quantity) || 0), 0);
  const overExplained = explainedTotal > outstanding;

  function addLine() { setSoldWithBottle(ls => [...ls, { customerName: '', quantity: '1' }]); }
  function removeLine(i: number) { setSoldWithBottle(ls => ls.filter((_, idx) => idx !== i)); }
  function updateLine(i: number, patch: Partial<{ customerName: string; quantity: string }>) {
    setSoldWithBottle(ls => ls.map((l, idx) => idx === i ? { ...l, ...patch } : l));
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (overExplained) { setError(`Cannot account for ${explainedTotal} — only ${outstanding} is currently outstanding.`); return; }
    setSaving(true); setError(null);
    try {
      await apiPost('/dispenser-bottles/returns', {
        marketerId, itemId, quantityReturned: Number(quantityReturned) || 0, returnedBy,
        soldWithBottle: soldWithBottle.filter(l => l.customerName.trim() && Number(l.quantity) > 0).map(l => ({ customerName: l.customerName.trim(), quantity: Number(l.quantity) })),
      });
      onRecorded();
    } catch (err) { setError(err instanceof Error ? err.message : 'Something went wrong'); }
    finally { setSaving(false); }
  }

  return (
    <Modal title={`Record empty return — ${itemName}`} onClose={onClose} onSubmit={submit} submitLabel="Record" saving={saving} error={error} wide>
      <p className="sub" style={{ marginBottom: 10 }}>Currently {outstanding.toLocaleString('en-NG')} outstanding for this marketer.</p>
      <div className="form-grid">
        <div className="form-row"><label htmlFor="bottle-returned-by">Returned by</label><input id="bottle-returned-by" value={returnedBy} onChange={e => setReturnedBy(e.target.value)} required autoFocus /></div>
        <div className="form-row">
          <label htmlFor="bottle-qty-returned">Empties physically returned</label>
          <NumberInput id="bottle-qty-returned" allowDecimal={false} value={quantityReturned} onChange={setQuantityReturned} />
        </div>
      </div>
      <div className="form-row">
        <label>Sold with bottle (no empty traded in)</label>
        {soldWithBottle.map((l, i) => (
          <div className="lineitem-row" key={i}>
            <div style={{ flex: 2 }}>
              <input aria-label="Customer name" placeholder="Customer name" value={l.customerName} onChange={e => updateLine(i, { customerName: e.target.value })} />
            </div>
            <div style={{ width: 100 }}>
              <NumberInput ariaLabel="Quantity" allowDecimal={false} value={l.quantity} onChange={v => updateLine(i, { quantity: v })} />
            </div>
            <button type="button" className="iconbtn" onClick={() => removeLine(i)} aria-label="Remove line"><Icon name="x" size={16} /></button>
          </div>
        ))}
        <button type="button" className="btn btn-secondary btn-sm" onClick={addLine} style={{ marginTop: 4 }}><Icon name="plus" size={12} /> Add customer</button>
      </div>
      {overExplained && <p className="sub" style={{ fontWeight: 600 }}>⚠ {explainedTotal} accounted for, but only {outstanding} is outstanding.</p>}
      <p className="sub">Whatever isn't returned or explained here stays outstanding — nothing here is ever reset, only reduced by a future return.</p>
    </Modal>
  );
}
