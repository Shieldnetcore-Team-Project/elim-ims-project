import { useState, type FormEvent } from 'react';
import { useCurrentUser } from '../../lib/currentUser';
import { Icon } from '../ui/Icon';
import { verifyLogin } from '../../lib/authApi';

function initials(name: string): string {
  return name.split(' ').map(p => p[0]).filter(Boolean).slice(0, 2).join('').toUpperCase();
}

/** The list of accounts to pick from — shared by SignInAsPicker (a modal, for
 *  switching while already signed in) and SignInGate (a full page, shown
 *  when signed out) so the two don't duplicate the same row markup. Picking
 *  an account drops into a password step for that specific account; onPick
 *  only fires once the server has verified it. */
export function UserPickerList({ onPick }: { onPick: (userId: string) => void }) {
  const { users: allUsers, user } = useCurrentUser();
  // A suspended account shouldn't be sign-in-able at all — filtered out here
  // rather than merely disabled, so the list stays a clean picture of who
  // can actually use the app. The server enforces this too (see /auth/login).
  const users = allUsers.filter(u => u.status !== 'SUSPENDED');
  const [pending, setPending] = useState<{ id: string; name: string } | null>(null);
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [checking, setChecking] = useState(false);

  function reset() {
    setPending(null);
    setPassword('');
    setError('');
  }

  async function submitPassword(e: FormEvent) {
    e.preventDefault();
    if (!pending) return;
    setChecking(true);
    setError('');
    try {
      await verifyLogin(pending.id, password);
      onPick(pending.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Incorrect password');
    } finally {
      setChecking(false);
    }
  }

  if (pending) {
    return (
      <form onSubmit={submitPassword} style={{ padding: '14px 12px 6px' }}>
        <button
          type="button" onClick={reset}
          style={{ fontSize: 12, color: 'rgb(var(--muted))', marginBottom: 12 }}
        >
          ‹ Back to accounts
        </button>
        <div className="form-row">
          <label htmlFor="picker-password">Password for {pending.name}</label>
          <input
            id="picker-password" type="password" value={password} autoFocus required
            autoComplete="current-password"
            onChange={e => setPassword(e.target.value)}
          />
        </div>
        {error && <p style={{ color: 'rgb(var(--stop))', fontSize: 13, margin: '4px 0 8px' }}>{error}</p>}
        <button type="submit" className="btn btn-primary" style={{ width: '100%', marginTop: 4 }} disabled={checking}>
          {checking ? 'Checking…' : 'Sign in'}
        </button>
      </form>
    );
  }

  return (
    <div style={{ maxHeight: '60vh', overflowY: 'auto', padding: 6 }}>
      {users.map(u => (
        <button
          key={u.id}
          className={'palette-item' + (u.id === user?.id ? ' on' : '')}
          style={{ width: '100%' }}
          onClick={() => { setPending({ id: u.id, name: u.name }); setPassword(''); setError(''); }}
        >
          <span style={{ width: 28, height: 28, borderRadius: 999, background: 'rgb(var(--ink-700))', color: '#fff', display: 'grid', placeItems: 'center', fontSize: 11, fontWeight: 600, flexShrink: 0 }}>
            {initials(u.name)}
          </span>
          <span style={{ flex: 1, textAlign: 'left', overflow: 'hidden' }}>
            <span style={{ display: 'block', fontSize: 13, fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{u.name}</span>
            <span style={{ display: 'block', fontSize: 11, color: 'rgb(var(--muted))' }}>{u.role}{u.role === 'System admin' ? ' · full access' : ''}</span>
          </span>
          {u.id === user?.id && <Icon name="chevronRight" size={14} className="muted-icon" />}
        </button>
      ))}
      {users.length === 0 && <p className="sub" style={{ padding: '20px 12px', textAlign: 'center' }}>Loading users…</p>}
    </div>
  );
}
