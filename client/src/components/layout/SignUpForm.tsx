import { useState, type FormEvent } from 'react';
import { signUp } from '../../lib/authApi';

/** The "Create account" half of SignInGate. A brand new account starts with
 *  the Viewer role and no page grants, so it only sees the Dashboard until a
 *  System admin grants specific pages — see auth.createAccount server-side. */
export function SignUpForm({ onSignedUp }: { onSignedUp: (userId: string, name: string) => void }) {
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    if (password !== confirm) { setError('Passwords do not match'); return; }
    setSaving(true);
    try {
      const user = await signUp(name.trim(), email.trim(), password);
      onSignedUp(user.id, user.name);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong');
    } finally {
      setSaving(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} style={{ textAlign: 'left' }}>
      {error && <p style={{ color: 'rgb(var(--stop))', fontSize: 13, marginBottom: 12 }}>{error}</p>}
      <div className="form-row">
        <label htmlFor="su-name">Full name</label>
        <input id="su-name" value={name} onChange={e => setName(e.target.value)} required autoFocus autoComplete="name" />
      </div>
      <div className="form-row">
        <label htmlFor="su-email">Email</label>
        <input id="su-email" type="email" value={email} onChange={e => setEmail(e.target.value)} required autoComplete="email" />
      </div>
      <div className="form-row">
        <label htmlFor="su-password">Password</label>
        <input
          id="su-password" type="password" value={password} required minLength={6}
          autoComplete="new-password" onChange={e => setPassword(e.target.value)}
        />
      </div>
      <div className="form-row">
        <label htmlFor="su-confirm">Confirm password</label>
        <input
          id="su-confirm" type="password" value={confirm} required minLength={6}
          autoComplete="new-password" onChange={e => setConfirm(e.target.value)}
        />
      </div>
      <button type="submit" className="btn btn-primary" style={{ width: '100%', marginTop: 4 }} disabled={saving}>
        {saving ? 'Creating account…' : 'Create account'}
      </button>
    </form>
  );
}
