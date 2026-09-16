import { useState } from 'react';
import { useCurrentUser } from '../../lib/currentUser';
import { useUi } from '../../lib/uiState';
import { UserPickerList } from './UserPickerList';
import { SignUpForm } from './SignUpForm';
import logo from '../../images/elim logo.png';
import builderLogo from '../../images/shieldnetcore-logo.png';

/** Shown in place of the whole app shell whenever nobody is signed in — a
 *  fresh browser, or after Topbar's Log out button. Two tabs: Sign in (the
 *  account tile picker, see UserPickerList) and Create account (self
 *  sign-up, see SignUpForm) — both live here rather than as separate
 *  routes since there's nowhere else to land once signed out. */
export function SignInGate() {
  const { users, signInAs, refreshUsers } = useCurrentUser();
  const ui = useUi();
  const [mode, setMode] = useState<'signin' | 'signup'>('signin');

  function handleSignedUp(name: string) {
    refreshUsers();
    setMode('signin');
    ui.toast(`Account created for ${name}. An admin must approve it before you can sign in.`);
  }

  return (
    <div className="signin-gate">
      <div className="signin-hero">
        <div className="signin-hero-logo-card">
          <img src={logo} alt="Elim Table Water" />
        </div>
        <span className="signin-hero-badge">Enterprise · Factory ready</span>
        <h1 className="signin-hero-title">
          Factory Management &amp; Inventory System
        </h1>
        <p className="signin-hero-sub">
          Run your <strong>Water Factory</strong> on one platform. Production, sales,
          procurement, HR, and reports — all cleanly organized, with role-based
          access and complete audit history.
        </p>
        <div className="signin-hero-foot">
          <span>© {new Date().getFullYear()} Elim Table Water</span>
          <span>Water Factory</span>
        </div>
      </div>

      <div className="signin-form-panel">
        <div className="dialog signin-gate-card">
          <h1 className="signin-gate-title">Welcome</h1>
          <p className="signin-gate-sub">
            {mode === 'signin' ? 'Sign in to access your factory dashboard' : 'Get started with a new account'}
          </p>

          <div className="authtabs" role="tablist" aria-label="Sign in or create an account">
            <button type="button" role="tab" aria-selected={mode === 'signin'} className="authtab" onClick={() => setMode('signin')}>
              Sign in
            </button>
            <button type="button" role="tab" aria-selected={mode === 'signup'} className="authtab" onClick={() => setMode('signup')}>
              Sign up
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
                An admin must approve your account before you can sign in. Once approved, you'll see the
                dashboard only until the admin grants access to specific pages.
              </p>
            </>
          )}

          <div className="built-by">
            <img src={builderLogo} alt="ShieldNetCore Tech" />
            <span>Built by ShieldNetCore Tech</span>
          </div>
        </div>
      </div>
    </div>
  );
}
