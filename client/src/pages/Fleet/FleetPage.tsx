import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import { api, apiPost } from '../../lib/apiClient';
import { naira, number } from '../../lib/format';
import { useUi } from '../../lib/uiState';
import { useCurrentUser } from '../../lib/currentUser';
import { Card } from '../../components/ui/Card';
import { KpiRow } from '../../components/ui/KpiCard';
import { Pill } from '../../components/ui/Pill';
import { Tabs } from '../../components/ui/Tabs';
import { Modal } from '../../components/ui/Modal';
import { NumberInput } from '../../components/ui/NumberInput';
import { EmptyState } from '../../components/ui/EmptyState';
import { Icon } from '../../components/ui/Icon';
import { PrintHeader } from '../../components/ui/PrintHeader';
import { DeleteButton } from '../../components/ui/DeleteButton';
import { usePendingDeletions } from '../../lib/pendingDeletions';

interface DeliveryRun {
  id: string; sales_id: string; vehicle_id: string; customer_name: string; customer_location: string;
  driver: string | null; route: string | null; status: string; dispatched_at: string;
  delivered_by: string | null; delivered_at: string | null;
  products: string | null; total_quantity: number | null;
}
interface PendingSale { id: string; customer_name: string; customer_location: string; total_amount: number }
interface Vehicle {
  id: string; driver: string | null; status: string; odometer: string | null;
  plate_number: string | null; vehicle_type: string | null; category: 'COMMERCIAL' | 'PRIVATE' | null; acquisition_date: string | null;
}
interface VehicleDocument {
  id: string; vehicle_id: string; document_type: string; document_number: string | null;
  issue_date: string | null; expiry_date: string | null; notes: string | null;
}
interface ExpiryAlert extends VehicleDocument { vehicle_plate_number: string | null; days_until_expiry: number; expired: boolean }
interface FuelRecord {
  id: string; vehicle_id: string; driver: string | null; department: string | null; fuel_date: string; fuel_type: string | null;
  quantity: number; unit_cost: number; total_cost: number; odometer: number | null; vendor: string | null;
}
interface DriverPerformanceRow {
  driver: string; trips: number; deliveries: number; successful_deliveries: number; returns: number; cancelled_trips: number;
  distance_km: number | null; fuel_cost: number; maintenance_cost: number; performance: number;
}

export default function FleetPage() {
  const [vehicles, setVehicles] = useState<Vehicle[]>([]);
  const [expiring, setExpiring] = useState<ExpiryAlert[]>([]);
  const [reloadKey, setReloadKey] = useState(0);
  const refresh = useCallback(() => setReloadKey(k => k + 1), []);

  useEffect(() => { api<Vehicle[]>('/masters/vehicles').then(setVehicles); }, [reloadKey]);
  useEffect(() => { api<ExpiryAlert[]>('/vehicle-documents/expiring', { windowDays: '3650' }).then(setExpiring); }, [reloadKey]);

  const kpis = [
    { key: 'vehicles', label: 'Registered vehicles', icon: 'truck' as const, value: number(vehicles.length) },
    { key: 'expired', label: 'Documents expired', icon: 'clock' as const, value: number(expiring.filter(e => e.expired).length) },
    { key: 'expiring', label: 'Documents expiring soon', icon: 'clock' as const, value: number(expiring.filter(e => !e.expired).length) },
  ];

  return (
    <>
      <PrintHeader />
      <div className="pagehead">
        <div><h1>Fleet &amp; delivery</h1><p className="pagesub">Vehicles, delivery runs, fuel tracking and vehicle documentation.</p></div>
      </div>

      <KpiRow kpis={kpis} />

      <Tabs tabs={[
        { key: 'deliveries', label: 'Deliveries', content: <DeliveriesTab vehicles={vehicles} /> },
        { key: 'vehicles', label: 'Vehicles', content: <VehiclesTab vehicles={vehicles} refresh={refresh} /> },
        { key: 'fuel', label: 'Fuel tracking', content: <FuelTab vehicles={vehicles} /> },
        { key: 'driver-performance', label: 'Driver performance', content: <DriverPerformanceTab /> },
      ]} />
    </>
  );
}

const CAN_MARK_DELIVERED_ROLES = ['Sales manager'];

function DeliveriesTab({ vehicles }: { vehicles: Vehicle[] }) {
  const ui = useUi();
  const { user, isSuperAdmin } = useCurrentUser();
  const [runs, setRuns] = useState<DeliveryRun[]>([]);
  const [pending, setPending] = useState<PendingSale[]>([]);
  const [reloadKey, setReloadKey] = useState(0);
  const [dispatchOpen, setDispatchOpen] = useState(false);
  const [deliverTarget, setDeliverTarget] = useState<DeliveryRun | null>(null);

  const refresh = useCallback(() => setReloadKey(k => k + 1), []);
  const pendingDeletions = usePendingDeletions('delivery_runs', reloadKey);
  const canMarkDelivered = isSuperAdmin || (user && CAN_MARK_DELIVERED_ROLES.includes(user.role));

  useEffect(() => {
    api<DeliveryRun[]>('/deliveries').then(setRuns);
    api<PendingSale[]>('/deliveries/pending-dispatch').then(setPending);
  }, [reloadKey]);

  async function startTransit(id: string) {
    await apiPost(`/deliveries/${encodeURIComponent(id)}/start-transit`, { actor: user?.name });
    ui.toast(`${id} now in transit`);
    refresh();
  }

  async function cancel(run: DeliveryRun) {
    const reason = window.prompt(`Reason for cancelling ${run.id}?`);
    if (!reason) return;
    try {
      await apiPost(`/deliveries/${encodeURIComponent(run.id)}/cancel`, { reason, actor: user?.name ?? 'Someone' });
      ui.toast(`${run.id} cancelled`);
      refresh();
    } catch (err) { ui.toast(err instanceof Error ? err.message : 'Something went wrong'); }
  }

  async function markReturned(run: DeliveryRun) {
    const reason = window.prompt(`Reason ${run.id} is being returned?`);
    if (!reason) return;
    try {
      await apiPost(`/deliveries/${encodeURIComponent(run.id)}/return`, { reason, actor: user?.name ?? 'Someone' });
      ui.toast(`${run.id} marked returned`);
      refresh();
    } catch (err) { ui.toast(err instanceof Error ? err.message : 'Something went wrong'); }
  }

  return (
    <div style={{ display: 'grid', gap: 20 }}>
      <div className="pagehead" style={{ padding: 0 }}>
        <div />
        <div className="no-print">
          <button className="btn btn-primary" onClick={() => setDispatchOpen(true)} disabled={pending.length === 0}>
            <Icon name="plus" size={14} /> Dispatch delivery
          </button>
        </div>
      </div>

      <Card title="Delivery runs" description="Every dispatch, most recent first. Marking Delivered requires a Sales manager (or System admin).">
        <div className="table-wrap">
          <table>
            <thead><tr><th>Waybill</th><th>Customer</th><th>Sales order</th><th>Products</th><th>Driver</th><th>Dispatched</th><th>Delivered by</th><th>Status</th><th className="no-print">Action</th><th className="no-print" /></tr></thead>
            <tbody>
              {runs.map(r => (
                <tr key={r.id}>
                  <td className="mono" style={{ fontSize: 12, color: 'rgb(var(--aqua-700))' }}>{r.id}</td>
                  <td><p style={{ fontWeight: 500 }}>{r.customer_name}</p><p className="sub">{r.route ?? r.customer_location}</p></td>
                  <td className="mono" style={{ fontSize: 12 }}>{r.sales_id}</td>
                  <td className="sub">{r.products ?? '—'}{r.total_quantity != null && <span> · {r.total_quantity} units</span>}</td>
                  <td>{r.driver}</td>
                  <td className="sub">{r.dispatched_at}</td>
                  <td className="sub">{r.delivered_by ?? '—'}</td>
                  <td><Pill status={r.status} /></td>
                  <td className="no-print">
                    <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                      {r.status === 'DISPATCHED' && <button className="btn btn-secondary btn-sm" onClick={() => startTransit(r.id)}>Start transit</button>}
                      {(r.status === 'DISPATCHED' || r.status === 'ACTIVE') && (
                        <button className="btn btn-secondary btn-sm" onClick={() => setDeliverTarget(r)} disabled={!canMarkDelivered} title={canMarkDelivered ? undefined : 'Only a Sales manager or System admin can mark delivered'}>
                          Mark delivered
                        </button>
                      )}
                      {(r.status === 'DISPATCHED' || r.status === 'ACTIVE') && <button className="btn btn-secondary btn-sm" onClick={() => cancel(r)}>Cancel</button>}
                      {(r.status === 'DISPATCHED' || r.status === 'ACTIVE') && <button className="btn btn-secondary btn-sm" onClick={() => markReturned(r)}>Returned</button>}
                    </div>
                  </td>
                  <td className="no-print">
                    <DeleteButton entityType="delivery_runs" entityId={r.id} entityLabel={r.id} pending={pendingDeletions.has(r.id)} onRequested={() => { refresh(); ui.toast('Deletion requested — pending admin approval'); }} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {runs.length === 0 && <EmptyState title="No deliveries dispatched yet" description="Dispatch a confirmed sales order to a vehicle." onClear={() => {}} />}
      </Card>

      {dispatchOpen && (
        <DispatchDelivery
          pending={pending} vehicles={vehicles}
          onClose={() => setDispatchOpen(false)}
          onDispatched={() => { setDispatchOpen(false); refresh(); ui.toast('Delivery dispatched'); }}
        />
      )}
      {deliverTarget && (
        <MarkDelivered
          run={deliverTarget} onClose={() => setDeliverTarget(null)}
          onDelivered={() => { setDeliverTarget(null); refresh(); ui.toast(`${deliverTarget.id} marked delivered`); }}
        />
      )}
    </div>
  );
}

function MarkDelivered({ run, onClose, onDelivered }: { run: DeliveryRun; onClose: () => void; onDelivered: () => void }) {
  const { user } = useCurrentUser();
  const [deliveredBy, setDeliveredBy] = useState(run.driver ?? '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setSaving(true); setError(null);
    try {
      await apiPost(`/deliveries/${encodeURIComponent(run.id)}/delivered`, { authorizedByUserId: user?.id, deliveredBy });
      onDelivered();
    } catch (err) { setError(err instanceof Error ? err.message : 'Something went wrong'); }
    finally { setSaving(false); }
  }

  return (
    <Modal title={`Mark ${run.id} delivered`} onClose={onClose} onSubmit={submit} submitLabel="Mark delivered" saving={saving} error={error}>
      <p className="sub">Delivered At is recorded automatically by the server. Delivered By and who authorized this are both logged to the audit trail.</p>
      <div className="form-row"><label htmlFor="dv-by">Delivered by</label><input id="dv-by" value={deliveredBy} onChange={e => setDeliveredBy(e.target.value)} required autoFocus /></div>
    </Modal>
  );
}

function DispatchDelivery({ pending, vehicles, onClose, onDispatched }: {
  pending: PendingSale[]; vehicles: Vehicle[]; onClose: () => void; onDispatched: () => void;
}) {
  const [salesId, setSalesId] = useState(pending[0]?.id ?? '');
  const [vehicleId, setVehicleId] = useState(vehicles[0]?.id ?? '');
  const [driver, setDriver] = useState(vehicles[0]?.driver ?? '');
  const [route, setRoute] = useState(pending[0]?.customer_location ?? '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setSaving(true); setError(null);
    try {
      await apiPost('/deliveries', { salesId, vehicleId, driver, route });
      onDispatched();
    } catch (err) { setError(err instanceof Error ? err.message : 'Something went wrong'); }
    finally { setSaving(false); }
  }

  return (
    <Modal title="Dispatch delivery" onClose={onClose} onSubmit={submit} submitLabel="Dispatch" saving={saving} error={error}>
      <div className="form-row">
        <label htmlFor="dr-sales">Sales order</label>
        <select id="dr-sales" value={salesId} onChange={e => {
          setSalesId(e.target.value);
          const s = pending.find(p => p.id === e.target.value);
          if (s) setRoute(s.customer_location);
        }}>
          {pending.map(p => <option key={p.id} value={p.id}>{p.id} — {p.customer_name}</option>)}
        </select>
      </div>
      <div className="form-grid">
        <div className="form-row">
          <label htmlFor="dr-vehicle">Vehicle</label>
          <select id="dr-vehicle" value={vehicleId} onChange={e => {
            setVehicleId(e.target.value);
            const v = vehicles.find(x => x.id === e.target.value);
            if (v?.driver) setDriver(v.driver);
          }}>
            {vehicles.map(v => <option key={v.id} value={v.id}>{v.id}</option>)}
          </select>
        </div>
        <div className="form-row"><label htmlFor="dr-driver">Driver</label><input id="dr-driver" value={driver} onChange={e => setDriver(e.target.value)} required /></div>
      </div>
      <div className="form-row"><label htmlFor="dr-route">Route</label><input id="dr-route" value={route} onChange={e => setRoute(e.target.value)} required /></div>
    </Modal>
  );
}

function VehiclesTab({ vehicles, refresh }: { vehicles: Vehicle[]; refresh: () => void }) {
  const ui = useUi();
  const { user } = useCurrentUser();
  const [open, setOpen] = useState(false);
  const [detailFor, setDetailFor] = useState<Vehicle | null>(null);

  return (
    <div style={{ display: 'grid', gap: 20 }}>
      <Card title="Company vehicles" description="Commercial and private vehicles, with documentation and maintenance per vehicle." action={
        <button className="btn btn-primary no-print" onClick={() => setOpen(true)}><Icon name="plus" size={14} /> Register vehicle</button>
      }>
        <div className="table-wrap">
          <table>
            <thead><tr><th>Vehicle</th><th>Plate</th><th>Type</th><th>Category</th><th>Driver</th><th>Status</th><th className="no-print" /></tr></thead>
            <tbody>
              {vehicles.map(v => (
                <tr key={v.id}>
                  <td className="mono" style={{ fontSize: 12, color: 'rgb(var(--aqua-700))' }}>{v.id}</td>
                  <td className="sub">{v.plate_number ?? '—'}</td>
                  <td className="sub">{v.vehicle_type ?? '—'}</td>
                  <td>{v.category ? <Pill status={v.category} /> : '—'}</td>
                  <td>{v.driver}</td>
                  <td><Pill status={v.status} /></td>
                  <td className="no-print"><button className="btn btn-secondary btn-sm" onClick={() => setDetailFor(v)}>Documents</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {vehicles.length === 0 && <EmptyState title="No vehicles registered" description="Register a company vehicle." onClear={() => {}} />}
      </Card>

      {open && <RegisterVehicle onClose={() => setOpen(false)} onSaved={() => { setOpen(false); refresh(); ui.toast('Vehicle registered'); }} />}
      {detailFor && <VehicleDocumentsPanel vehicle={detailFor} onClose={() => setDetailFor(null)} actor={user?.name ?? 'System Administrator'} />}
    </div>
  );
}

function RegisterVehicle({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const [driver, setDriver] = useState('');
  const [plateNumber, setPlateNumber] = useState('');
  const [vehicleType, setVehicleType] = useState('');
  const [category, setCategory] = useState<'COMMERCIAL' | 'PRIVATE'>('COMMERCIAL');
  const [acquisitionDate, setAcquisitionDate] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setSaving(true); setError(null);
    try {
      await apiPost('/masters/vehicles', { driver: driver || null, plateNumber: plateNumber || undefined, vehicleType: vehicleType || undefined, category, acquisitionDate: acquisitionDate || undefined });
      onSaved();
    } catch (err) { setError(err instanceof Error ? err.message : 'Something went wrong'); }
    finally { setSaving(false); }
  }

  return (
    <Modal title="Register vehicle" onClose={onClose} onSubmit={submit} submitLabel="Register" saving={saving} error={error}>
      <div className="form-grid">
        <div className="form-row"><label htmlFor="vh-plate">Plate number</label><input id="vh-plate" value={plateNumber} onChange={e => setPlateNumber(e.target.value)} required autoFocus /></div>
        <div className="form-row"><label htmlFor="vh-type">Vehicle type</label><input id="vh-type" value={vehicleType} onChange={e => setVehicleType(e.target.value)} placeholder="e.g. Truck, Sedan" /></div>
      </div>
      <div className="form-grid">
        <div className="form-row">
          <label htmlFor="vh-category">Category</label>
          <select id="vh-category" value={category} onChange={e => setCategory(e.target.value as 'COMMERCIAL' | 'PRIVATE')}>
            <option value="COMMERCIAL">Commercial</option>
            <option value="PRIVATE">Private</option>
          </select>
        </div>
        <div className="form-row"><label htmlFor="vh-acquired">Acquisition date</label><input id="vh-acquired" type="date" value={acquisitionDate} onChange={e => setAcquisitionDate(e.target.value)} /></div>
      </div>
      <div className="form-row"><label htmlFor="vh-driver">Driver</label><input id="vh-driver" value={driver} onChange={e => setDriver(e.target.value)} /></div>
    </Modal>
  );
}

function VehicleDocumentsPanel({ vehicle, onClose, actor }: { vehicle: Vehicle; onClose: () => void; actor: string }) {
  const ui = useUi();
  const [documents, setDocuments] = useState<VehicleDocument[]>([]);
  const [documentTypes, setDocumentTypes] = useState<string[]>([]);
  const [reloadKey, setReloadKey] = useState(0);
  const [addOpen, setAddOpen] = useState(false);

  useEffect(() => { api<VehicleDocument[]>('/vehicle-documents', { vehicleId: vehicle.id }).then(setDocuments); }, [reloadKey, vehicle.id]);
  useEffect(() => {
    if (!vehicle.category) { setDocumentTypes([]); return; }
    api<string[]>('/vehicle-documents/document-types', { category: vehicle.category }).then(setDocumentTypes);
  }, [vehicle.category]);

  return (
    <div className="overlay" onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="dialog" role="dialog" aria-modal="true" aria-label="Vehicle documents" style={{ maxWidth: 640 }}>
        <div className="dialog-head">
          <h2 className="card-title">{vehicle.id} — {vehicle.plate_number ?? 'Documentation'}</h2>
          <button className="iconbtn" onClick={onClose} aria-label="Close" style={{ width: 28, height: 28 }}><Icon name="x" size={16} /></button>
        </div>
        <div style={{ padding: 20, maxHeight: '65vh', overflowY: 'auto' }}>
          {!vehicle.category && <p className="sub">Set a category (Commercial/Private) on this vehicle to track its required documents.</p>}
          {vehicle.category && (
            <>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
                <p className="sub">Required for {vehicle.category === 'COMMERCIAL' ? 'commercial' : 'private'} vehicles: {documentTypes.join(', ')}</p>
                <button className="btn btn-secondary btn-sm no-print" onClick={() => setAddOpen(true)}><Icon name="plus" size={12} /> Add document</button>
              </div>
              <div className="table-wrap">
                <table>
                  <thead><tr><th>Type</th><th>Number</th><th>Issued</th><th>Expiry</th></tr></thead>
                  <tbody>
                    {documents.map(d => {
                      const expired = d.expiry_date ? new Date(d.expiry_date).getTime() < Date.now() : false;
                      return (
                        <tr key={d.id}>
                          <td>{d.document_type}</td>
                          <td className="sub">{d.document_number}</td>
                          <td className="sub">{d.issue_date}</td>
                          <td>{d.expiry_date ? <Pill status={expired ? 'EXPIRED' : 'ACTIVE'} /> : '—'} <span className="sub">{d.expiry_date}</span></td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              {documents.length === 0 && <EmptyState title="No documents recorded" description="Add a document for this vehicle." onClear={() => {}} />}
            </>
          )}
        </div>
      </div>
      {addOpen && vehicle.category && (
        <AddVehicleDocument
          vehicleId={vehicle.id} documentTypes={documentTypes} actor={actor}
          onClose={() => setAddOpen(false)}
          onSaved={() => { setAddOpen(false); setReloadKey(k => k + 1); ui.toast('Document added'); }}
        />
      )}
    </div>
  );
}

function AddVehicleDocument({ vehicleId, documentTypes, actor, onClose, onSaved }: {
  vehicleId: string; documentTypes: string[]; actor: string; onClose: () => void; onSaved: () => void;
}) {
  const [documentType, setDocumentType] = useState(documentTypes[0] ?? '');
  const [documentNumber, setDocumentNumber] = useState('');
  const [issueDate, setIssueDate] = useState('');
  const [expiryDate, setExpiryDate] = useState('');
  const [notes, setNotes] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setSaving(true); setError(null);
    try {
      await apiPost('/vehicle-documents', { vehicleId, documentType, documentNumber: documentNumber || undefined, issueDate: issueDate || undefined, expiryDate: expiryDate || undefined, notes: notes || undefined, actor });
      onSaved();
    } catch (err) { setError(err instanceof Error ? err.message : 'Something went wrong'); }
    finally { setSaving(false); }
  }

  return (
    <Modal title="Add vehicle document" onClose={onClose} onSubmit={submit} submitLabel="Add" saving={saving} error={error}>
      <div className="form-row">
        <label htmlFor="vd-type">Document type</label>
        <select id="vd-type" value={documentType} onChange={e => setDocumentType(e.target.value)}>
          {documentTypes.map(t => <option key={t} value={t}>{t}</option>)}
        </select>
      </div>
      <div className="form-grid">
        <div className="form-row"><label htmlFor="vd-number">Document number</label><input id="vd-number" value={documentNumber} onChange={e => setDocumentNumber(e.target.value)} /></div>
        <div className="form-row"><label htmlFor="vd-issue">Issue date</label><input id="vd-issue" type="date" value={issueDate} onChange={e => setIssueDate(e.target.value)} /></div>
      </div>
      <div className="form-row"><label htmlFor="vd-expiry">Expiry date</label><input id="vd-expiry" type="date" value={expiryDate} onChange={e => setExpiryDate(e.target.value)} /></div>
      <div className="form-row"><label htmlFor="vd-notes">Notes</label><input id="vd-notes" value={notes} onChange={e => setNotes(e.target.value)} /></div>
    </Modal>
  );
}

function FuelTab({ vehicles }: { vehicles: Vehicle[] }) {
  const ui = useUi();
  const { user } = useCurrentUser();
  const [records, setRecords] = useState<FuelRecord[]>([]);
  const [reloadKey, setReloadKey] = useState(0);
  const [open, setOpen] = useState(false);

  useEffect(() => { api<FuelRecord[]>('/fuel-records').then(setRecords); }, [reloadKey]);

  const totalCost = useMemo(() => records.reduce((s, r) => s + r.total_cost, 0), [records]);

  return (
    <div style={{ display: 'grid', gap: 20 }}>
      <Card title="Fuel tracking" description={`Total fuel spend: ${naira(totalCost)}`} action={
        <button className="btn btn-primary no-print" onClick={() => setOpen(true)} disabled={vehicles.length === 0}><Icon name="plus" size={14} /> Record fuel</button>
      }>
        <div className="table-wrap">
          <table>
            <thead><tr><th>Record</th><th>Vehicle</th><th>Driver</th><th>Date</th><th>Type</th><th className="num">Qty</th><th className="num">Unit cost</th><th className="num">Total</th></tr></thead>
            <tbody>
              {records.map(r => (
                <tr key={r.id}>
                  <td className="mono" style={{ fontSize: 12 }}>{r.id}</td>
                  <td className="sub">{r.vehicle_id}</td>
                  <td className="sub">{r.driver}</td>
                  <td className="sub">{r.fuel_date}</td>
                  <td className="sub">{r.fuel_type}</td>
                  <td className="num tnum">{number(r.quantity)}</td>
                  <td className="num tnum">{naira(r.unit_cost)}</td>
                  <td className="num tnum">{naira(r.total_cost)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {records.length === 0 && <EmptyState title="No fuel records" description="Record fuel purchased for a vehicle." onClear={() => {}} />}
      </Card>

      {open && <RecordFuel vehicles={vehicles} actor={user?.name ?? 'System Administrator'} onClose={() => setOpen(false)} onSaved={() => { setOpen(false); setReloadKey(k => k + 1); ui.toast('Fuel recorded'); }} />}
    </div>
  );
}

function RecordFuel({ vehicles, actor, onClose, onSaved }: { vehicles: Vehicle[]; actor: string; onClose: () => void; onSaved: () => void }) {
  const [vehicleId, setVehicleId] = useState(vehicles[0]?.id ?? '');
  const [driver, setDriver] = useState('');
  const [department, setDepartment] = useState('');
  const [fuelType, setFuelType] = useState('Diesel');
  const [quantity, setQuantity] = useState('');
  const [unitCost, setUnitCost] = useState('');
  const [odometer, setOdometer] = useState('');
  const [vendor, setVendor] = useState('');
  const [receiptReference, setReceiptReference] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const total = (Number(quantity) || 0) * (Number(unitCost) || 0);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setSaving(true); setError(null);
    try {
      await apiPost('/fuel-records', {
        vehicleId, driver: driver || undefined, department: department || undefined, fuelType: fuelType || undefined,
        quantity: Number(quantity), unitCost: Number(unitCost), odometer: odometer ? Number(odometer) : undefined,
        vendor: vendor || undefined, receiptReference: receiptReference || undefined, actor,
      });
      onSaved();
    } catch (err) { setError(err instanceof Error ? err.message : 'Something went wrong'); }
    finally { setSaving(false); }
  }

  return (
    <Modal title="Record fuel" onClose={onClose} onSubmit={submit} submitLabel="Record" saving={saving} error={error}>
      <div className="form-grid">
        <div className="form-row">
          <label htmlFor="fl-vehicle">Vehicle</label>
          <select id="fl-vehicle" value={vehicleId} onChange={e => setVehicleId(e.target.value)}>
            {vehicles.map(v => <option key={v.id} value={v.id}>{v.id} — {v.plate_number ?? v.driver}</option>)}
          </select>
        </div>
        <div className="form-row"><label htmlFor="fl-driver">Driver</label><input id="fl-driver" value={driver} onChange={e => setDriver(e.target.value)} /></div>
      </div>
      <div className="form-grid">
        <div className="form-row"><label htmlFor="fl-dept">Department</label><input id="fl-dept" value={department} onChange={e => setDepartment(e.target.value)} /></div>
        <div className="form-row"><label htmlFor="fl-type">Fuel type</label><input id="fl-type" value={fuelType} onChange={e => setFuelType(e.target.value)} /></div>
      </div>
      <div className="form-grid">
        <div className="form-row"><label htmlFor="fl-qty">Quantity (litres)</label><NumberInput id="fl-qty" value={quantity} onChange={setQuantity} required ariaLabel="Quantity" /></div>
        <div className="form-row"><label htmlFor="fl-unit">Unit cost</label><NumberInput id="fl-unit" value={unitCost} onChange={setUnitCost} required ariaLabel="Unit cost" /></div>
      </div>
      <p className="sub">Total cost: {naira(total)}</p>
      <div className="form-grid">
        <div className="form-row"><label htmlFor="fl-odo">Odometer</label><NumberInput id="fl-odo" value={odometer} onChange={setOdometer} allowDecimal={false} ariaLabel="Odometer" /></div>
        <div className="form-row"><label htmlFor="fl-vendor">Vendor</label><input id="fl-vendor" value={vendor} onChange={e => setVendor(e.target.value)} /></div>
      </div>
      <div className="form-row"><label htmlFor="fl-receipt">Receipt reference</label><input id="fl-receipt" value={receiptReference} onChange={e => setReceiptReference(e.target.value)} /></div>
    </Modal>
  );
}

function DriverPerformanceTab() {
  const [period, setPeriod] = useState('');
  const [rows, setRows] = useState<DriverPerformanceRow[]>([]);

  useEffect(() => { api<DriverPerformanceRow[]>('/driver-performance', { period: period || undefined }).then(setRows); }, [period]);

  return (
    <div style={{ display: 'grid', gap: 20 }}>
      <Card
        title="Driver performance"
        description="Deliveries counts every run that reached the customer (Delivered or Returned); Successful Deliveries narrows that to Delivered. Maintenance Cost is spend on whichever vehicle(s) the driver drove in this window."
        action={
          <div className="no-print" style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <label htmlFor="dp-month" className="sub">Month</label>
            <input id="dp-month" type="month" value={period} onChange={e => setPeriod(e.target.value)} />
            {period && <button className="btn btn-secondary btn-sm" onClick={() => setPeriod('')}>All time</button>}
          </div>
        }
      >
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Driver</th><th className="num">Trips</th><th className="num">Deliveries</th><th className="num">Successful</th>
                <th className="num">Returns</th><th className="num">Cancelled</th><th className="num">Distance</th>
                <th className="num">Fuel cost</th><th className="num">Maintenance cost</th><th className="num">Performance</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(r => (
                <tr key={r.driver}>
                  <td style={{ fontWeight: 500 }}>{r.driver}</td>
                  <td className="num tnum">{number(r.trips)}</td>
                  <td className="num tnum">{number(r.deliveries)}</td>
                  <td className="num tnum">{number(r.successful_deliveries)}</td>
                  <td className="num tnum">{number(r.returns)}</td>
                  <td className="num tnum">{number(r.cancelled_trips)}</td>
                  <td className="num tnum">{r.distance_km != null ? `${number(r.distance_km)} km` : '—'}</td>
                  <td className="num tnum">{naira(r.fuel_cost)}</td>
                  <td className="num tnum">{naira(r.maintenance_cost)}</td>
                  <td className="num tnum" style={{ fontWeight: 600 }}>{r.performance}%</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {rows.length === 0 && <EmptyState title="No trips in this window" description="Dispatch a delivery to see driver performance here." onClear={() => setPeriod('')} />}
      </Card>
    </div>
  );
}
