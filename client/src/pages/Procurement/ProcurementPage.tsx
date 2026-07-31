import { useCallback, useEffect, useMemo, useState } from 'react';
import { api, apiPost, apiPut } from '../../lib/apiClient';
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
import { NumberInput } from '../../components/ui/NumberInput';
import { usePendingDeletions } from '../../lib/pendingDeletions';

interface PurchaseOrder {
  id: string; supplier_id: string; supplier_name: string; requested_by: string | null;
  status: string; item_count: number; total_amount: number; created_at: string;
}
interface GoodsReceived {
  id: string; po_id: string; supplier_name: string; received_by: string | null; status: string; received_at: string;
}
interface Supplier { id: string; name: string }
interface Item { id: string; name: string; type: string; unit_cost: number }

export default function ProcurementPage() {
  const ui = useUi();
  const [orders, setOrders] = useState<PurchaseOrder[]>([]);
  const [receipts, setReceipts] = useState<GoodsReceived[]>([]);
  const [suppliers, setSuppliers] = useState<Supplier[]>([]);
  const [items, setItems] = useState<Item[]>([]);
  const [reloadKey, setReloadKey] = useState(0);

  const [createOpen, setCreateOpen] = useState(false);
  const [receiveFor, setReceiveFor] = useState<PurchaseOrder | null>(null);

  const refresh = useCallback(() => setReloadKey(k => k + 1), []);
  const poPending = usePendingDeletions('purchase_orders', reloadKey);
  const grnPending = usePendingDeletions('goods_received', reloadKey);

  useEffect(() => {
    api<PurchaseOrder[]>('/purchase-orders').then(setOrders);
    api<GoodsReceived[]>('/goods-received').then(setReceipts);
  }, [reloadKey]);

  useEffect(() => {
    api<Supplier[]>('/masters/suppliers').then(setSuppliers);
    api<Item[]>('/masters/items').then(rows => setItems(rows.filter(i => i.type !== 'FINISHED_GOOD')));
  }, []);

  const kpis = useMemo(() => [
    { key: 'total', label: 'Total purchase orders', icon: 'receipt' as const, value: number(orders.length) },
    { key: 'value', label: 'Order value', icon: 'chart' as const, value: naira(orders.reduce((s, o) => s + o.total_amount, 0)) },
    { key: 'awaiting', label: 'Awaiting approval', icon: 'clock' as const, value: number(orders.filter(o => o.status === 'AWAITING_APPROVAL').length) },
    { key: 'pending-receipt', label: 'Approved, not received', icon: 'box' as const, value: number(orders.filter(o => o.status === 'APPROVED').length) },
  ], [orders]);

  async function approve(id: string, status: string) {
    await apiPut(`/purchase-orders/${encodeURIComponent(id)}/status`, { status });
    ui.toast(`${id} → ${status.replace(/_/g, ' ')}`);
    refresh();
  }

  return (
    <>
      <PrintHeader />
      <div className="pagehead">
        <div><h1>Procurement</h1><p className="pagesub">Purchase orders to suppliers, and what's been received against them.</p></div>
        <div className="no-print">
          <button className="btn btn-primary" onClick={() => setCreateOpen(true)}><Icon name="plus" size={14} /> New purchase order</button>
        </div>
      </div>

      <KpiRow kpis={kpis} />

      <Tabs tabs={[
        {
          key: 'orders', label: 'Purchase orders', content: (
            <Card title="Purchase orders" description="Every order raised against a supplier.">
              <div className="table-wrap">
                <table>
                  <thead><tr><th>PO</th><th>Supplier</th><th className="num">Items</th><th className="num">Amount</th><th>Requested by</th><th>Created</th><th>Status</th><th className="no-print">Action</th><th className="no-print" /></tr></thead>
                  <tbody>
                    {orders.map(o => (
                      <tr key={o.id}>
                        <td><span className="mono" style={{ fontSize: 12, color: 'rgb(var(--aqua-700))' }}>{o.id}</span></td>
                        <td>{o.supplier_name}</td>
                        <td className="num tnum">{o.item_count}</td>
                        <td className="num tnum">{naira(o.total_amount)}</td>
                        <td>{o.requested_by}</td>
                        <td className="sub">{o.created_at}</td>
                        <td><Pill status={o.status} /></td>
                        <td className="no-print">
                          {o.status === 'AWAITING_APPROVAL' && (
                            <div style={{ display: 'flex', gap: 6 }}>
                              <button className="btn btn-secondary btn-sm" onClick={() => approve(o.id, 'APPROVED')}>Approve</button>
                              <button className="btn btn-secondary btn-sm" onClick={() => approve(o.id, 'REJECTED')}>Reject</button>
                            </div>
                          )}
                          {o.status === 'APPROVED' && (
                            <button className="btn btn-secondary btn-sm" onClick={() => setReceiveFor(o)}>Receive</button>
                          )}
                        </td>
                        <td className="no-print">
                          <DeleteButton entityType="purchase_orders" entityId={o.id} entityLabel={o.id} pending={poPending.has(o.id)} onRequested={() => { refresh(); ui.toast('Deletion requested — pending admin approval'); }} />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {orders.length === 0 && <EmptyState title="No purchase orders yet" description="Create one to get the chain started." onClear={() => {}} />}
            </Card>
          ),
        },
        {
          key: 'receipts', label: 'Goods received', content: (
            <Card title="Goods received" description="Deliveries logged against a purchase order, awaiting or past Quality Control.">
              <div className="table-wrap">
                <table>
                  <thead><tr><th>GRN</th><th>Purchase order</th><th>Supplier</th><th>Received by</th><th>Received</th><th>Status</th><th className="no-print" /></tr></thead>
                  <tbody>
                    {receipts.map(r => (
                      <tr key={r.id}>
                        <td><span className="mono" style={{ fontSize: 12, color: 'rgb(var(--aqua-700))' }}>{r.id}</span></td>
                        <td className="mono" style={{ fontSize: 12 }}>{r.po_id}</td>
                        <td>{r.supplier_name}</td>
                        <td>{r.received_by}</td>
                        <td className="sub">{r.received_at}</td>
                        <td><Pill status={r.status} /></td>
                        <td className="no-print">
                          <DeleteButton entityType="goods_received" entityId={r.id} entityLabel={r.id} pending={grnPending.has(r.id)} onRequested={() => { refresh(); ui.toast('Deletion requested — pending admin approval'); }} />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {receipts.length === 0 && <EmptyState title="Nothing received yet" description="Approve a purchase order, then receive it." onClear={() => {}} />}
              <p className="sub" style={{ padding: '10px 20px' }}>Pending Quality Control? Head to the Quality control page to record a verdict.</p>
            </Card>
          ),
        },
      ]} />

      {createOpen && (
        <CreatePurchaseOrder
          suppliers={suppliers} items={items}
          onClose={() => setCreateOpen(false)}
          onCreated={() => { setCreateOpen(false); refresh(); ui.toast('Purchase order created'); }}
        />
      )}
      {receiveFor && (
        <ReceiveGoods
          order={receiveFor}
          onClose={() => setReceiveFor(null)}
          onReceived={() => { setReceiveFor(null); refresh(); ui.toast(`Goods receipt logged for ${receiveFor.id}`); }}
        />
      )}
    </>
  );
}

function CreatePurchaseOrder({ suppliers, items, onClose, onCreated }: {
  suppliers: Supplier[]; items: Item[]; onClose: () => void; onCreated: () => void;
}) {
  const [supplierId, setSupplierId] = useState(suppliers[0]?.id ?? '');
  const [requestedBy, setRequestedBy] = useState('');
  const [lines, setLines] = useState<LineItemValue[]>([{ itemId: items[0]?.id ?? '', quantity: '100', unitPrice: String(items[0]?.unit_cost ?? 0) }]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true); setError(null);
    try {
      await apiPost('/purchase-orders', {
        supplierId, requestedBy,
        items: lines.map(l => ({ itemId: l.itemId, quantity: Number(l.quantity), unitPrice: Number(l.unitPrice) })),
      });
      onCreated();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong');
    } finally { setSaving(false); }
  }

  return (
    <Modal title="New purchase order" onClose={onClose} onSubmit={submit} submitLabel="Create" saving={saving} error={error} wide>
      <div className="form-grid">
        <div className="form-row">
          <label htmlFor="po-supplier">Supplier</label>
          <select id="po-supplier" value={supplierId} onChange={e => setSupplierId(e.target.value)}>
            {suppliers.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
        </div>
        <div className="form-row">
          <label htmlFor="po-requestedby">Requested by</label>
          <input id="po-requestedby" value={requestedBy} onChange={e => setRequestedBy(e.target.value)} required autoFocus />
        </div>
      </div>
      <LineItemsInput items={lines} options={items} onChange={setLines} />
    </Modal>
  );
}

function ReceiveGoods({ order, onClose, onReceived }: { order: PurchaseOrder; onClose: () => void; onReceived: () => void }) {
  const [receivedBy, setReceivedBy] = useState('');
  const [lines, setLines] = useState<{ itemId: string; name: string; quantity: string }[] | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api<{ items: { item_id: string; quantity: number }[] }>(`/purchase-orders/${encodeURIComponent(order.id)}`).then(async full => {
      const items = await api<Item[]>('/masters/items');
      setLines(full.items.map(it => ({ itemId: it.item_id, name: items.find(i => i.id === it.item_id)?.name ?? it.item_id, quantity: String(it.quantity) })));
    });
  }, [order.id]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!lines) return;
    setSaving(true); setError(null);
    try {
      await apiPost('/goods-received', {
        poId: order.id, receivedBy,
        items: lines.map(l => ({ itemId: l.itemId, quantity: Number(l.quantity) })),
      });
      onReceived();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong');
    } finally { setSaving(false); }
  }

  return (
    <Modal title={`Receive goods for ${order.id}`} onClose={onClose} onSubmit={submit} submitLabel="Log receipt" saving={saving} error={error}>
      <div className="form-row">
        <label htmlFor="grn-receivedby">Received by</label>
        <input id="grn-receivedby" value={receivedBy} onChange={e => setReceivedBy(e.target.value)} required autoFocus />
      </div>
      <div className="form-row">
        <label>Quantities received</label>
        {lines === null && <p className="sub">Loading order lines…</p>}
        {lines?.map((l, i) => (
          <div className="lineitem-row" key={l.itemId}>
            <div style={{ flex: 2 }}><p style={{ fontSize: 13 }}>{l.name}</p></div>
            <div style={{ width: 100 }}>
              <NumberInput ariaLabel={`Quantity for ${l.name}`} allowDecimal={false} value={l.quantity}
                onChange={v => setLines(ls => ls!.map((x, idx) => idx === i ? { ...x, quantity: v } : x))} required />
            </div>
          </div>
        ))}
      </div>
      <p className="sub">This goes to Quality Control pending — inventory only updates once it's approved there.</p>
    </Modal>
  );
}
