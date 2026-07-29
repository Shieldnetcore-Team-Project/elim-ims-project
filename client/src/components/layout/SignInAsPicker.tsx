import { useCurrentUser } from '../../lib/currentUser';
import { useUi } from '../../lib/uiState';
import { Icon } from '../ui/Icon';

function initials(name: string): string {
  return name.split(' ').map(p => p[0]).filter(Boolean).slice(0, 2).join('').toUpperCase();
}

export function SignInAsPicker({ onClose }: { onClose: () => void }) {
  const { users, user, signInAs } = useCurrentUser();
  const ui = useUi();

  return (
    <div className="overlay" onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="dialog" role="dialog" aria-modal="true" aria-label="Sign in as">
        <div className="dialog-head">
          <h2 className="card-title">Sign in as</h2>
          <button className="iconbtn" onClick={onClose} aria-label="Close" style={{ width: 28, height: 28 }}>
            <Icon name="x" size={16} />
          </button>
        </div>
        <div style={{ maxHeight: '60vh', overflowY: 'auto', padding: 6 }}>
          {users.map(u => (
            <button
              key={u.id}
              className={'palette-item' + (u.id === user?.id ? ' on' : '')}
              style={{ width: '100%' }}
              onClick={() => { signInAs(u.id); onClose(); ui.toast(`Signed in as ${u.name}`); }}
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
        <p style={{ borderTop: '1px solid rgb(var(--line))', padding: '10px 20px', fontSize: 11, color: 'rgb(var(--muted))' }}>
          No password — this switches which permissions the app enforces for you.
        </p>
      </div>
    </div>
  );
}
