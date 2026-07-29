import { useState, type FormEvent } from 'react';
import { apiPost } from '../../lib/apiClient';
import { useCurrentUser } from '../../lib/currentUser';
import { Modal } from './Modal';

export function RequestDeletionModal({ entityType, entityId, entityLabel, onClose, onRequested }: {
  entityType: string;
  entityId: string;
  entityLabel: string;
  onClose: () => void;
  onRequested: () => void;
}) {
  const { user } = useCurrentUser();
  const [reason, setReason] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError(null);
    try {
      await apiPost('/deletion-requests', { entityType, entityId, entityLabel, requestedBy: user?.name ?? 'Unknown', reason });
      onRequested();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong');
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal title={`Request deletion — ${entityLabel}`} onClose={onClose} onSubmit={submit} submitLabel="Send for approval" saving={saving} error={error}>
      <div className="form-row">
        <label htmlFor="del-reason">Why should this be removed?</label>
        <textarea id="del-reason" value={reason} onChange={e => setReason(e.target.value)} rows={4} required autoFocus />
      </div>
      <p className="sub">A super admin reviews this in Delete requests before {entityLabel} is actually removed — it stays fully active until then.</p>
    </Modal>
  );
}
