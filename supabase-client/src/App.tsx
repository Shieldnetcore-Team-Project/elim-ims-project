import { useEffect, useState } from 'react';
import { AuthProvider, useAuth } from './AuthContext';
import { supabase } from './client';
import { LoginPage } from './pages/LoginPage';
import logo from './images/elim logo.png';
import './styles.css';

function AuthedView() {
  const { user, signOut } = useAuth();
  const [profile, setProfile] = useState<{ full_name: string; status: string; role_id: string | null } | null>(null);
  const [profileError, setProfileError] = useState<string | null>(null);

  // Exercises the users_select RLS policy (20260803120300) — proves the
  // backend isn't just authenticating, it's actually enforcing row access
  // for the signed-in session end to end.
  useEffect(() => {
    if (!user) return;
    supabase
      .from('users')
      .select('full_name, status, role_id')
      .eq('auth_user_id', user.id)
      .maybeSingle()
      .then(({ data, error }) => {
        if (error) setProfileError(error.message);
        else setProfile(data);
      });
  }, [user]);

  return (
    <div className="login-page">
      <div className="login-card">
        <img src={logo} alt="Elim Table Water" className="login-logo" />
        <h1>Signed in</h1>
        <p className="login-sub">{user?.email}</p>

        <div className="authed-profile">
          {profileError && <p className="login-error">Couldn&apos;t load profile: {profileError}</p>}
          {!profileError && !profile && <p className="login-sub">Loading your profile…</p>}
          {profile && (
            <>
              <p><span>Name</span>{profile.full_name}</p>
              <p><span>Status</span>{profile.status}</p>
              <p><span>Role</span>{profile.role_id ? 'Assigned' : 'Unassigned — ask an administrator to grant one'}</p>
            </>
          )}
        </div>

        <button className="login-submit" onClick={() => signOut()}>Log out</button>
      </div>
    </div>
  );
}

function AuthGate() {
  const { session, loading } = useAuth();
  if (loading) return null;
  return session ? <AuthedView /> : <LoginPage />;
}

export function App() {
  return (
    <AuthProvider>
      <AuthGate />
    </AuthProvider>
  );
}
