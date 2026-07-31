import { useEffect, useState, type FormEvent } from 'react';
import { api, apiPost } from '../../lib/apiClient';
import { useCurrentUser } from '../../lib/currentUser';
import { useUi } from '../../lib/uiState';
import type { DeletionRequestRow } from '../../lib/pendingDeletions';
import { Card } from '../../components/ui/Card';
import { Modal } from '../../components/ui/Modal';
import { Pill } from '../../components/ui/Pill';
import { EmptyState } from '../../components/ui/EmptyState';
import { PrintHeader } from '../../components/ui/PrintHeader';

export default function DeleteRequestsPage() {
  const [status, setStatus] = useState<'PENDING' | 'APPROVED' | 'REJECTED' | ''>('PENDING');
  const [requests, setRequests] = useState<DeletionRequestRow[]>([]);
  const [reloadKey, setReloadKey] = useState(0);
  const [reviewing, setReviewing] = useState<DeletionRequestRow | null>(null);

  useEffect(() => {
    api<DeletionRequestRow[]>('/deletion-requests', status ? { status } : undefined).then(setRequests);
  }, [status, reloadKey]);

  return (
    <>
      <PrintHeader />
      <div className="pagehead">
        <div><h1>Delete requests</h1><p className="pagesub">Every deletion raised anywhere in the app, waiting on your approval — super admin only.</p></div>
      </div>

      <Card
        title="Deletion requests"
        description="Approving removes the record from its module going forward; rejecting keeps it fully active."
        action={(
          <select value={status} onChange={e => setStatus(e.target.value as 'PENDING' | 'APPROVED' | 'REJECTED' | '')} aria-label="Status">
            <option value="PENDING">Pending</option>
            <option value="APPROVED">Approved</option>
            <option value="REJECTED">Rejected</option>
            <option value="">All</option>
          </select>
        )}
      >
        <div className="table-wrap">
          <table>
            <thead><tr><th>Request</th><th>Entity</th><th>Requested by</th><th>Requested at</th><th>Reason</th><th>Status</th><th className="no-print">Action</th></tr></thead>
            <tbody>
              {requests.map(r => (
                <tr key={r.id}>
                  <td className="mono" style={{ fontSize: 12, color: 'rgb(var(--aqua-700))' }}>{r.id}</td>
                  <td><p style={{ fontWeight: 500 }}>{r.entity_label ?? r.entity_id}</p><p className="sub">{r.entity_type} · {r.entity_id}</p></td>
                  <td>{r.requested_by}</td>
                  <td className="sub">{r.requested_at}</td>
                  <td className="sub" style={{ whiteSpace: 'normal', maxWidth: 280 }}>{r.reason}</td>
                  <td><Pill status={r.status} /></td>
                  <td className="no-print">
                    {r.status === 'PENDING' && <button className="btn btn-secondary btn-sm" onClick={() => setReviewing(r)}>Review</button>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {requests.length === 0 && <EmptyState title="Nothing here" description="No deletion requests match that status." onClear={() => setStatus('PENDING')} />}

        {reviewing && (
          <ReviewDeletion
            request={reviewing}
            onClose={() => setReviewing(null)}
            onReviewed={() => { setReviewing(null); setReloadKey(k => k + 1); }}
          />
        )}
      </Card>
    </>
  );
}

function ReviewDeletion({ request, onClose, onReviewed }: { request: DeletionRequestRow; onClose: () => void; onReviewed: () => void }) {
  const { user } = useCurrentUser();
  const ui = useUi();
  const [note, setNote] = useState('');
  const [saving, setSaving] = useState<'approve' | 'reject' | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function act(action: 'approve' | 'reject') {
    setSaving(action);
    setError(null);
    try {
      await apiPost(`/deletion-requests/${encodeURIComponent(request.id)}/${action}`, { reviewedBy: user?.name ?? 'Admin', note: note || undefined });
      ui.toast(action === 'approve'
        ? `${request.entity_label ?? request.entity_id} removed from active use`
        : `Deletion request rejected — ${request.entity_label ?? request.entity_id} stays active`);
      onReviewed();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong');
    } finally {
      setSaving(null);
    }
  }

  function submit(e: FormEvent) {
    e.preventDefault();
    act('approve');
  }

  return (
    <Modal
      title={`Review — ${request.entity_label ?? request.entity_id}`} onClose={onClose}
      onSubmit={submit} submitLabel={saving === 'approve' ? 'Approving…' : 'Approve'} saving={saving === 'approve'} error={error}
    >
      <p className="sub" style={{ marginBottom: 6 }}>{request.entity_type} · {request.entity_id} · requested by {request.requested_by}</p>
      <p style={{ fontSize: 13, marginBottom: 14 }}>&ldquo;{request.reason}&rdquo;</p>
      <div className="form-row">
        <label htmlFor="review-note">Note (optional)</label>
        <textarea id="review-note" rows={3} value={note} onChange={e => setNote(e.target.value)} />
      </div>
      <button type="button" className="btn btn-secondary" style={{ width: '100%' }} onClick={() => act('reject')} disabled={saving !== null}>
        {saving === 'reject' ? 'Rejecting…' : 'Reject instead'}
      </button>
    </Modal>
  );
}
