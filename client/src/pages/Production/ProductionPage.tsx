import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import { api, apiPost } from '../../lib/apiClient';
import { number } from '../../lib/format';
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
import type { ModuleRow, Paginated } from '@shared/types';

interface MaterialRequest { id: string; requested_by: string; department: string; status: string; needed_by: string | null; created_at: string }
interface ProductionBatch {
  id: string; product_item_id: string; product_name: string; line: string; shift: string; operator: string;
  units_target: number; units_actual: number; status: string; qc_verdict: 'PASS' | 'FAIL' | null; packaged_units: number;
}
interface FinishedGood { id: string; item_name: string; batch_id: string; quantity: number; packaged_by: string | null; packaged_at: string }
interface Item { id: string; name: string; type: string }

export default function ProductionPage() {
  const ui = useUi();
  const [requests, setRequests] = useState<MaterialRequest[]>([]);
  const [batches, setBatches] = useState<ProductionBatch[]>([]);
  const [readyToPackage, setReadyToPackage] = useState<ProductionBatch[]>([]);
  const [finishedGoods, setFinishedGoods] = useState<FinishedGood[]>([]);
  const [rawItems, setRawItems] = useState<Item[]>([]);
  const [finishedItems, setFinishedItems] = useState<Item[]>([]);
  const [waterRuns, setWaterRuns] = useState<{ id: string }[]>([]);
  const [reloadKey, setReloadKey] = useState(0);

  const [requestOpen, setRequestOpen] = useState(false);
  const [batchOpen, setBatchOpen] = useState(false);
  const [packageTarget, setPackageTarget] = useState<ProductionBatch | null>(null);

  const refresh = useCallback(() => setReloadKey(k => k + 1), []);
  const requestsPending = usePendingDeletions('material_requests', reloadKey);
  const batchesPending = usePendingDeletions('production_batches', reloadKey);
  const finishedGoodsPending = usePendingDeletions('finished_goods', reloadKey);

  useEffect(() => {
    api<MaterialRequest[]>('/material-requests').then(setRequests);
    api<ProductionBatch[]>('/production-batches').then(setBatches);
    api<ProductionBatch[]>('/production-batches/ready-to-package').then(setReadyToPackage);
    api<FinishedGood[]>('/finished-goods').then(setFinishedGoods);
  }, [reloadKey]);

  useEffect(() => {
    api<Item[]>('/masters/items').then(all => {
      setRawItems(all.filter(i => i.type !== 'FINISHED_GOOD'));
      setFinishedItems(all.filter(i => i.type === 'FINISHED_GOOD'));
    });
    api<{ config: unknown; kpis: unknown; data: Paginated<ModuleRow> }>('/modules/water-treatment')
      .then(res => setWaterRuns(res.data.rows.map(r => ({ id: r.id }))));
  }, []);

  async function issue(id: string) { await apiPost(`/material-requests/${encodeURIComponent(id)}/issue`, {}); ui.toast(`${id} issued`); refresh(); }
  async function reject(id: string) { await apiPost(`/material-requests/${encodeURIComponent(id)}/reject`, {}); ui.toast(`${id} rejected`); refresh(); }

  const kpis = useMemo(() => [
    { key: 'batches', label: 'Batches recorded', icon: 'factory' as const, value: number(batches.length) },
    { key: 'units', label: 'Units produced', icon: 'drop' as const, value: number(batches.reduce((s, b) => s + b.units_actual, 0)) },
    { key: 'ready', label: 'Ready to package', icon: 'box' as const, value: number(readyToPackage.filter(b => b.packaged_units === 0).length) },
    { key: 'requests', label: 'Material requests pending', icon: 'clock' as const, value: number(requests.filter(r => r.status === 'PENDING').length) },
  ], [batches, readyToPackage, requests]);

  return (
    <>
      <PrintHeader />
      <div className="pagehead">
        <div><h1>Production</h1><p className="pagesub">Materials issued to the floor, batches manufactured, and what's been packaged.</p></div>
      </div>

      <KpiRow kpis={kpis} />

      <Tabs tabs={[
        {
          key: 'requests', label: 'Material requests', content: (
            <Card
              title="Material requests" description="Raw materials drawn from the warehouse to the production floor."
              action={<button className="btn btn-primary no-print" onClick={() => setRequestOpen(true)}><Icon name="plus" size={14} /> New request</button>}
            >
              <div style={{ overflowX: 'auto' }}>
                <table>
                  <thead><tr><th>Request</th><th>Department</th><th>Requested by</th><th>Status</th><th className="no-print">Action</th><th className="no-print" /></tr></thead>
                  <tbody>
                    {requests.map(r => (
                      <tr key={r.id}>
                        <td className="mono" style={{ fontSize: 12, color: 'rgb(var(--aqua-700))' }}>{r.id}</td>
                        <td>{r.department}</td>
                        <td>{r.requested_by}</td>
                        <td><Pill status={r.status} /></td>
                        <td className="no-print">
                          {r.status === 'PENDING' && (
                            <div style={{ display: 'flex', gap: 6 }}>
                              <button className="btn btn-secondary btn-sm" onClick={() => issue(r.id)}>Approve &amp; issue</button>
                              <button className="btn btn-secondary btn-sm" onClick={() => reject(r.id)}>Reject</button>
                            </div>
                          )}
                        </td>
                        <td className="no-print">
                          <DeleteButton entityType="material_requests" entityId={r.id} entityLabel={r.id} pending={requestsPending.has(r.id)} onRequested={() => { refresh(); ui.toast('Deletion requested — pending admin approval'); }} />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {requests.length === 0 && <EmptyState title="No material requests yet" description="Raise one to draw materials from the warehouse." onClear={() => {}} />}
            </Card>
          ),
        },
        {
          key: 'batches', label: 'Production batches', content: (
            <Card
              title="Production batches" description="Manufacturing runs, each needing a QC pass before packaging."
              action={<button className="btn btn-primary no-print" onClick={() => setBatchOpen(true)}><Icon name="plus" size={14} /> New batch</button>}
            >
              <div style={{ overflowX: 'auto' }}>
                <table>
                  <thead><tr><th>Batch</th><th>Product</th><th>Line / shift</th><th className="num">Units</th><th>QC</th><th className="num">Packaged</th><th className="no-print" /></tr></thead>
                  <tbody>
                    {batches.map(b => (
                      <tr key={b.id}>
                        <td className="mono" style={{ fontSize: 12, color: 'rgb(var(--aqua-700))' }}>{b.id}</td>
                        <td>{b.product_name}</td>
                        <td className="sub">{b.line} · {b.shift}</td>
                        <td className="num tnum">{b.units_actual.toLocaleString('en-NG')}</td>
                        <td>{b.qc_verdict ? <Pill status={b.qc_verdict} /> : <span className="sub">Pending</span>}</td>
                        <td className="num tnum">{b.packaged_units.toLocaleString('en-NG')}</td>
                        <td className="no-print">
                          <DeleteButton entityType="production_batches" entityId={b.id} entityLabel={b.id} pending={batchesPending.has(b.id)} onRequested={() => { refresh(); ui.toast('Deletion requested — pending admin approval'); }} />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {batches.length === 0 && <EmptyState title="No batches recorded yet" description="Record one once materials are on the line." onClear={() => {}} />}
            </Card>
          ),
        },
        {
          key: 'packaging', label: 'Packaging', content: (
            <div style={{ display: 'grid', gap: 20 }}>
              <Card title="Ready to package" description="QC-passed batches — package to add them to finished-goods inventory.">
                <div style={{ overflowX: 'auto' }}>
                  <table>
                    <thead><tr><th>Batch</th><th>Product</th><th className="num">Units</th><th className="num">Already packaged</th><th className="no-print">Action</th></tr></thead>
                    <tbody>
                      {readyToPackage.map(b => (
                        <tr key={b.id}>
                          <td className="mono" style={{ fontSize: 12, color: 'rgb(var(--aqua-700))' }}>{b.id}</td>
                          <td>{b.product_name}</td>
                          <td className="num tnum">{b.units_actual.toLocaleString('en-NG')}</td>
                          <td className="num tnum">{b.packaged_units.toLocaleString('en-NG')}</td>
                          <td className="no-print"><button className="btn btn-secondary btn-sm" onClick={() => setPackageTarget(b)}>Package</button></td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                {readyToPackage.length === 0 && <EmptyState title="Nothing ready yet" description="A batch needs a QC pass before it can be packaged." onClear={() => {}} />}
              </Card>

              <Card title="Finished goods packaged" description="Every packaging run, most recent first.">
                <div style={{ overflowX: 'auto' }}>
                  <table>
                    <thead><tr><th>Record</th><th>Item</th><th>Batch</th><th className="num">Cases</th><th>Packaged by</th><th className="no-print" /></tr></thead>
                    <tbody>
                      {finishedGoods.map(f => (
                        <tr key={f.id}>
                          <td className="mono" style={{ fontSize: 12, color: 'rgb(var(--aqua-700))' }}>{f.id}</td>
                          <td>{f.item_name}</td>
                          <td className="mono" style={{ fontSize: 12 }}>{f.batch_id}</td>
                          <td className="num tnum">{f.quantity.toLocaleString('en-NG')}</td>
                          <td>{f.packaged_by}</td>
                          <td className="no-print">
                            <DeleteButton entityType="finished_goods" entityId={f.id} entityLabel={f.id} pending={finishedGoodsPending.has(f.id)} onRequested={() => { refresh(); ui.toast('Deletion requested — pending admin approval'); }} />
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                {finishedGoods.length === 0 && <EmptyState title="Nothing packaged yet" description="Package a ready batch above." onClear={() => {}} />}
              </Card>
            </div>
          ),
        },
      ]} />

      {requestOpen && (
        <NewMaterialRequest items={rawItems} onClose={() => setRequestOpen(false)} onCreated={() => { setRequestOpen(false); refresh(); ui.toast('Material request submitted'); }} />
      )}
      {batchOpen && (
        <NewBatch products={finishedItems} waterRuns={waterRuns} onClose={() => setBatchOpen(false)} onCreated={() => { setBatchOpen(false); refresh(); ui.toast('Batch recorded'); }} />
      )}
      {packageTarget && (
        <PackageBatch batch={packageTarget} onClose={() => setPackageTarget(null)} onPackaged={() => { setPackageTarget(null); refresh(); ui.toast(`${packageTarget.id} packaged`); }} />
      )}
    </>
  );
}

function NewMaterialRequest({ items, onClose, onCreated }: { items: Item[]; onClose: () => void; onCreated: () => void }) {
  const [requestedBy, setRequestedBy] = useState('');
  const [department, setDepartment] = useState('Production');
  const [lines, setLines] = useState<LineItemValue[]>([{ itemId: items[0]?.id ?? '', quantity: '50', unitPrice: '0' }]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setSaving(true); setError(null);
    try {
      await apiPost('/material-requests', { requestedBy, department, items: lines.map(l => ({ itemId: l.itemId, quantity: Number(l.quantity) })) });
      onCreated();
    } catch (err) { setError(err instanceof Error ? err.message : 'Something went wrong'); }
    finally { setSaving(false); }
  }

  return (
    <Modal title="New material request" onClose={onClose} onSubmit={submit} submitLabel="Submit request" saving={saving} error={error} wide>
      <div className="form-grid">
        <div className="form-row"><label htmlFor="mr-by">Requested by</label><input id="mr-by" value={requestedBy} onChange={e => setRequestedBy(e.target.value)} required autoFocus /></div>
        <div className="form-row"><label htmlFor="mr-dept">Department</label><input id="mr-dept" value={department} onChange={e => setDepartment(e.target.value)} required /></div>
      </div>
      <LineItemsInput items={lines} options={items} onChange={setLines} />
    </Modal>
  );
}

function NewBatch({ products, waterRuns, onClose, onCreated }: { products: Item[]; waterRuns: { id: string }[]; onClose: () => void; onCreated: () => void }) {
  const [productItemId, setProductItemId] = useState(products[0]?.id ?? '');
  const [line, setLine] = useState('Line A');
  const [shift, setShift] = useState('Morning');
  const [operator, setOperator] = useState('');
  const [unitsActual, setUnitsActual] = useState('10000');
  const [waterTreatmentRunId, setWaterTreatmentRunId] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setSaving(true); setError(null);
    try {
      await apiPost('/production-batches', { productItemId, line, shift, operator, unitsActual: Number(unitsActual), waterTreatmentRunId: waterTreatmentRunId || undefined });
      onCreated();
    } catch (err) { setError(err instanceof Error ? err.message : 'Something went wrong'); }
    finally { setSaving(false); }
  }

  return (
    <Modal title="New production batch" onClose={onClose} onSubmit={submit} submitLabel="Record batch" saving={saving} error={error}>
      <div className="form-grid">
        <div className="form-row">
          <label htmlFor="pb-product">Product</label>
          <select id="pb-product" value={productItemId} onChange={e => setProductItemId(e.target.value)}>
            {products.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        </div>
        <div className="form-row"><label htmlFor="pb-operator">Operator</label><input id="pb-operator" value={operator} onChange={e => setOperator(e.target.value)} required autoFocus /></div>
        <div className="form-row">
          <label htmlFor="pb-line">Line</label>
          <select id="pb-line" value={line} onChange={e => setLine(e.target.value)}>
            <option>Line A</option><option>Line B</option><option>Line C</option>
          </select>
        </div>
        <div className="form-row">
          <label htmlFor="pb-shift">Shift</label>
          <select id="pb-shift" value={shift} onChange={e => setShift(e.target.value)}>
            <option>Morning</option><option>Afternoon</option><option>Night</option>
          </select>
        </div>
        <div className="form-row"><label htmlFor="pb-units">Units filled</label><NumberInput id="pb-units" allowDecimal={false} value={unitsActual} onChange={setUnitsActual} required /></div>
        {waterRuns.length > 0 && (
          <div className="form-row">
            <label htmlFor="pb-water">Water source (optional)</label>
            <select id="pb-water" value={waterTreatmentRunId} onChange={e => setWaterTreatmentRunId(e.target.value)}>
              <option value="">Not linked</option>
              {waterRuns.map(w => <option key={w.id} value={w.id}>{w.id}</option>)}
            </select>
          </div>
        )}
      </div>
    </Modal>
  );
}

function PackageBatch({ batch, onClose, onPackaged }: { batch: ProductionBatch; onClose: () => void; onPackaged: () => void }) {
  const [quantity, setQuantity] = useState(String(Math.max(1, Math.round(batch.units_actual / 24) - batch.packaged_units)));
  const [packagedBy, setPackagedBy] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setSaving(true); setError(null);
    try {
      await apiPost('/finished-goods', { batchId: batch.id, itemId: batch.product_item_id, quantity: Number(quantity), packagedBy });
      onPackaged();
    } catch (err) { setError(err instanceof Error ? err.message : 'Something went wrong'); }
    finally { setSaving(false); }
  }

  return (
    <Modal title={`Package ${batch.id}`} onClose={onClose} onSubmit={submit} submitLabel="Package" saving={saving} error={error}>
      <p className="sub" style={{ marginBottom: 14 }}>{batch.product_name} — {batch.units_actual.toLocaleString('en-NG')} units filled, {batch.packaged_units.toLocaleString('en-NG')} cases already packaged.</p>
      <div className="form-row"><label htmlFor="pkg-qty">Cases to package</label><NumberInput id="pkg-qty" allowDecimal={false} value={quantity} onChange={setQuantity} required autoFocus /></div>
      <div className="form-row"><label htmlFor="pkg-by">Packaged by</label><input id="pkg-by" value={packagedBy} onChange={e => setPackagedBy(e.target.value)} required /></div>
    </Modal>
  );
}
