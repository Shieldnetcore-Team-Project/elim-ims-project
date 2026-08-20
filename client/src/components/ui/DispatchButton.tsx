import { useEffect, useState, type FormEvent } from 'react';
import { api, apiPost } from '../../lib/apiClient';
import { Icon } from './Icon';
import { Modal } from './Modal';

interface Vehicle { id: string; driver: string | null; status: string }

export function DispatchButton({ salesId, customerName, customerLocation, onDispatched }: {
  salesId: string;
  customerName: string;
  customerLocation: string | null;
  onDispatched: () => void;
}) {
  const [open, setOpen] = useState(false);

  return (
    <>
      <button
        className="iconbtn" style={{ width: 28, height: 28 }}
        onClick={e => { e.stopPropagation(); setOpen(true); }}
        aria-label={`Dispatch ${salesId}`}
        title="Dispatch delivery"
      >
        <Icon name="truck" size={14} />
      </button>
      {open && (
        // Same reasoning as ReverseButton/DeleteButton — stop clicks bubbling into
        // a parent row's onClick since this renders inline, not in a portal.
        <div onClick={e => e.stopPropagation()}>
          <DispatchModal
            salesId={salesId} customerName={customerName} customerLocation={customerLocation}
            onClose={() => setOpen(false)}
            onDispatched={() => { setOpen(false); onDispatched(); }}
          />
        </div>
      )}
    </>
  );
}

function DispatchModal({ salesId, customerName, customerLocation, onClose, onDispatched }: {
  salesId: string; customerName: string; customerLocation: string | null; onClose: () => void; onDispatched: () => void;
}) {
  const [vehicles, setVehicles] = useState<Vehicle[]>([]);
  const [vehicleId, setVehicleId] = useState('');
  const [driver, setDriver] = useState('');
  const [route, setRoute] = useState(customerLocation ?? '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api<Vehicle[]>('/masters/vehicles').then(rows => {
      setVehicles(rows);
      if (rows[0]) { setVehicleId(rows[0].id); setDriver(rows[0].driver ?? ''); }
    });
  }, []);

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
    <Modal title={`Dispatch ${salesId}`} onClose={onClose} onSubmit={submit} submitLabel="Dispatch" saving={saving} error={error}>
      <p className="sub" style={{ marginBottom: 10 }}>{customerName}{customerLocation ? ` — ${customerLocation}` : ''}</p>
      <div className="form-grid">
        <div className="form-row">
          <label htmlFor="dispatch-vehicle">Vehicle</label>
          <select id="dispatch-vehicle" value={vehicleId} onChange={e => {
            setVehicleId(e.target.value);
            const v = vehicles.find(x => x.id === e.target.value);
            if (v?.driver) setDriver(v.driver);
          }} required>
            {vehicles.length === 0 && <option value="" disabled>No vehicles yet</option>}
            {vehicles.map(v => <option key={v.id} value={v.id}>{v.id}</option>)}
          </select>
        </div>
        <div className="form-row">
          <label htmlFor="dispatch-driver">Driver</label>
          <input id="dispatch-driver" value={driver} onChange={e => setDriver(e.target.value)} required />
        </div>
      </div>
      <div className="form-row">
        <label htmlFor="dispatch-route">Route</label>
        <input id="dispatch-route" value={route} onChange={e => setRoute(e.target.value)} required />
      </div>
    </Modal>
  );
}
