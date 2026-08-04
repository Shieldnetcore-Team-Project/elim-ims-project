import { useState } from 'react';
import { useCurrentUser } from '../../lib/currentUser';
import { useUi } from '../../lib/uiState';
import { UserPickerList } from './UserPickerList';
import { SignUpForm } from './SignUpForm';
import logo from '../../images/elim logo.png';

/** Shown in place of the whole app shell whenever nobody is signed in — a
 *  fresh browser, or after Topbar's Log out button. Two tabs: Sign in (the
 *  account tile picker, see UserPickerList) and Create account (self
 *  sign-up, see SignUpForm) — both live here rather than as separate
 *  routes since there's nowhere else to land once signed out. */
export function SignInGate() {
  const { users, signInAs, refreshUsers } = useCurrentUser();
  const ui = useUi();
  const [mode, setMode] = useState<'signin' | 'signup'>('signin');

  function handleSignedUp(userId: string, name: string) {
    refreshUsers();
    signInAs(userId);
    ui.toast(`Welcome, ${name}!`);
  }

  return (
    <div className="signin-gate">
      <div className="dialog signin-gate-card">
        <img src={logo} alt="Elim Table Water" className="signin-gate-logo" />
        <h1 className="signin-gate-title">{mode === 'signin' ? 'Sign in' : 'Create your account'}</h1>
        <p className="signin-gate-sub">
          {mode === 'signin' ? 'Choose your account to continue.' : 'Get started with a new account.'}
        </p>

        <div className="authtabs" role="tablist" aria-label="Sign in or create an account">
          <button type="button" role="tab" aria-selected={mode === 'signin'} className="authtab" onClick={() => setMode('signin')}>
            Sign in
          </button>
          <button type="button" role="tab" aria-selected={mode === 'signup'} className="authtab" onClick={() => setMode('signup')}>
            Create account
          </button>
        </div>

        {mode === 'signin' ? (
          <>
            <UserPickerList onPick={id => {
              const picked = users.find(u => u.id === id);
              signInAs(id);
              if (picked) ui.toast(`Signed in as ${picked.name}`);
            }} />
            <p className="signin-gate-note">
              Choose an account, then enter its password to continue.
            </p>
          </>
        ) : (
          <>
            <SignUpForm onSignedUp={handleSignedUp} />
            <p className="signin-gate-note">
              New accounts can see the dashboard only, until an admin grants access to specific pages.
            </p>
          </>
        )}
      </div>
    </div>
  );
}
