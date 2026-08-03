import { useState, type FormEvent } from 'react';
import { apiPost } from '../../lib/apiClient';
import { useCurrentUser } from '../../lib/currentUser';
import { Modal } from './Modal';

// Reversal (Module 17) lives on each entity's own router, not one generic endpoint
// like deletion-requests — this is the one place that maps entityType to its path.
const REVERSE_PATH: Record<string, (id: string) => string> = {
  payments: id => `/finance/payments/${encodeURIComponent(id)}/reverse`,
  receipts: id => `/finance/receipts/${encodeURIComponent(id)}/reverse`,
  sales: id => `/sales/${encodeURIComponent(id)}/reverse`,
  goods_received: id => `/goods-received/${encodeURIComponent(id)}/reverse`,
  production_batches: id => `/production-batches/${encodeURIComponent(id)}/reverse`,
  finished_goods: id => `/finished-goods/${encodeURIComponent(id)}/reverse`,
  material_requests: id => `/material-requests/${encodeURIComponent(id)}/reverse`,
};

export function ReverseModal({ entityType, entityId, entityLabel, onClose, onReversed }: {
  entityType: string;
  entityId: string;
  entityLabel: string;
  onClose: () => void;
  onReversed: () => void;
}) {
  const { user } = useCurrentUser();
  const [reason, setReason] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (reason.trim().length < 8) { setError('A reason of at least 8 characters is required'); return; }
    setSaving(true);
    setError(null);
    try {
      await apiPost(REVERSE_PATH[entityType](entityId), { reason: reason.trim(), userId: user?.id });
      onReversed();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong');
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal title={`Reverse — ${entityLabel}`} onClose={onClose} onSubmit={submit} submitLabel="Reverse transaction" saving={saving} error={error}>
      <div className="form-row">
        <label htmlFor="rev-reason">Reason for reversal</label>
        <textarea id="rev-reason" value={reason} onChange={e => setReason(e.target.value)} rows={4} required autoFocus minLength={8} />
      </div>
      <p className="sub">This posts a real offsetting entry — {entityLabel} itself is never edited or deleted, it stays exactly as it was for the record.</p>
    </Modal>
  );
}
