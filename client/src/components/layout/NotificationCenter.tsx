import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Icon } from '../ui/Icon';
import { Pill } from '../ui/Pill';
import { api } from '../../lib/apiClient';

interface ExpiryAlert {
  id: string; vehicle_id: string; vehicle_plate_number: string | null; document_type: string;
  expiry_date: string | null; days_until_expiry: number; expired: boolean;
}

export function useDocumentExpiryAlerts(): ExpiryAlert[] {
  const [alerts, setAlerts] = useState<ExpiryAlert[]>([]);
  useEffect(() => {
    let cancelled = false;
    const load = () => api<ExpiryAlert[]>('/vehicle-documents/expiring').then(rows => { if (!cancelled) setAlerts(rows); });
    load();
    const interval = setInterval(load, 5 * 60 * 1000);
    return () => { cancelled = true; clearInterval(interval); };
  }, []);
  return alerts;
}

export function NotificationCenter({ onClose }: { onClose: () => void }) {
  const alerts = useDocumentExpiryAlerts();
  const navigate = useNavigate();

  return (
    <div className="overlay" onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="dialog" role="dialog" aria-modal="true" aria-label="Notifications" style={{ maxWidth: 460 }}>
        <div className="dialog-head">
          <h2 className="card-title">Notifications</h2>
          <button className="iconbtn" onClick={onClose} aria-label="Close" style={{ width: 28, height: 28 }}>
            <Icon name="x" size={16} />
          </button>
        </div>
        <div style={{ padding: '8px 0', maxHeight: '60vh', overflowY: 'auto' }}>
          {alerts.length === 0 && (
            <p className="sub" style={{ padding: '20px 20px' }}>Nothing needs attention right now.</p>
          )}
          {alerts.map(a => (
            <button
              key={a.id}
              onClick={() => { onClose(); navigate('/fleet'); }}
              style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', width: '100%', padding: '10px 20px', textAlign: 'left', borderBottom: '1px solid rgb(var(--line))' }}
            >
              <span>
                <span style={{ display: 'block', fontWeight: 500, fontSize: 13 }}>{a.document_type} — {a.vehicle_plate_number ?? a.vehicle_id}</span>
                <span className="sub">{a.expired ? `Expired ${Math.abs(a.days_until_expiry)} day(s) ago` : `Expires in ${a.days_until_expiry} day(s)`} · {a.expiry_date}</span>
              </span>
              <Pill status={a.expired ? 'EXPIRED' : 'DUE_SOON'} />
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
