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
import { ReverseButton } from '../../components/ui/ReverseButton';
import { NumberInput } from '../../components/ui/NumberInput';
import { usePendingDeletions } from '../../lib/pendingDeletions';
import { useReversedEntities } from '../../lib/reversedEntities';
import { refreshPendingCounts } from '../../lib/pendingCounts';
import { useCurrentUser } from '../../lib/currentUser';

interface PurchaseOrder {
  id: string; supplier_id: string; supplier_name: string; requested_by: string | null;
  status: string; item_count: number; total_amount: number; created_at: string;
}
interface GoodsReceived {
  id: string; po_id: string; supplier_name: string; received_by: string | null;
  driver_name: string | null; driver_phone: string | null; vehicle_number: string | null;
  delivery_date: string | null; invoice_number: string | null; waybill_number: string | null;
  inspection_officer: string | null; status: string; received_at: string;
}
interface GoodsReceivedItem {
  item_id: string; expected_quantity: number | null; quantity: number;
  accepted_quantity: number | null; rejected_quantity: number | null;
  short_quantity: number | null; over_quantity: number | null; rejection_reason: string | null;
}
interface SupplierReturn {
  id: string; grn_id: string; grn_po_id: string; supplier_id: string; supplier_name: string;
  status: string; created_by: string | null; created_at: string; completed_at: string | null;
}
interface SupplierReturnItem { item_id: string; item_name: string; quantity: number; reason: string | null }
interface PayableRow { supplier_id: string; invoiced: number; paid: number; outstanding: number }
interface Supplier { id: string; name: string; location?: string | null }
interface Item {
  id: string; name: string; type: string; unit_cost: number;
  manufacturer_id?: string | null; pieces_per_bag?: number | null;
}

export default function ProcurementPage() {
  const ui = useUi();
  const { user, isSuperAdmin, hasAccess } = useCurrentUser();
  const canApprove = isSuperAdmin || hasAccess('procurement-approve');
  const [orders, setOrders] = useState<PurchaseOrder[]>([]);
  const [receipts, setReceipts] = useState<GoodsReceived[]>([]);
  const [returns, setReturns] = useState<SupplierReturn[]>([]);
  const [suppliers, setSuppliers] = useState<Supplier[]>([]);
  const [payables, setPayables] = useState<PayableRow[]>([]);
  const [items, setItems] = useState<Item[]>([]);
  const [reloadKey, setReloadKey] = useState(0);

  const [createOpen, setCreateOpen] = useState(false);
  const [receiveFor, setReceiveFor] = useState<PurchaseOrder | null>(null);
  const [inspectFor, setInspectFor] = useState<GoodsReceived | null>(null);
  const [newManufacturerOpen, setNewManufacturerOpen] = useState(false);
  const [newMaterialOpen, setNewMaterialOpen] = useState(false);
  const [mastersReloadKey, setMastersReloadKey] = useState(0);

  const refresh = useCallback(() => { setReloadKey(k => k + 1); refreshPendingCounts(); }, []);
  const refreshMasters = useCallback(() => setMastersReloadKey(k => k + 1), []);
  const poPending = usePendingDeletions('purchase_orders', reloadKey);
  const grnPending = usePendingDeletions('goods_received', reloadKey);
  const grnReversed = useReversedEntities('goods_received', reloadKey);

  useEffect(() => {
    api<PurchaseOrder[]>('/purchase-orders').then(setOrders);
    api<GoodsReceived[]>('/goods-received').then(setReceipts);
    api<SupplierReturn[]>('/supplier-returns').then(setReturns);
  }, [reloadKey]);

  useEffect(() => {
    api<Supplier[]>('/masters/suppliers').then(setSuppliers);
    api<Item[]>('/masters/items').then(rows => setItems(rows.filter(i => i.type !== 'FINISHED_GOOD')));
    api<PayableRow[]>('/finance/payables').then(setPayables);
  }, [mastersReloadKey, reloadKey]);

  const kpis = useMemo(() => [
    { key: 'total', label: 'Total purchase orders', icon: 'receipt' as const, value: number(orders.length) },
    { key: 'value', label: 'Order value', icon: 'chart' as const, value: naira(orders.reduce((s, o) => s + o.total_amount, 0)) },
    { key: 'awaiting', label: 'Awaiting approval', icon: 'clock' as const, value: number(orders.filter(o => o.status === 'AWAITING_APPROVAL').length) },
    { key: 'pending-inspection', label: 'Pending inspection', icon: 'box' as const, value: number(receipts.filter(r => r.status === 'PENDING_INSPECTION').length) },
    { key: 'open-returns', label: 'Open supplier returns', icon: 'clock' as const, value: number(returns.filter(r => r.status === 'PENDING').length) },
  ], [orders, receipts, returns]);

  async function approve(id: string, status: string) {
    await apiPut(`/purchase-orders/${encodeURIComponent(id)}/status`, { status, userId: user?.id });
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
          key: 'orders', label: 'Purchase orders', badge: orders.filter(o => o.status === 'AWAITING_APPROVAL').length, content: (
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
                          {o.status === 'AWAITING_APPROVAL' && canApprove && (
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
          key: 'receipts', label: 'Goods received', badge: receipts.filter(r => r.status === 'PENDING_INSPECTION').length, content: (
            <Card title="Goods received" description="Deliveries logged against a purchase order — inventory only updates once inspected.">
              <div className="table-wrap">
                <table>
                  <thead><tr><th>GRN</th><th>Purchase order</th><th>Supplier</th><th>Driver / vehicle</th><th>Received by</th><th>Received</th><th>Status</th><th className="no-print">Action</th><th className="no-print" /></tr></thead>
                  <tbody>
                    {receipts.map(r => (
                      <tr key={r.id}>
                        <td><span className="mono" style={{ fontSize: 12, color: 'rgb(var(--aqua-700))' }}>{r.id}</span></td>
                        <td className="mono" style={{ fontSize: 12 }}>{r.po_id}</td>
                        <td>{r.supplier_name}</td>
                        <td className="sub">{r.driver_name ?? '—'}{r.vehicle_number ? ` · ${r.vehicle_number}` : ''}</td>
                        <td>{r.received_by}</td>
                        <td className="sub">{r.received_at}</td>
                        <td><Pill status={r.status} /></td>
                        <td className="no-print">
                          {r.status === 'PENDING_INSPECTION' && (
                            <button className="btn btn-secondary btn-sm" onClick={() => setInspectFor(r)}>Inspect</button>
                          )}
                        </td>
                        <td className="no-print">
                          {r.status === 'PENDING_INSPECTION' ? (
                            <DeleteButton entityType="goods_received" entityId={r.id} entityLabel={r.id} pending={grnPending.has(r.id)} onRequested={() => { refresh(); ui.toast('Deletion requested — pending admin approval'); }} />
                          ) : (
                            <ReverseButton entityType="goods_received" entityId={r.id} entityLabel={r.id} reversed={grnReversed.has(r.id)} onReversed={() => { refresh(); ui.toast('Goods receipt reversed'); }} />
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {receipts.length === 0 && <EmptyState title="Nothing received yet" description="Approve a purchase order, then receive it." onClear={() => {}} />}
            </Card>
          ),
        },
        {
          key: 'returns', label: 'Supplier returns', badge: returns.filter(r => r.status === 'PENDING').length, content: (
            <Card title="Supplier returns" description="Rejected quantities from inspection — never posted to inventory, tracked here through to a credit note or pickup.">
              <div className="table-wrap">
                <table>
                  <thead><tr><th>Return</th><th>GRN</th><th>Purchase order</th><th>Supplier</th><th>Status</th><th>Raised</th><th className="no-print">Action</th></tr></thead>
                  <tbody>
                    {returns.map(r => <SupplierReturnRow key={r.id} ret={r} onCompleted={() => { refresh(); ui.toast(`${r.id} marked completed`); }} />)}
                  </tbody>
                </table>
              </div>
              {returns.length === 0 && <EmptyState title="No supplier returns" description="Raised automatically whenever an inspection rejects part of a delivery." onClear={() => {}} />}
            </Card>
          ),
        },
        {
          key: 'materials', label: 'Suppliers & materials', content: (
            <div style={{ display: 'grid', gap: 20 }}>
              <Card
                title="Manufacturers" description="Companies you buy raw materials from."
                action={<button className="btn btn-primary no-print" onClick={() => setNewManufacturerOpen(true)}><Icon name="plus" size={14} /> New manufacturer</button>}
              >
                <div className="table-wrap">
                  <table>
                    <thead><tr><th>Supplier</th><th>Location</th><th className="num">Outstanding</th></tr></thead>
                    <tbody>
                      {suppliers.map(s => {
                        const payable = payables.find(p => p.supplier_id === s.id);
                        return (
                          <tr key={s.id}>
                            <td>{s.name}</td>
                            <td className="sub">{s.location ?? '—'}</td>
                            <td className="num tnum">{payable ? naira(Math.abs(payable.outstanding)) + (payable.outstanding < 0 ? ' Cr' : '') : '—'}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
                {suppliers.length === 0 && <EmptyState title="No manufacturers yet" description="Add one before creating a material variant for it." onClear={() => {}} />}
              </Card>

              <Card
                title="Material variants" description="Manufacturer/grammage combinations — each stocked and priced separately (e.g. a 16g preform from two different makers)."
                action={<button className="btn btn-primary no-print" onClick={() => setNewMaterialOpen(true)}><Icon name="plus" size={14} /> New material variant</button>}
              >
                <div className="table-wrap">
                  <table>
                    <thead><tr><th>Material</th><th>Manufacturer</th><th className="num">Pieces / bag</th><th className="num">Unit cost</th></tr></thead>
                    <tbody>
                      {items.filter(i => i.pieces_per_bag).map(i => (
                        <tr key={i.id}>
                          <td>{i.name}</td>
                          <td className="sub">{suppliers.find(s => s.id === i.manufacturer_id)?.name ?? '—'}</td>
                          <td className="num tnum">{i.pieces_per_bag?.toLocaleString('en-NG')}</td>
                          <td className="num tnum">{naira(i.unit_cost)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                {items.filter(i => i.pieces_per_bag).length === 0 && <EmptyState title="No material variants yet" description="Create one to enter purchase orders in bags instead of pieces." onClear={() => {}} />}
              </Card>
            </div>
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
      {inspectFor && (
        <InspectGoodsReceived
          grn={inspectFor}
          onClose={() => setInspectFor(null)}
          onInspected={() => { setInspectFor(null); refresh(); ui.toast(`${inspectFor.id} inspected`); }}
        />
      )}
      {newManufacturerOpen && (
        <NewManufacturer
          onClose={() => setNewManufacturerOpen(false)}
          onCreated={() => { setNewManufacturerOpen(false); refreshMasters(); ui.toast('Manufacturer added'); }}
        />
      )}
      {newMaterialOpen && (
        <NewMaterialVariant
          suppliers={suppliers}
          onClose={() => setNewMaterialOpen(false)}
          onCreated={() => { setNewMaterialOpen(false); refreshMasters(); ui.toast('Material variant added'); }}
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
        items: lines.map(l => ({
          itemId: l.itemId, quantity: Number(l.quantity), unitPrice: Number(l.unitPrice),
          bagQuantity: l.bagQuantity ? Number(l.bagQuantity) : undefined,
        })),
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
  const [driverName, setDriverName] = useState('');
  const [driverPhone, setDriverPhone] = useState('');
  const [vehicleNumber, setVehicleNumber] = useState('');
  const [deliveryDate, setDeliveryDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [invoiceNumber, setInvoiceNumber] = useState('');
  const [waybillNumber, setWaybillNumber] = useState('');
  const [lines, setLines] = useState<{ itemId: string; name: string; quantity: string; piecesPerBag?: number | null; bagQuantity?: string }[] | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api<{ items: { item_id: string; quantity: number }[] }>(`/purchase-orders/${encodeURIComponent(order.id)}`).then(async full => {
      const items = await api<Item[]>('/masters/items');
      setLines(full.items.map(it => {
        const item = items.find(i => i.id === it.item_id);
        return {
          itemId: it.item_id, name: item?.name ?? it.item_id, quantity: String(it.quantity),
          piecesPerBag: item?.pieces_per_bag,
          bagQuantity: item?.pieces_per_bag ? String(Math.round(it.quantity / item.pieces_per_bag)) : undefined,
        };
      }));
    });
  }, [order.id]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!lines) return;
    setSaving(true); setError(null);
    try {
      await apiPost('/goods-received', {
        poId: order.id, receivedBy,
        driverName: driverName || undefined, driverPhone: driverPhone || undefined,
        vehicleNumber: vehicleNumber || undefined, deliveryDate: deliveryDate || undefined,
        invoiceNumber: invoiceNumber || undefined, waybillNumber: waybillNumber || undefined,
        items: lines.map(l => ({
          itemId: l.itemId, quantity: Number(l.quantity),
          bagQuantity: l.bagQuantity ? Number(l.bagQuantity) : undefined,
        })),
      });
      onReceived();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong');
    } finally { setSaving(false); }
  }

  return (
    <Modal title={`Receive goods for ${order.id}`} onClose={onClose} onSubmit={submit} submitLabel="Log receipt" saving={saving} error={error} wide>
      <div className="form-grid">
        <div className="form-row">
          <label htmlFor="grn-receivedby">Receiving officer</label>
          <input id="grn-receivedby" value={receivedBy} onChange={e => setReceivedBy(e.target.value)} required autoFocus />
        </div>
        <div className="form-row"><label htmlFor="grn-date">Delivery date</label><input id="grn-date" type="date" value={deliveryDate} onChange={e => setDeliveryDate(e.target.value)} /></div>
        <div className="form-row"><label htmlFor="grn-driver">Driver name</label><input id="grn-driver" value={driverName} onChange={e => setDriverName(e.target.value)} /></div>
        <div className="form-row"><label htmlFor="grn-driver-phone">Driver phone</label><input id="grn-driver-phone" value={driverPhone} onChange={e => setDriverPhone(e.target.value)} /></div>
        <div className="form-row"><label htmlFor="grn-vehicle">Vehicle number</label><input id="grn-vehicle" value={vehicleNumber} onChange={e => setVehicleNumber(e.target.value)} /></div>
        <div className="form-row"><label htmlFor="grn-invoice">Invoice number</label><input id="grn-invoice" value={invoiceNumber} onChange={e => setInvoiceNumber(e.target.value)} /></div>
        <div className="form-row"><label htmlFor="grn-waybill">Waybill number</label><input id="grn-waybill" value={waybillNumber} onChange={e => setWaybillNumber(e.target.value)} /></div>
      </div>
      <div className="form-row">
        <label>Delivered quantities</label>
        {lines === null && <p className="sub">Loading order lines…</p>}
        {lines?.map((l, i) => (
          <div className="lineitem-row" key={l.itemId}>
            <div style={{ flex: 2 }}><p style={{ fontSize: 13 }}>{l.name}</p></div>
            {l.piecesPerBag ? (
              <>
                <div style={{ width: 90 }}>
                  <NumberInput ariaLabel={`Bags for ${l.name}`} allowDecimal={false} value={l.bagQuantity ?? '0'}
                    onChange={v => setLines(ls => ls!.map((x, idx) => idx === i ? { ...x, bagQuantity: v, quantity: String(Number(v || 0) * l.piecesPerBag!) } : x))} required />
                </div>
                <p className="sub" style={{ width: 110, fontSize: 12 }}>= {Number(l.quantity).toLocaleString('en-NG')} pcs</p>
              </>
            ) : (
              <div style={{ width: 100 }}>
                <NumberInput ariaLabel={`Quantity for ${l.name}`} allowDecimal={false} value={l.quantity}
                  onChange={v => setLines(ls => ls!.map((x, idx) => idx === i ? { ...x, quantity: v } : x))} required />
              </div>
            )}
          </div>
        ))}
      </div>
      <p className="sub">This logs the delivery as pending inspection — inventory only updates once the accepted quantity is confirmed.</p>
    </Modal>
  );
}

function InspectGoodsReceived({ grn, onClose, onInspected }: { grn: GoodsReceived; onClose: () => void; onInspected: () => void }) {
  const [inspectionOfficer, setInspectionOfficer] = useState('');
  const [lines, setLines] = useState<{
    itemId: string; name: string; expected: number | null; delivered: number;
    accepted: string; rejected: string; reason: string;
  }[] | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    Promise.all([
      api<{ items: GoodsReceivedItem[] }>(`/goods-received/${encodeURIComponent(grn.id)}`),
      api<Item[]>('/masters/items'),
    ]).then(([full, items]) => {
      setLines(full.items.map(it => ({
        itemId: it.item_id, name: items.find(i => i.id === it.item_id)?.name ?? it.item_id,
        expected: it.expected_quantity, delivered: it.quantity,
        accepted: String(it.quantity), rejected: '0', reason: '',
      })));
    });
  }, [grn.id]);

  function setAccepted(i: number, accepted: string, delivered: number) {
    const rejected = Math.max(delivered - (Number(accepted) || 0), 0);
    setLines(ls => ls!.map((x, idx) => idx === i ? { ...x, accepted, rejected: String(rejected) } : x));
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!lines) return;
    setSaving(true); setError(null);
    try {
      await apiPost(`/goods-received/${encodeURIComponent(grn.id)}/inspect`, {
        inspectionOfficer,
        lines: lines.map(l => ({
          itemId: l.itemId, acceptedQuantity: Number(l.accepted), rejectedQuantity: Number(l.rejected),
          rejectionReason: Number(l.rejected) > 0 ? (l.reason || undefined) : undefined,
        })),
      });
      onInspected();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong');
    } finally { setSaving(false); }
  }

  return (
    <Modal title={`Inspect ${grn.id}`} onClose={onClose} onSubmit={submit} submitLabel="Record inspection" saving={saving} error={error} wide>
      <div className="form-row">
        <label htmlFor="insp-officer">Inspection officer</label>
        <input id="insp-officer" value={inspectionOfficer} onChange={e => setInspectionOfficer(e.target.value)} required autoFocus />
      </div>
      <div className="form-row">
        <label>Expected / delivered / accepted / rejected</label>
        {lines === null && <p className="sub">Loading goods receipt lines…</p>}
        {lines?.map((l, i) => (
          <div key={l.itemId} style={{ padding: '10px 0', borderBottom: '1px solid rgb(var(--border))' }}>
            <div className="lineitem-row">
              <div style={{ flex: 2 }}>
                <p style={{ fontSize: 13 }}>{l.name}</p>
                <p className="sub" style={{ fontSize: 12 }}>Expected {l.expected?.toLocaleString('en-NG') ?? '—'} · Delivered {l.delivered.toLocaleString('en-NG')}</p>
              </div>
              <div style={{ width: 100 }}>
                <NumberInput ariaLabel={`Accepted for ${l.name}`} allowDecimal={false} value={l.accepted}
                  onChange={v => setAccepted(i, v, l.delivered)} required />
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
      <p className="sub">Only the accepted quantity posts to inventory. Any rejected quantity raises a linked supplier return.</p>
    </Modal>
  );
}

function SupplierReturnRow({ ret, onCompleted }: { ret: SupplierReturn; onCompleted: () => void }) {
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<SupplierReturnItem[] | null>(null);
  const [completing, setCompleting] = useState(false);

  async function toggle() {
    if (!open && items === null) {
      const full = await api<{ items: SupplierReturnItem[] }>(`/supplier-returns/${encodeURIComponent(ret.id)}`);
      setItems(full.items);
    }
    setOpen(o => !o);
  }

  async function complete() {
    setCompleting(true);
    try {
      await apiPost(`/supplier-returns/${encodeURIComponent(ret.id)}/complete`, {});
      onCompleted();
    } finally { setCompleting(false); }
  }

  return (
    <>
      <tr>
        <td className="mono" style={{ fontSize: 12, color: 'rgb(var(--aqua-700))', cursor: 'pointer' }} onClick={toggle}>{ret.id}</td>
        <td className="mono" style={{ fontSize: 12 }}>{ret.grn_id}</td>
        <td className="mono" style={{ fontSize: 12 }}>{ret.grn_po_id}</td>
        <td>{ret.supplier_name}</td>
        <td><Pill status={ret.status} /></td>
        <td className="sub">{ret.created_at}</td>
        <td className="no-print">
          {ret.status === 'PENDING' && (
            <button className="btn btn-secondary btn-sm" onClick={complete} disabled={completing}>Mark completed</button>
          )}
        </td>
      </tr>
      {open && items && (
        <tr>
          <td colSpan={7}>
            <div style={{ padding: '4px 0 10px 20px' }}>
              {items.map(it => (
                <p key={it.item_id} className="sub" style={{ fontSize: 12 }}>
                  {it.quantity.toLocaleString('en-NG')} × {it.item_name}{it.reason ? ` — ${it.reason}` : ''}
                </p>
              ))}
            </div>
          </td>
        </tr>
      )}
    </>
  );
}

function NewManufacturer({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const [name, setName] = useState('');
  const [location, setLocation] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true); setError(null);
    try {
      await apiPost('/masters/suppliers', { name, location: location || undefined });
      onCreated();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong');
    } finally { setSaving(false); }
  }

  return (
    <Modal title="New manufacturer" onClose={onClose} onSubmit={submit} submitLabel="Add manufacturer" saving={saving} error={error}>
      <div className="form-row"><label htmlFor="mfr-name">Name</label><input id="mfr-name" value={name} onChange={e => setName(e.target.value)} required autoFocus /></div>
      <div className="form-row"><label htmlFor="mfr-location">Location (optional)</label><input id="mfr-location" value={location} onChange={e => setLocation(e.target.value)} /></div>
    </Modal>
  );
}

function NewMaterialVariant({ suppliers, onClose, onCreated }: { suppliers: Supplier[]; onClose: () => void; onCreated: () => void }) {
  const [name, setName] = useState('');
  const [category, setCategory] = useState('Raw material');
  const [type, setType] = useState<'RAW_MATERIAL' | 'PACKAGING' | 'CONSUMABLE'>('RAW_MATERIAL');
  const [manufacturerId, setManufacturerId] = useState(suppliers[0]?.id ?? '');
  const [piecesPerBag, setPiecesPerBag] = useState('1000');
  const [unitCost, setUnitCost] = useState('0');
  const [reorderPoint, setReorderPoint] = useState('0');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true); setError(null);
    try {
      await apiPost('/masters/items', {
        name, category, type, uom: 'unit',
        reorderPoint: Number(reorderPoint), unitCost: Number(unitCost),
        manufacturerId: manufacturerId || undefined, piecesPerBag: Number(piecesPerBag),
      });
      onCreated();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong');
    } finally { setSaving(false); }
  }

  return (
    <Modal title="New material variant" onClose={onClose} onSubmit={submit} submitLabel="Add material" saving={saving} error={error} wide>
      <div className="form-grid">
        <div className="form-row">
          <label htmlFor="mat-name">Name</label>
          <input id="mat-name" value={name} onChange={e => setName(e.target.value)} placeholder="e.g. PET Preform 16g" required autoFocus />
        </div>
        <div className="form-row">
          <label htmlFor="mat-manufacturer">Manufacturer</label>
          <select id="mat-manufacturer" value={manufacturerId} onChange={e => setManufacturerId(e.target.value)}>
            {suppliers.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
        </div>
        <div className="form-row">
          <label htmlFor="mat-category">Category</label>
          <input id="mat-category" value={category} onChange={e => setCategory(e.target.value)} required />
        </div>
        <div className="form-row">
          <label htmlFor="mat-type">Type</label>
          <select id="mat-type" value={type} onChange={e => setType(e.target.value as typeof type)}>
            <option value="RAW_MATERIAL">Raw material</option>
            <option value="PACKAGING">Packaging</option>
            <option value="CONSUMABLE">Consumable</option>
          </select>
        </div>
        <div className="form-row">
          <label htmlFor="mat-pieces">Pieces per bag</label>
          <NumberInput id="mat-pieces" allowDecimal={false} value={piecesPerBag} onChange={setPiecesPerBag} required />
        </div>
        <div className="form-row">
          <label htmlFor="mat-cost">Unit cost (per piece)</label>
          <NumberInput id="mat-cost" value={unitCost} onChange={setUnitCost} required />
        </div>
        <div className="form-row">
          <label htmlFor="mat-reorder">Reorder point (pieces)</label>
          <NumberInput id="mat-reorder" allowDecimal={false} value={reorderPoint} onChange={setReorderPoint} required />
        </div>
      </div>
      <p className="sub">Purchase orders for this material will be entered in bags — the piece count is computed automatically.</p>
    </Modal>
  );
}
