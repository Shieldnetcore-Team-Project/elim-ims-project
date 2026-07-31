import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import { api, apiPost } from '../../lib/apiClient';
import { number } from '../../lib/format';
import { useUi } from '../../lib/uiState';
import { Card } from '../../components/ui/Card';
import { KpiRow } from '../../components/ui/KpiCard';
import { Pill } from '../../components/ui/Pill';
import { Modal } from '../../components/ui/Modal';
import { EmptyState } from '../../components/ui/EmptyState';
import { Icon } from '../../components/ui/Icon';
import { PrintHeader } from '../../components/ui/PrintHeader';
import { DeleteButton } from '../../components/ui/DeleteButton';
import { usePendingDeletions } from '../../lib/pendingDeletions';

interface DeliveryRun {
  id: string; sales_id: string; vehicle_id: string; customer_name: string; customer_location: string;
  driver: string | null; route: string | null; status: string; dispatched_at: string; delivered_at: string | null;
}
interface PendingSale { id: string; customer_name: string; customer_location: string; total_amount: number }
interface Vehicle { id: string; driver: string | null; status: string }

export default function FleetPage() {
  const ui = useUi();
  const [runs, setRuns] = useState<DeliveryRun[]>([]);
  const [pending, setPending] = useState<PendingSale[]>([]);
  const [vehicles, setVehicles] = useState<Vehicle[]>([]);
  const [reloadKey, setReloadKey] = useState(0);
  const [dispatchOpen, setDispatchOpen] = useState(false);

  const refresh = useCallback(() => setReloadKey(k => k + 1), []);
  const pendingDeletions = usePendingDeletions('delivery_runs', reloadKey);

  useEffect(() => {
    api<DeliveryRun[]>('/deliveries').then(setRuns);
    api<PendingSale[]>('/deliveries/pending-dispatch').then(setPending);
  }, [reloadKey]);
  useEffect(() => { api<Vehicle[]>('/masters/vehicles').then(setVehicles); }, []);

  async function markDelivered(id: string) {
    await apiPost(`/deliveries/${encodeURIComponent(id)}/delivered`, {});
    ui.toast(`${id} marked delivered`);
    refresh();
  }

  const kpis = useMemo(() => [
    { key: 'total', label: 'Delivery runs', icon: 'truck' as const, value: number(runs.length) },
    { key: 'active', label: 'On the road', icon: 'truck' as const, value: number(runs.filter(r => r.status === 'ACTIVE').length) },
    { key: 'delivered', label: 'Delivered', icon: 'box' as const, value: number(runs.filter(r => r.status === 'DELIVERED').length) },
    { key: 'pending', label: 'Awaiting dispatch', icon: 'clock' as const, value: number(pending.length) },
  ], [runs, pending]);

  return (
    <>
      <PrintHeader />
      <div className="pagehead">
        <div><h1>Fleet &amp; delivery</h1><p className="pagesub">Vehicles and delivery runs against confirmed sales orders.</p></div>
        <div className="no-print">
          <button className="btn btn-primary" onClick={() => setDispatchOpen(true)} disabled={pending.length === 0}>
            <Icon name="plus" size={14} /> Dispatch delivery
          </button>
        </div>
      </div>

      <KpiRow kpis={kpis} />

      <Card title="Delivery runs" description="Every dispatch, most recent first.">
        <div className="table-wrap">
          <table>
            <thead><tr><th>Waybill</th><th>Customer</th><th>Sales order</th><th>Driver</th><th>Dispatched</th><th>Status</th><th className="no-print">Action</th><th className="no-print" /></tr></thead>
            <tbody>
              {runs.map(r => (
                <tr key={r.id}>
                  <td className="mono" style={{ fontSize: 12, color: 'rgb(var(--aqua-700))' }}>{r.id}</td>
                  <td><p style={{ fontWeight: 500 }}>{r.customer_name}</p><p className="sub">{r.route ?? r.customer_location}</p></td>
                  <td className="mono" style={{ fontSize: 12 }}>{r.sales_id}</td>
                  <td>{r.driver}</td>
                  <td className="sub">{r.dispatched_at}</td>
                  <td><Pill status={r.status} /></td>
                  <td className="no-print">
                    {r.status === 'ACTIVE' && <button className="btn btn-secondary btn-sm" onClick={() => markDelivered(r.id)}>Mark delivered</button>}
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
    </>
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
