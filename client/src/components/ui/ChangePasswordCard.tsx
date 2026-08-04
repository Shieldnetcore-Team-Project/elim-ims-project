import { useState, type FormEvent } from 'react';
import { useCurrentUser } from '../../lib/currentUser';
import { useUi } from '../../lib/uiState';
import { changePassword } from '../../lib/authApi';

/** Rendered at the top of the Settings page — lets the signed-in account change
 *  its own password. Requires the current password server-side (see
 *  POST /auth/change-password) so this can't be used to take over an account
 *  from an unattended, still-signed-in session. */
export function ChangePasswordCard() {
  const { user } = useCurrentUser();
  const ui = useUi();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  if (!user) return null;

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    if (next !== confirm) { setError('New passwords do not match'); return; }
    setSaving(true);
    try {
      await changePassword(user!.id, current, next);
      setCurrent(''); setNext(''); setConfirm('');
      ui.toast('Password changed');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong');
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="card" style={{ marginTop: 24 }}>
      <div className="card-head">
        <div>
          <h2 className="card-title">Change password</h2>
          <p className="card-desc">Update the password for {user.name}&apos;s account.</p>
        </div>
      </div>
      <form onSubmit={handleSubmit} style={{ padding: 20, maxWidth: 380 }}>
        {error && <p style={{ color: 'rgb(var(--stop))', fontSize: 13, marginBottom: 12 }}>{error}</p>}
        <div className="form-row">
          <label htmlFor="cp-current">Current password</label>
          <input
            id="cp-current" type="password" value={current} required
            autoComplete="current-password" onChange={e => setCurrent(e.target.value)}
          />
        </div>
        <div className="form-row">
          <label htmlFor="cp-new">New password</label>
          <input
            id="cp-new" type="password" value={next} required minLength={6}
            autoComplete="new-password" onChange={e => setNext(e.target.value)}
          />
        </div>
        <div className="form-row">
          <label htmlFor="cp-confirm">Confirm new password</label>
          <input
            id="cp-confirm" type="password" value={confirm} required minLength={6}
            autoComplete="new-password" onChange={e => setConfirm(e.target.value)}
          />
        </div>
        <button type="submit" className="btn btn-primary" disabled={saving}>
          {saving ? 'Saving…' : 'Change password'}
        </button>
      </form>
    </section>
  );
}
