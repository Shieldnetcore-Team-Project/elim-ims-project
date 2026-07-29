import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import { api, apiPost } from '../../lib/apiClient';
import { naira, number } from '../../lib/format';
import { useUi } from '../../lib/uiState';
import { Card } from '../../components/ui/Card';
import { KpiRow } from '../../components/ui/KpiCard';
import { Pill } from '../../components/ui/Pill';
import { Modal } from '../../components/ui/Modal';
import { LineItemsInput, type LineItemValue } from '../../components/ui/LineItemsInput';
import { EmptyState } from '../../components/ui/EmptyState';
import { Icon } from '../../components/ui/Icon';
import { PrintHeader } from '../../components/ui/PrintHeader';
import { DeleteButton } from '../../components/ui/DeleteButton';
import { usePendingDeletions } from '../../lib/pendingDeletions';

interface SalesOrder {
  id: string; customer_id: string; customer_name: string; customer_location: string;
  channel: 'INVOICE' | 'POS'; rep: string; status: string; total_amount: number; created_at: string;
}
interface Customer { id: string; name: string; location: string | null }
interface Item { id: string; name: string; type: string; unit_cost: number }

const COPY: Record<'INVOICE' | 'POS', { title: string; subtitle: string; newLabel: string; empty: string }> = {
  INVOICE: { title: 'Sales', subtitle: 'Customer orders invoiced for delivery.', newLabel: 'New sales order', empty: 'No sales orders yet' },
  POS: { title: 'Point of sale', subtitle: 'Walk-in and depot till transactions — paid immediately.', newLabel: 'New POS sale', empty: 'No till transactions yet' },
};

export default function SalesPage({ channel }: { channel: 'INVOICE' | 'POS' }) {
  const ui = useUi();
  const copy = COPY[channel];
  const [orders, setOrders] = useState<SalesOrder[]>([]);
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [items, setItems] = useState<Item[]>([]);
  const [reloadKey, setReloadKey] = useState(0);
  const [createOpen, setCreateOpen] = useState(false);

  const refresh = useCallback(() => setReloadKey(k => k + 1), []);
  const pendingDeletions = usePendingDeletions('sales', reloadKey);

  useEffect(() => { api<SalesOrder[]>('/sales', { channel }).then(setOrders); }, [channel, reloadKey]);
  useEffect(() => {
    api<Customer[]>('/masters/customers').then(setCustomers);
    api<Item[]>('/masters/items').then(rows => setItems(rows.filter(i => i.type === 'FINISHED_GOOD')));
  }, []);

  const kpis = useMemo(() => [
    { key: 'orders', label: `Total ${channel === 'POS' ? 'transactions' : 'orders'}`, icon: channel === 'POS' ? 'wallet' as const : 'cart' as const, value: number(orders.length) },
    { key: 'revenue', label: 'Revenue', icon: 'chart' as const, value: naira(orders.reduce((s, o) => s + o.total_amount, 0)) },
    { key: 'pending', label: channel === 'POS' ? 'Paid' : 'Pending', icon: 'clock' as const, value: number(orders.filter(o => o.status === (channel === 'POS' ? 'PAID' : 'PENDING')).length) },
  ], [orders, channel]);

  return (
    <>
      <PrintHeader />
      <div className="pagehead">
        <div><h1>{copy.title}</h1><p className="pagesub">{copy.subtitle}</p></div>
        <div className="no-print"><button className="btn btn-primary" onClick={() => setCreateOpen(true)}><Icon name="plus" size={14} /> {copy.newLabel}</button></div>
      </div>

      <KpiRow kpis={kpis} />

      <Card title={copy.title} description={`${orders.length} record(s).`}>
        <div style={{ overflowX: 'auto' }}>
          <table>
            <thead><tr><th>Order</th><th>Customer</th><th className="num">Amount</th><th>Rep</th><th>Status</th><th className="no-print" /></tr></thead>
            <tbody>
              {orders.map(o => (
                <tr key={o.id}>
                  <td className="mono" style={{ fontSize: 12, color: 'rgb(var(--aqua-700))' }}>{o.id}</td>
                  <td><p style={{ fontWeight: 500 }}>{o.customer_name}</p><p className="sub">{o.customer_location}</p></td>
                  <td className="num tnum">{naira(o.total_amount)}</td>
                  <td>{o.rep}</td>
                  <td><Pill status={o.status} /></td>
                  <td className="no-print">
                    <DeleteButton entityType="sales" entityId={o.id} entityLabel={o.id} pending={pendingDeletions.has(o.id)} onRequested={() => { refresh(); ui.toast('Deletion requested — pending admin approval'); }} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {orders.length === 0 && <EmptyState title={copy.empty} description="Create one to see it flow through inventory and finance." onClear={() => {}} />}
      </Card>

      {createOpen && (
        <NewOrder
          channel={channel} customers={customers} items={items}
          onClose={() => setCreateOpen(false)}
          onCreated={() => { setCreateOpen(false); refresh(); ui.toast(`${copy.newLabel} created`); }}
        />
      )}
    </>
  );
}

function NewOrder({ channel, customers, items, onClose, onCreated }: {
  channel: 'INVOICE' | 'POS'; customers: Customer[]; items: Item[]; onClose: () => void; onCreated: () => void;
}) {
  const [customerId, setCustomerId] = useState(customers[0]?.id ?? '');
  const [rep, setRep] = useState('');
  const [lines, setLines] = useState<LineItemValue[]>([{ itemId: items[0]?.id ?? '', quantity: '10', unitPrice: String(items[0]?.unit_cost ?? 0) }]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setSaving(true); setError(null);
    try {
      await apiPost('/sales', {
        customerId, channel, rep,
        items: lines.map(l => ({ itemId: l.itemId, quantity: Number(l.quantity), unitPrice: Number(l.unitPrice) })),
      });
      onCreated();
    } catch (err) { setError(err instanceof Error ? err.message : 'Something went wrong'); }
    finally { setSaving(false); }
  }

  return (
    <Modal title={channel === 'POS' ? 'New POS sale' : 'New sales order'} onClose={onClose} onSubmit={submit} submitLabel="Create" saving={saving} error={error} wide>
      <div className="form-grid">
        <div className="form-row">
          <label htmlFor="so-customer">Customer</label>
          <select id="so-customer" value={customerId} onChange={e => setCustomerId(e.target.value)}>
            {customers.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </div>
        <div className="form-row"><label htmlFor="so-rep">{channel === 'POS' ? 'Cashier' : 'Sales rep'}</label><input id="so-rep" value={rep} onChange={e => setRep(e.target.value)} required autoFocus /></div>
      </div>
      <LineItemsInput items={lines} options={items} onChange={setLines} />
      {channel === 'POS' && <p className="sub">POS sales are marked paid immediately and a receipt is posted automatically.</p>}
    </Modal>
  );
}
