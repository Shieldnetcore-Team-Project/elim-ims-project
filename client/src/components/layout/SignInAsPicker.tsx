import { useCurrentUser } from '../../lib/currentUser';
import { useUi } from '../../lib/uiState';
import { Icon } from '../ui/Icon';
import { UserPickerList } from './UserPickerList';
import logo from '../../images/elim logo.png';

export function SignInAsPicker({ onClose }: { onClose: () => void }) {
  const { users, signInAs } = useCurrentUser();
  const ui = useUi();

  return (
    <div className="overlay" onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="dialog" role="dialog" aria-modal="true" aria-label="Sign in as">
        <div className="dialog-head">
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <img
              src={logo}
              alt="Elim Table Water"
              style={{ height: 36, width: 'auto', borderRadius: 8, flexShrink: 0 }}
            />
            <h2 className="card-title">Sign in as</h2>
          </div>
          <button className="iconbtn" onClick={onClose} aria-label="Close" style={{ width: 28, height: 28 }}>
            <Icon name="x" size={16} />
          </button>
        </div>
        <UserPickerList onPick={id => {
          const picked = users.find(u => u.id === id);
          signInAs(id);
          onClose();
          if (picked) ui.toast(`Signed in as ${picked.name}`);
        }} />
        <p style={{ borderTop: '1px solid rgb(var(--line))', padding: '10px 20px', fontSize: 11, color: 'rgb(var(--muted))' }}>
          Switching accounts requires that account's password.
        </p>
      </div>
    </div>
  );
}
