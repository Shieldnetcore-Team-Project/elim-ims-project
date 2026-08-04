import { useState, type FormEvent } from 'react';
import { supabase } from '../client';
import logo from '../images/elim logo.png';

type Mode = 'sign-in' | 'sign-up';

export function LoginPage() {
  const [mode, setMode] = useState<Mode>('sign-in');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [fullName, setFullName] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [signedUp, setSignedUp] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      if (mode === 'sign-in') {
        const { error: signInError } = await supabase.auth.signInWithPassword({ email, password });
        if (signInError) throw signInError;
      } else {
        const { error: signUpError } = await supabase.auth.signUp({
          email,
          password,
          options: { data: fullName ? { full_name: fullName } : undefined },
        });
        if (signUpError) throw signUpError;
        setSignedUp(true);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="login-page">
      <div className="login-card">
        <img src={logo} alt="Elim Table Water" className="login-logo" />

        {signedUp ? (
          <div className="login-notice">
            <h1>Check your email</h1>
            <p>
              We sent a confirmation link to <strong>{email}</strong>. Confirm it, then sign in below.
            </p>
            <button className="login-link" onClick={() => { setSignedUp(false); setMode('sign-in'); }}>
              Back to sign in
            </button>
          </div>
        ) : (
          <>
            <h1>{mode === 'sign-in' ? 'Sign in' : 'Create an account'}</h1>
            <p className="login-sub">
              {mode === 'sign-in'
                ? 'Sign in with your Elim Water Factory account.'
                : 'New accounts start with no module access until an administrator grants a role.'}
            </p>

            <form onSubmit={submit} className="login-form">
              {mode === 'sign-up' && (
                <label className="login-field">
                  <span>Full name</span>
                  <input value={fullName} onChange={e => setFullName(e.target.value)} autoComplete="name" />
                </label>
              )}
              <label className="login-field">
                <span>Email</span>
                <input
                  type="email" value={email} onChange={e => setEmail(e.target.value)}
                  autoComplete="email" required autoFocus
                />
              </label>
              <label className="login-field">
                <span>Password</span>
                <input
                  type="password" value={password} onChange={e => setPassword(e.target.value)}
                  autoComplete={mode === 'sign-in' ? 'current-password' : 'new-password'}
                  minLength={6} required
                />
              </label>

              {error && <p className="login-error">{error}</p>}

              <button type="submit" className="login-submit" disabled={submitting}>
                {submitting ? 'Please wait…' : mode === 'sign-in' ? 'Sign in' : 'Create account'}
              </button>
            </form>

            <button
              className="login-link"
              onClick={() => { setMode(mode === 'sign-in' ? 'sign-up' : 'sign-in'); setError(null); }}
            >
              {mode === 'sign-in' ? "Don't have an account? Create one" : 'Already have an account? Sign in'}
            </button>
          </>
        )}
      </div>
    </div>
  );
}
