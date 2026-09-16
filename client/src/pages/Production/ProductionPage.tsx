import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import { api, apiPost, apiPut } from '../../lib/apiClient';
import { number } from '../../lib/format';
import { exportCsv } from '../../lib/csv';
import { useUi } from '../../lib/uiState';
import { useCurrentUser } from '../../lib/currentUser';
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
import type { ModuleRow, Paginated } from '@shared/types';

interface MaterialRequest { id: string; requested_by: string; department: string; status: string; po_id: string | null; needed_by: string | null; created_at: string }
interface ProductionBatch {
  id: string; product_item_id: string; product_name: string; line: string; shift: string; operator: string;
  units_target: number; units_actual: number; status: string; qc_verdict: 'PASS' | 'FAIL' | null; packaged_units: number;
  not_yet_packaged: number; packaging_status: 'NOT_STARTED' | 'PARTIAL' | 'COMPLETE';
  rejected_quantity: number; wasted_quantity: number; closed_by: string | null; closed_at: string | null;
  started_at: string;
}
interface FinishedGood { id: string; item_name: string; batch_id: string; quantity: number; packaged_by: string | null; packaged_at: string }
interface Item { id: string; name: string; type: string }
interface ProductionLogItemRow { item_id: string; item_name: string; quantity: number }
interface ProductionLogEntry {
  id: string; recorded_by: string | null; note: string | null; recorded_at: string;
  items: ProductionLogItemRow[]; total_quantity: number;
}
interface BomComponent { itemId: string; itemName: string; qtyPerUnit: number }
interface EmptyBottleRun {
  id: string; quantity_issued: number; issued_by: string | null; status: 'OPEN' | 'RECONCILED';
  damaged_quantity: number | null; leaking_quantity: number | null; finished_quantity: number | null; returned_quantity: number | null;
  actor: string | null; started_at: string; reconciled_at: string | null;
}
interface ConditionSummary { goodEmpty: number; damagedEmpty: number; leakingEmpty: number; repairableEmpty: number; scrappedEmpty: number; warehouseFinishedGoods: number }

export default function ProductionPage() {
  const ui = useUi();
  const [requests, setRequests] = useState<MaterialRequest[]>([]);
  const [batches, setBatches] = useState<ProductionBatch[]>([]);
  const [readyToPackage, setReadyToPackage] = useState<ProductionBatch[]>([]);
  const [finishedGoods, setFinishedGoods] = useState<FinishedGood[]>([]);
  const [logEntries, setLogEntries] = useState<ProductionLogEntry[]>([]);
  const [rawItems, setRawItems] = useState<Item[]>([]);
  const [finishedItems, setFinishedItems] = useState<Item[]>([]);
  const [waterRuns, setWaterRuns] = useState<{ id: string }[]>([]);
  const [reloadKey, setReloadKey] = useState(0);

  const [requestOpen, setRequestOpen] = useState(false);
  const [batchOpen, setBatchOpen] = useState(false);
  const [packageTarget, setPackageTarget] = useState<ProductionBatch | null>(null);
  const [closeTarget, setCloseTarget] = useState<ProductionBatch | null>(null);

  const refresh = useCallback(() => { setReloadKey(k => k + 1); refreshPendingCounts(); }, []);
  const requestsPending = usePendingDeletions('material_requests', reloadKey);
  const requestsReversed = useReversedEntities('material_requests', reloadKey);
  const batchesReversed = useReversedEntities('production_batches', reloadKey);
  const finishedGoodsReversed = useReversedEntities('finished_goods', reloadKey);
  const logReversed = useReversedEntities('production_log_entries', reloadKey);

  useEffect(() => {
    api<MaterialRequest[]>('/material-requests').then(setRequests);
    api<ProductionBatch[]>('/production-batches').then(setBatches);
    api<ProductionBatch[]>('/production-batches/ready-to-package').then(setReadyToPackage);
    api<FinishedGood[]>('/finished-goods').then(setFinishedGoods);
    api<ProductionLogEntry[]>('/production-log').then(setLogEntries);
    api<Item[]>('/masters/items').then(all => {
      setRawItems(all.filter(i => i.type !== 'FINISHED_GOOD'));
      setFinishedItems(all.filter(i => i.type === 'FINISHED_GOOD'));
    });
  }, [reloadKey]);

  useEffect(() => {
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
        <div><h1>Production</h1><p className="pagesub">Log what's produced as it happens, plus materials issued to the floor, batches manufactured, and what's been packaged.</p></div>
      </div>

      <KpiRow kpis={kpis} />

      <Tabs tabs={[
        {
          key: 'production-log', label: 'Production log', content: (
            <ProductionLogTab
              entries={logEntries} products={finishedItems} reversed={logReversed}
              onChanged={refresh}
            />
          ),
        },
        {
          key: 'requests', label: 'Material requests', badge: requests.filter(r => r.status === 'PENDING').length, content: (
            <Card
              title="Material requests" description="Raw materials needed on the floor — every request is routed to Procurement, which raises a purchase order for it."
              action={<button className="btn btn-primary no-print" onClick={() => setRequestOpen(true)}><Icon name="plus" size={14} /> New request</button>}
            >
              <div className="table-wrap">
                <table>
                  <thead><tr><th>Request</th><th>Department</th><th>Requested by</th><th>Requested</th><th>Purchase order</th><th>Status</th><th className="no-print">Action</th><th className="no-print" /></tr></thead>
                  <tbody>
                    {requests.map(r => (
                      <tr key={r.id}>
                        <td className="mono" style={{ fontSize: 12, color: 'rgb(var(--aqua-700))' }}>{r.id}</td>
                        <td>{r.department}</td>
                        <td>{r.requested_by}</td>
                        <td className="sub">{r.created_at}</td>
                        <td className="mono" style={{ fontSize: 12 }}>{r.po_id ?? '—'}</td>
                        <td><Pill status={r.status} /></td>
                        <td className="no-print">
                          {r.status === 'PENDING' && (
                            <button className="btn btn-secondary btn-sm" onClick={() => reject(r.id)}>Reject</button>
                          )}
                          {r.status === 'ORDERED' && (
                            <button className="btn btn-secondary btn-sm" onClick={() => issue(r.id)}>Issue to floor</button>
                          )}
                        </td>
                        <td className="no-print">
                          {r.status === 'ISSUED' ? (
                            <ReverseButton entityType="material_requests" entityId={r.id} entityLabel={r.id} reversed={requestsReversed.has(r.id)} onReversed={() => { refresh(); ui.toast('Material request reversed'); }} />
                          ) : (
                            <DeleteButton entityType="material_requests" entityId={r.id} entityLabel={r.id} pending={requestsPending.has(r.id)} onRequested={() => { refresh(); ui.toast('Deletion requested — pending admin approval'); }} />
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {requests.length === 0 && <EmptyState title="No material requests yet" description="Raise one to send it to Procurement." onClear={() => {}} />}
            </Card>
          ),
        },
        {
          key: 'batches', label: 'Production batches', content: (
            <Card
              title="Production batches" description="Manufacturing runs, each needing a QC pass before packaging."
              action={<button className="btn btn-primary no-print" onClick={() => setBatchOpen(true)}><Icon name="plus" size={14} /> New batch</button>}
            >
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>Batch</th><th>Product</th><th>Line / shift</th><th className="num">Produced</th><th>QC</th>
                      <th className="num">Packaged</th><th className="num">Not yet packaged</th><th className="num">Rejected</th><th className="num">Wasted</th>
                      <th>Started</th><th>Closed</th><th className="no-print" />
                    </tr>
                  </thead>
                  <tbody>
                    {batches.map(b => (
                      <tr key={b.id}>
                        <td className="mono" style={{ fontSize: 12, color: 'rgb(var(--aqua-700))' }}>{b.id}</td>
                        <td>{b.product_name}</td>
                        <td className="sub">{b.line} · {b.shift}</td>
                        <td className="num tnum">{b.units_actual.toLocaleString('en-NG')}</td>
                        <td>{b.qc_verdict ? <Pill status={b.qc_verdict} /> : <span className="sub">Pending</span>}</td>
                        <td className="num tnum">{b.packaged_units.toLocaleString('en-NG')}</td>
                        <td className="num tnum">{b.not_yet_packaged.toLocaleString('en-NG')}</td>
                        <td className="num tnum">{b.rejected_quantity.toLocaleString('en-NG')}</td>
                        <td className="num tnum">{b.wasted_quantity.toLocaleString('en-NG')}</td>
                        <td className="sub">{b.started_at}</td>
                        <td>
                          {b.closed_at ? <Pill status="COMPLETE" /> : (
                            b.status === 'COMPLETED' && (
                              <button className="btn btn-secondary btn-sm no-print" onClick={() => setCloseTarget(b)}>Close batch</button>
                            )
                          )}
                        </td>
                        <td className="no-print">
                          <ReverseButton entityType="production_batches" entityId={b.id} entityLabel={b.id} reversed={batchesReversed.has(b.id)} onReversed={() => { refresh(); ui.toast('Production batch reversed'); }} />
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
                <div className="table-wrap">
                  <table>
                    <thead><tr><th>Batch</th><th>Product</th><th className="num">Units</th><th className="num">Already packaged</th><th>Started</th><th className="no-print">Action</th></tr></thead>
                    <tbody>
                      {readyToPackage.map(b => (
                        <tr key={b.id}>
                          <td className="mono" style={{ fontSize: 12, color: 'rgb(var(--aqua-700))' }}>{b.id}</td>
                          <td>{b.product_name}</td>
                          <td className="num tnum">{b.units_actual.toLocaleString('en-NG')}</td>
                          <td className="num tnum">{b.packaged_units.toLocaleString('en-NG')}</td>
                          <td className="sub">{b.started_at}</td>
                          <td className="no-print"><button className="btn btn-secondary btn-sm" onClick={() => setPackageTarget(b)}>Package</button></td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                {readyToPackage.length === 0 && <EmptyState title="Nothing ready yet" description="A batch needs a QC pass before it can be packaged." onClear={() => {}} />}
              </Card>

              <Card title="Finished goods packaged" description="Every packaging run, most recent first.">
                <div className="table-wrap">
                  <table>
                    <thead><tr><th>Record</th><th>Item</th><th>Batch</th><th className="num">Cases</th><th>Packaged by</th><th>Packaged</th><th className="no-print" /></tr></thead>
                    <tbody>
                      {finishedGoods.map(f => (
                        <tr key={f.id}>
                          <td className="mono" style={{ fontSize: 12, color: 'rgb(var(--aqua-700))' }}>{f.id}</td>
                          <td>{f.item_name}</td>
                          <td className="mono" style={{ fontSize: 12 }}>{f.batch_id}</td>
                          <td className="num tnum">{f.quantity.toLocaleString('en-NG')}</td>
                          <td>{f.packaged_by}</td>
                          <td className="sub">{f.packaged_at}</td>
                          <td className="no-print">
                            <ReverseButton entityType="finished_goods" entityId={f.id} entityLabel={f.id} reversed={finishedGoodsReversed.has(f.id)} onReversed={() => { refresh(); ui.toast('Finished-goods record reversed'); }} />
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
        {
          key: 'recipes', label: 'Recipes', content: (
            <RecipesPanel products={finishedItems} rawItems={rawItems} />
          ),
        },
        { key: 'empty-bottles', label: 'Empty bottles', content: <EmptyBottleTab /> },
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
      {closeTarget && (
        <CloseBatch batch={closeTarget} onClose={() => setCloseTarget(null)} onClosed={() => { setCloseTarget(null); refresh(); ui.toast(`${closeTarget.id} closed`); }} />
      )}
    </>
  );
}

function CloseBatch({ batch, onClose, onClosed }: { batch: ProductionBatch; onClose: () => void; onClosed: () => void }) {
  const [rejected, setRejected] = useState('0');
  const [wasted, setWasted] = useState(String(batch.not_yet_packaged));
  const [closedBy, setClosedBy] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const accounted = batch.packaged_units + (Number(rejected) || 0) + (Number(wasted) || 0);
  const remainder = batch.units_actual - accounted;

  async function submit(e: FormEvent) {
    e.preventDefault();
    setSaving(true); setError(null);
    try {
      await apiPost(`/production-batches/${encodeURIComponent(batch.id)}/close`, {
        rejectedQuantity: Number(rejected), wastedQuantity: Number(wasted), actor: closedBy,
      });
      onClosed();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong');
    } finally { setSaving(false); }
  }

  return (
    <Modal title={`Close ${batch.id}`} onClose={onClose} onSubmit={submit} submitLabel="Close batch" saving={saving} error={error}>
      <p className="sub" style={{ marginBottom: 14 }}>
        {batch.product_name} — {batch.units_actual.toLocaleString('en-NG')} produced, {batch.packaged_units.toLocaleString('en-NG')} already packaged.
        Every unit must be accounted for (packaged + rejected + wasted) before this batch can close.
      </p>
      <div className="form-grid">
        <div className="form-row"><label htmlFor="close-rejected">Rejected</label><NumberInput id="close-rejected" allowDecimal={false} value={rejected} onChange={setRejected} required /></div>
        <div className="form-row"><label htmlFor="close-wasted">Wasted</label><NumberInput id="close-wasted" allowDecimal={false} value={wasted} onChange={setWasted} required /></div>
      </div>
      <div className="form-row"><label htmlFor="close-by">Closed by</label><input id="close-by" value={closedBy} onChange={e => setClosedBy(e.target.value)} required autoFocus /></div>
      <p className="sub" style={{ color: remainder === 0 ? undefined : 'rgb(var(--stop))' }}>
        {remainder === 0
          ? `Fully accounted: ${batch.packaged_units.toLocaleString('en-NG')} packaged + ${(Number(rejected) || 0).toLocaleString('en-NG')} rejected + ${(Number(wasted) || 0).toLocaleString('en-NG')} wasted = ${batch.units_actual.toLocaleString('en-NG')} produced.`
          : `${Math.abs(remainder).toLocaleString('en-NG')} units ${remainder > 0 ? 'still unaccounted for' : 'over-accounted for'} — adjust rejected/wasted to match ${batch.units_actual.toLocaleString('en-NG')} produced.`}
      </p>
    </Modal>
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
  const [recipe, setRecipe] = useState<BomComponent[]>([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!productItemId) { setRecipe([]); return; }
    api<BomComponent[]>(`/bom/${encodeURIComponent(productItemId)}`).then(setRecipe);
  }, [productItemId]);

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
        {recipe.length > 0 && (
          <div className="form-row">
            <label>Will consume (from this product's recipe)</label>
            <ul style={{ margin: 0, paddingLeft: 18, fontSize: 13 }}>
              {recipe.map(c => (
                <li key={c.itemId}>{(Number(unitsActual || 0) * c.qtyPerUnit).toLocaleString('en-NG')} × {c.itemName}</li>
              ))}
            </ul>
          </div>
        )}
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

/** One recipe per finished product — what recordBatch() (server/src/services/production.ts)
 *  auto-consumes from raw-material stock when that product's batch output is recorded.
 *  Empty by default; a product with no rows here gets no auto-consumption. */
function RecipesPanel({ products, rawItems }: { products: Item[]; rawItems: Item[] }) {
  const ui = useUi();
  const [productItemId, setProductItemId] = useState(products[0]?.id ?? '');
  const [components, setComponentsState] = useState<{ itemId: string; qtyPerUnit: string }[]>([]);
  const [saving, setSaving] = useState(false);

  const load = useCallback((id: string) => {
    if (!id) { setComponentsState([]); return; }
    api<BomComponent[]>(`/bom/${encodeURIComponent(id)}`).then(rows =>
      setComponentsState(rows.map(r => ({ itemId: r.itemId, qtyPerUnit: String(r.qtyPerUnit) }))),
    );
  }, []);

  useEffect(() => { load(productItemId); }, [productItemId, load]);

  function updateRow(i: number, patch: Partial<{ itemId: string; qtyPerUnit: string }>) {
    setComponentsState(cs => cs.map((c, idx) => (idx === i ? { ...c, ...patch } : c)));
  }
  function addRow() {
    setComponentsState(cs => [...cs, { itemId: rawItems[0]?.id ?? '', qtyPerUnit: '1' }]);
  }
  function removeRow(i: number) {
    setComponentsState(cs => cs.filter((_, idx) => idx !== i));
  }

  async function save() {
    setSaving(true);
    try {
      await apiPut(`/bom/${encodeURIComponent(productItemId)}`, {
        components: components.filter(c => c.itemId).map(c => ({ itemId: c.itemId, qtyPerUnit: Number(c.qtyPerUnit) || 0 })),
      });
      ui.toast('Recipe saved');
      load(productItemId);
    } finally { setSaving(false); }
  }

  return (
    <Card title="Recipes" description="For one unit of a finished product, how many of each raw material it takes — recording a batch's output auto-deducts this from stock.">
      <div className="form-row" style={{ maxWidth: 360 }}>
        <label htmlFor="recipe-product">Product</label>
        <select id="recipe-product" value={productItemId} onChange={e => setProductItemId(e.target.value)}>
          {products.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
      </div>

      {components.map((c, i) => (
        <div className="lineitem-row" key={i}>
          <div style={{ flex: 2 }}>
            <select aria-label="Raw material" value={c.itemId} onChange={e => updateRow(i, { itemId: e.target.value })}>
              {rawItems.map(o => <option key={o.id} value={o.id}>{o.name}</option>)}
            </select>
          </div>
          <div style={{ width: 120 }}>
            <NumberInput ariaLabel="Quantity per unit" value={c.qtyPerUnit} onChange={v => updateRow(i, { qtyPerUnit: v })} required />
          </div>
          <button type="button" className="iconbtn" onClick={() => removeRow(i)} aria-label="Remove component">
            <Icon name="x" size={16} />
          </button>
        </div>
      ))}
      {components.length === 0 && <p className="sub" style={{ padding: '6px 0' }}>No recipe defined yet — batches of this product won't auto-consume any raw material.</p>}

      <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
        <button type="button" className="btn btn-secondary btn-sm" onClick={addRow}><Icon name="plus" size={12} /> Add component</button>
        <button type="button" className="btn btn-primary btn-sm" onClick={save} disabled={saving || !productItemId}>{saving ? 'Saving…' : 'Save recipe'}</button>
      </div>
    </Card>
  );
}

function EmptyBottleTab() {
  const ui = useUi();
  const [summary, setSummary] = useState<ConditionSummary | null>(null);
  const [runs, setRuns] = useState<EmptyBottleRun[]>([]);
  const [reloadKey, setReloadKey] = useState(0);
  const [startOpen, setStartOpen] = useState(false);
  const [reconcileTarget, setReconcileTarget] = useState<EmptyBottleRun | null>(null);
  const [triageOpen, setTriageOpen] = useState(false);
  const [repairOpen, setRepairOpen] = useState(false);
  const refresh = useCallback(() => { setReloadKey(k => k + 1); refreshPendingCounts(); }, []);

  useEffect(() => { api<ConditionSummary>('/empty-bottles/summary').then(setSummary); }, [reloadKey]);
  useEffect(() => { api<EmptyBottleRun[]>('/empty-bottles/runs').then(setRuns); }, [reloadKey]);

  return (
    <div style={{ display: 'grid', gap: 20 }}>
      <Card
        title="Empty bottle custody" description="Dispenser bottles pulled from the warehouse for production — every bottle issued must reconcile into damaged, leaking, finished, or returned."
        action={<button className="btn btn-primary no-print" onClick={() => setStartOpen(true)}><Icon name="plus" size={14} /> Start run</button>}
      >
        {summary && (
          <div style={{ display: 'flex', gap: 24, flexWrap: 'wrap', padding: '10px 20px 16px' }}>
            <p className="sub">Good Empty <strong style={{ color: 'rgb(var(--ink))' }}>{number(summary.goodEmpty)}</strong></p>
            <p className="sub">Damaged Empty <strong style={{ color: 'rgb(var(--ink))' }}>{number(summary.damagedEmpty)}</strong></p>
            <p className="sub">Leaking Empty <strong style={{ color: 'rgb(var(--ink))' }}>{number(summary.leakingEmpty)}</strong></p>
            <p className="sub">Repairable Empty <strong style={{ color: 'rgb(var(--ink))' }}>{number(summary.repairableEmpty)}</strong></p>
            <p className="sub">Scrapped Empty <strong style={{ color: 'rgb(var(--ink))' }}>{number(summary.scrappedEmpty)}</strong></p>
            <p className="sub">Warehouse Finished Goods <strong style={{ color: 'rgb(var(--ink))' }}>{number(summary.warehouseFinishedGoods)}</strong></p>
          </div>
        )}
        <div className="no-print" style={{ display: 'flex', gap: 8, padding: '0 20px 16px' }}>
          <button className="btn btn-secondary btn-sm" onClick={() => setTriageOpen(true)} disabled={!summary || (summary.damagedEmpty <= 0 && summary.leakingEmpty <= 0)}>Triage defective</button>
          <button className="btn btn-secondary btn-sm" onClick={() => setRepairOpen(true)} disabled={!summary || summary.repairableEmpty <= 0}>Complete repair</button>
        </div>
      </Card>

      <Card title="Runs" description="Every empty-bottle production pull, most recent first.">
        <div className="table-wrap">
          <table>
            <thead><tr><th>Run</th><th className="num">Issued</th><th>Status</th><th className="num">Damaged</th><th className="num">Leaking</th><th className="num">Finished</th><th className="num">Returned</th><th>Started</th><th className="no-print">Action</th></tr></thead>
            <tbody>
              {runs.map(r => (
                <tr key={r.id}>
                  <td className="mono" style={{ fontSize: 12, color: 'rgb(var(--aqua-700))' }}>{r.id}</td>
                  <td className="num tnum">{number(r.quantity_issued)}</td>
                  <td><Pill status={r.status} /></td>
                  <td className="num tnum">{r.damaged_quantity != null ? number(r.damaged_quantity) : '—'}</td>
                  <td className="num tnum">{r.leaking_quantity != null ? number(r.leaking_quantity) : '—'}</td>
                  <td className="num tnum">{r.finished_quantity != null ? number(r.finished_quantity) : '—'}</td>
                  <td className="num tnum">{r.returned_quantity != null ? number(r.returned_quantity) : '—'}</td>
                  <td className="sub">{r.started_at}</td>
                  <td className="no-print">
                    {r.status === 'OPEN' && <button className="btn btn-secondary btn-sm" onClick={() => setReconcileTarget(r)}>Reconcile</button>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {runs.length === 0 && <EmptyState title="No runs yet" description="Start a run to pull empty bottles out for production." onClear={() => {}} />}
      </Card>

      {startOpen && (
        <StartEmptyBottleRun onClose={() => setStartOpen(false)} onStarted={() => { setStartOpen(false); refresh(); ui.toast('Run started'); }} />
      )}
      {reconcileTarget && (
        <ReconcileEmptyBottleRun run={reconcileTarget} onClose={() => setReconcileTarget(null)} onReconciled={() => { setReconcileTarget(null); refresh(); ui.toast(`${reconcileTarget.id} reconciled`); }} />
      )}
      {triageOpen && summary && (
        <TriageDefective summary={summary} onClose={() => setTriageOpen(false)} onTriaged={() => { setTriageOpen(false); refresh(); ui.toast('Triaged'); }} />
      )}
      {repairOpen && summary && (
        <CompleteRepair repairable={summary.repairableEmpty} onClose={() => setRepairOpen(false)} onRepaired={() => { setRepairOpen(false); refresh(); ui.toast('Repair completed'); }} />
      )}
    </div>
  );
}

function StartEmptyBottleRun({ onClose, onStarted }: { onClose: () => void; onStarted: () => void }) {
  const [quantityIssued, setQuantityIssued] = useState('500');
  const [issuedBy, setIssuedBy] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setSaving(true); setError(null);
    try {
      await apiPost('/empty-bottles/runs', { quantityIssued: Number(quantityIssued), issuedBy });
      onStarted();
    } catch (err) { setError(err instanceof Error ? err.message : 'Something went wrong'); }
    finally { setSaving(false); }
  }

  return (
    <Modal title="Start empty-bottle run" onClose={onClose} onSubmit={submit} submitLabel="Start" saving={saving} error={error}>
      <div className="form-row"><label htmlFor="ebr-qty">Total empty bottles</label><NumberInput id="ebr-qty" allowDecimal={false} value={quantityIssued} onChange={setQuantityIssued} required autoFocus /></div>
      <div className="form-row"><label htmlFor="ebr-by">Issued by</label><input id="ebr-by" value={issuedBy} onChange={e => setIssuedBy(e.target.value)} required /></div>
      <p className="sub">Pulls this quantity out of the Empty Bottle Warehouse — reconcile the run once inspection and production are done.</p>
    </Modal>
  );
}

function ReconcileEmptyBottleRun({ run, onClose, onReconciled }: { run: EmptyBottleRun; onClose: () => void; onReconciled: () => void }) {
  const [damaged, setDamaged] = useState('0');
  const [leaking, setLeaking] = useState('0');
  const [finishedProduction, setFinishedProduction] = useState('0');
  const [actor, setActor] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const explained = (Number(damaged) || 0) + (Number(leaking) || 0) + (Number(finishedProduction) || 0);
  const available = run.quantity_issued - (Number(damaged) || 0) - (Number(leaking) || 0);
  const returned = Math.max(run.quantity_issued - explained, 0);
  const overExplained = explained > run.quantity_issued;

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (overExplained) { setError(`Cannot account for ${explained} — only ${run.quantity_issued} was issued.`); return; }
    setSaving(true); setError(null);
    try {
      await apiPost(`/empty-bottles/runs/${encodeURIComponent(run.id)}/reconcile`, {
        damaged: Number(damaged) || 0, leaking: Number(leaking) || 0, finishedProduction: Number(finishedProduction) || 0, actor,
      });
      onReconciled();
    } catch (err) { setError(err instanceof Error ? err.message : 'Something went wrong'); }
    finally { setSaving(false); }
  }

  return (
    <Modal title={`Reconcile ${run.id}`} onClose={onClose} onSubmit={submit} submitLabel="Reconcile" saving={saving} error={error} wide>
      <p className="sub" style={{ marginBottom: 10 }}>{run.quantity_issued.toLocaleString('en-NG')} total empty bottles issued for this run.</p>
      <div className="form-grid">
        <div className="form-row"><label htmlFor="ebr-damaged">Damaged (morning inspection)</label><NumberInput id="ebr-damaged" allowDecimal={false} value={damaged} onChange={setDamaged} /></div>
        <div className="form-row"><label htmlFor="ebr-leaking">Leaking (during production)</label><NumberInput id="ebr-leaking" allowDecimal={false} value={leaking} onChange={setLeaking} /></div>
        <div className="form-row"><label htmlFor="ebr-finished">Finished production</label><NumberInput id="ebr-finished" allowDecimal={false} value={finishedProduction} onChange={setFinishedProduction} /></div>
        <div className="form-row"><label htmlFor="ebr-by">Reconciled by</label><input id="ebr-by" value={actor} onChange={e => setActor(e.target.value)} required autoFocus /></div>
      </div>
      <p className="sub">Available after inspection: <strong>{Math.max(available, 0).toLocaleString('en-NG')}</strong> · Auto-returned to warehouse (unused): <strong>{returned.toLocaleString('en-NG')}</strong></p>
      {overExplained && <p className="sub" style={{ fontWeight: 600 }}>⚠ {explained} accounted for, but only {run.quantity_issued} was issued.</p>}
    </Modal>
  );
}

function TriageDefective({ summary, onClose, onTriaged }: { summary: ConditionSummary; onClose: () => void; onTriaged: () => void }) {
  const [fromState, setFromState] = useState<'DAMAGED' | 'LEAKING'>(summary.damagedEmpty > 0 ? 'DAMAGED' : 'LEAKING');
  const [repairable, setRepairable] = useState('0');
  const [scrapped, setScrapped] = useState('0');
  const [actor, setActor] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const currentUntriaged = fromState === 'DAMAGED' ? summary.damagedEmpty : summary.leakingEmpty;
  const total = (Number(repairable) || 0) + (Number(scrapped) || 0);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (total > currentUntriaged) { setError(`Cannot triage ${total} — only ${currentUntriaged} untriaged.`); return; }
    setSaving(true); setError(null);
    try {
      await apiPost('/empty-bottles/triage', { fromState, repairable: Number(repairable) || 0, scrapped: Number(scrapped) || 0, actor });
      onTriaged();
    } catch (err) { setError(err instanceof Error ? err.message : 'Something went wrong'); }
    finally { setSaving(false); }
  }

  return (
    <Modal title="Triage defective bottles" onClose={onClose} onSubmit={submit} submitLabel="Triage" saving={saving} error={error}>
      <div className="form-row">
        <label htmlFor="ebr-triage-from">From state</label>
        <select id="ebr-triage-from" value={fromState} onChange={e => setFromState(e.target.value as 'DAMAGED' | 'LEAKING')}>
          <option value="DAMAGED">Damaged ({summary.damagedEmpty.toLocaleString('en-NG')} untriaged)</option>
          <option value="LEAKING">Leaking ({summary.leakingEmpty.toLocaleString('en-NG')} untriaged)</option>
        </select>
      </div>
      <div className="form-grid">
        <div className="form-row"><label htmlFor="ebr-repairable">Repairable</label><NumberInput id="ebr-repairable" allowDecimal={false} value={repairable} onChange={setRepairable} /></div>
        <div className="form-row"><label htmlFor="ebr-scrapped">Scrapped</label><NumberInput id="ebr-scrapped" allowDecimal={false} value={scrapped} onChange={setScrapped} /></div>
      </div>
      <div className="form-row"><label htmlFor="ebr-triage-by">Actor</label><input id="ebr-triage-by" value={actor} onChange={e => setActor(e.target.value)} required autoFocus /></div>
    </Modal>
  );
}

function CompleteRepair({ repairable, onClose, onRepaired }: { repairable: number; onClose: () => void; onRepaired: () => void }) {
  const [quantity, setQuantity] = useState(String(repairable));
  const [actor, setActor] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setSaving(true); setError(null);
    try {
      await apiPost('/empty-bottles/repair', { quantity: Number(quantity), actor });
      onRepaired();
    } catch (err) { setError(err instanceof Error ? err.message : 'Something went wrong'); }
    finally { setSaving(false); }
  }

  return (
    <Modal title="Complete repair" onClose={onClose} onSubmit={submit} submitLabel="Repair" saving={saving} error={error}>
      <p className="sub" style={{ marginBottom: 10 }}>{repairable.toLocaleString('en-NG')} bottles currently repairable.</p>
      <div className="form-row"><label htmlFor="ebr-repair-qty">Quantity repaired</label><NumberInput id="ebr-repair-qty" allowDecimal={false} value={quantity} onChange={setQuantity} required autoFocus /></div>
      <div className="form-row"><label htmlFor="ebr-repair-by">Actor</label><input id="ebr-repair-by" value={actor} onChange={e => setActor(e.target.value)} required /></div>
      <p className="sub">Returns this quantity to the Empty Bottle Warehouse as Good Empty stock.</p>
    </Modal>
  );
}

/** One flattened production-log row per product line — what the activity report
 *  table filters, totals and exports. */
interface LogLine {
  entryId: string; recordedBy: string; recordedAt: string; day: string; note: string;
  itemId: string; itemName: string; quantity: number; reversed: boolean;
}

/** Section: direct production log. The day-to-day "what did we produce" entry —
 *  timestamped automatically, posts straight into the Finished Goods Warehouse,
 *  and doubles as a per-period activity report via the date/product filters. */
function ProductionLogTab({ entries, products, reversed, onChanged }: {
  entries: ProductionLogEntry[];
  products: Item[];
  reversed: Set<string>;
  onChanged: () => void;
}) {
  const ui = useUi();
  const [recordOpen, setRecordOpen] = useState(false);
  const [newProductOpen, setNewProductOpen] = useState(false);
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [productId, setProductId] = useState('');

  const lines = useMemo<LogLine[]>(() => entries.flatMap(e =>
    e.items.map(it => ({
      entryId: e.id,
      recordedBy: e.recorded_by ?? '',
      recordedAt: e.recorded_at,
      day: e.recorded_at.slice(0, 10),
      note: e.note ?? '',
      itemId: it.item_id,
      itemName: it.item_name,
      quantity: it.quantity,
      reversed: reversed.has(e.id),
    })),
  ), [entries, reversed]);

  const filtered = useMemo(() => lines.filter(l =>
    (!from || l.day >= from) && (!to || l.day <= to) && (!productId || l.itemId === productId),
  ), [lines, from, to, productId]);

  const totals = useMemo(() => {
    const m = new Map<string, number>();
    for (const l of filtered) m.set(l.itemName, (m.get(l.itemName) ?? 0) + l.quantity);
    return [...m.entries()].sort((a, b) => b[1] - a[1]);
  }, [filtered]);
  const grandTotal = filtered.reduce((s, l) => s + l.quantity, 0);
  const hasFilter = !!(from || to || productId);
  function clearFilters() { setFrom(''); setTo(''); setProductId(''); }

  function handleExport() {
    exportCsv<LogLine>('elim-production-log.csv', [
      { label: 'Entry', get: l => l.entryId },
      { label: 'Recorded at (UTC)', get: l => l.recordedAt },
      { label: 'Product', get: l => l.itemName },
      { label: 'Quantity', get: l => l.quantity },
      { label: 'Recorded by', get: l => l.recordedBy },
      { label: 'Note', get: l => l.note },
      { label: 'Reversed', get: l => (l.reversed ? 'Yes' : 'No') },
    ], filtered);
  }

  return (
    <Card
      title="Production log"
      description="Every production entry, fully timestamped — filter by date and product for an activity report per period. Each line is posted to the Finished Goods Warehouse as it's recorded."
      action={
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }} className="no-print">
          <button className="btn btn-secondary btn-sm" onClick={() => setNewProductOpen(true)}><Icon name="plus" size={14} /> New product</button>
          <button className="btn btn-primary btn-sm" onClick={() => setRecordOpen(true)} disabled={products.length === 0}><Icon name="plus" size={14} /> Record production</button>
        </div>
      }
    >
      <div className="no-print" style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'end', padding: '0 20px 12px' }}>
        <label style={{ display: 'grid', gap: 4, fontSize: 12, color: 'rgb(var(--muted))' }}>
          From
          <input type="date" value={from} onChange={e => setFrom(e.target.value)} />
        </label>
        <label style={{ display: 'grid', gap: 4, fontSize: 12, color: 'rgb(var(--muted))' }}>
          To
          <input type="date" value={to} onChange={e => setTo(e.target.value)} />
        </label>
        <label style={{ display: 'grid', gap: 4, fontSize: 12, color: 'rgb(var(--muted))' }}>
          Product
          <select value={productId} onChange={e => setProductId(e.target.value)}>
            <option value="">All products</option>
            {products.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        </label>
        {hasFilter && <button type="button" className="btn btn-secondary btn-sm" onClick={clearFilters}>Clear</button>}
        <button type="button" className="btn btn-secondary btn-sm" style={{ marginLeft: 'auto' }} onClick={handleExport} disabled={filtered.length === 0}>
          <Icon name="download" size={12} /> Export CSV
        </button>
      </div>

      {filtered.length > 0 && (
        <div style={{ display: 'flex', gap: 20, flexWrap: 'wrap', padding: '0 20px 14px' }}>
          {totals.map(([name, qty]) => (
            <p key={name} className="sub">{name} <strong style={{ color: 'rgb(var(--ink))' }}>{number(qty)}</strong></p>
          ))}
          <p className="sub">Total <strong style={{ color: 'rgb(var(--ink))' }}>{number(grandTotal)}</strong> · {number(filtered.length)} line(s)</p>
        </div>
      )}

      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Entry</th><th>Recorded at</th><th>Product</th><th className="num">Quantity</th>
              <th>Recorded by</th><th>Note</th><th className="no-print" />
            </tr>
          </thead>
          <tbody>
            {filtered.map((l, i) => (
              <tr key={`${l.entryId}-${l.itemId}-${i}`}>
                <td className="mono" style={{ fontSize: 12, color: 'rgb(var(--aqua-700))' }}>{l.entryId}</td>
                <td className="sub">{l.recordedAt}</td>
                <td>{l.itemName}</td>
                <td className="num tnum">{number(l.quantity)}</td>
                <td>{l.recordedBy}</td>
                <td className="sub">{l.note}</td>
                <td className="no-print">
                  <ReverseButton
                    entityType="production_log_entries" entityId={l.entryId} entityLabel={l.entryId}
                    reversed={l.reversed}
                    onReversed={() => { onChanged(); ui.toast(`${l.entryId} reversed`); }}
                  />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {filtered.length === 0 && (
        <EmptyState
          title={lines.length === 0 ? 'No production logged yet' : 'Nothing matches these filters'}
          description={lines.length === 0
            ? (products.length === 0
              ? 'Add your products first with “New product”, then record what the floor produces.'
              : 'Record what the floor produces — each entry is timestamped and posted to the Finished Goods Warehouse.')
            : 'Widen the date range or clear the product filter.'}
          onClear={clearFilters}
        />
      )}

      {recordOpen && (
        <RecordProductionModal
          products={products}
          onClose={() => setRecordOpen(false)}
          onRecorded={() => { setRecordOpen(false); onChanged(); ui.toast('Production recorded'); }}
        />
      )}
      {newProductOpen && (
        <NewProductModal
          onClose={() => setNewProductOpen(false)}
          onCreated={name => { setNewProductOpen(false); onChanged(); ui.toast(`${name} added`); }}
        />
      )}
    </Card>
  );
}

/** Creates a finished-good product (sachet / bottle size / dispenser) so it can
 *  be produced, logged and sold. Posts to the same /masters/items endpoint the
 *  rest of the app reads its product catalogue from. */
function NewProductModal({ onClose, onCreated }: { onClose: () => void; onCreated: (name: string) => void }) {
  const [name, setName] = useState('');
  const [uom, setUom] = useState('case');
  const [unitCost, setUnitCost] = useState('0');
  const [reorderPoint, setReorderPoint] = useState('0');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!name.trim()) { setError('Give the product a name.'); return; }
    setSaving(true); setError(null);
    try {
      await apiPost('/masters/items', {
        name: name.trim(), category: 'Finished goods', type: 'FINISHED_GOOD',
        uom: uom.trim() || 'unit', unitCost: Number(unitCost) || 0, reorderPoint: Number(reorderPoint) || 0,
      });
      onCreated(name.trim());
    } catch (err) { setError(err instanceof Error ? err.message : 'Something went wrong'); }
    finally { setSaving(false); }
  }

  return (
    <Modal title="New product" onClose={onClose} onSubmit={submit} submitLabel="Add product" saving={saving} error={error}>
      <div className="form-row">
        <label htmlFor="np-name">Name</label>
        <input id="np-name" value={name} onChange={e => setName(e.target.value)} placeholder="e.g. 50cl PET, Sachet (bags), 20L Dispenser" required autoFocus />
      </div>
      <div className="form-grid">
        <div className="form-row"><label htmlFor="np-uom">Unit</label><input id="np-uom" value={uom} onChange={e => setUom(e.target.value)} placeholder="case, bag, bottle" required /></div>
        <div className="form-row"><label htmlFor="np-cost">Unit price</label><NumberInput id="np-cost" value={unitCost} onChange={setUnitCost} required /></div>
        <div className="form-row"><label htmlFor="np-reorder">Reorder point</label><NumberInput id="np-reorder" allowDecimal={false} value={reorderPoint} onChange={setReorderPoint} /></div>
      </div>
      <p className="sub">Becomes available everywhere a product is picked — production log, batches and sales.</p>
    </Modal>
  );
}

function RecordProductionModal({ products, onClose, onRecorded }: {
  products: Item[];
  onClose: () => void;
  onRecorded: () => void;
}) {
  const { user } = useCurrentUser();
  const [recordedBy, setRecordedBy] = useState(user?.name ?? '');
  const [note, setNote] = useState('');
  const [lines, setLines] = useState<{ itemId: string; quantity: string }[]>([
    { itemId: products[0]?.id ?? '', quantity: '' },
  ]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function updateLine(i: number, patch: Partial<{ itemId: string; quantity: string }>) {
    setLines(ls => ls.map((l, idx) => (idx === i ? { ...l, ...patch } : l)));
  }
  function addLine() { setLines(ls => [...ls, { itemId: products[0]?.id ?? '', quantity: '' }]); }
  function removeLine(i: number) { setLines(ls => ls.filter((_, idx) => idx !== i)); }

  async function submit(e: FormEvent) {
    e.preventDefault();
    const items = lines
      .filter(l => l.itemId && Number(l.quantity) > 0)
      .map(l => ({ itemId: l.itemId, quantity: Number(l.quantity) }));
    if (items.length === 0) { setError('Add at least one product with a quantity greater than zero.'); return; }
    setSaving(true); setError(null);
    try {
      await apiPost('/production-log', { recordedBy, note: note.trim() || undefined, items });
      onRecorded();
    } catch (err) { setError(err instanceof Error ? err.message : 'Something went wrong'); }
    finally { setSaving(false); }
  }

  return (
    <Modal title="Record production" onClose={onClose} onSubmit={submit} submitLabel="Record" saving={saving} error={error}>
      <p className="sub" style={{ marginBottom: 14 }}>Timestamped automatically. Every line is added to the Finished Goods Warehouse straight away.</p>
      <div className="form-row"><label htmlFor="pl-by">Recorded by</label><input id="pl-by" value={recordedBy} onChange={e => setRecordedBy(e.target.value)} required autoFocus /></div>

      <div className="form-row">
        <label>Products produced</label>
        {lines.map((l, i) => (
          <div className="lineitem-row" key={i}>
            <div style={{ flex: 2 }}>
              <select aria-label="Product type" value={l.itemId} onChange={e => updateLine(i, { itemId: e.target.value })}>
                {products.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select>
            </div>
            <div style={{ width: 120 }}>
              <NumberInput ariaLabel="Quantity" allowDecimal={false} value={l.quantity} onChange={v => updateLine(i, { quantity: v })} required />
            </div>
            <button type="button" className="iconbtn" onClick={() => removeLine(i)} aria-label="Remove product" disabled={lines.length <= 1}>
              <Icon name="x" size={16} />
            </button>
          </div>
        ))}
        <button type="button" className="btn btn-secondary btn-sm" onClick={addLine} style={{ marginTop: 4 }}>
          <Icon name="plus" size={12} /> Add product
        </button>
      </div>

      <div className="form-row"><label htmlFor="pl-note">Note (optional)</label><textarea id="pl-note" value={note} onChange={e => setNote(e.target.value)} rows={2} /></div>
    </Modal>
  );
}
