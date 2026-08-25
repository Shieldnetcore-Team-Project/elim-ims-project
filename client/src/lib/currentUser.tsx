import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { api } from './apiClient';

export interface AppUser { id: string; name: string; email: string | null; role: string; status: string }

const STORAGE_KEY = 'elim.currentUserId';
const SUPER_ADMIN_ROLE = 'System admin';

interface CurrentUserState {
  user: AppUser | null;
  users: AppUser[];
  isSuperAdmin: boolean;
  /** true until the user list has been fetched at least once — distinct from
   *  `user === null`, which (once loaded) means genuinely signed out. */
  loading: boolean;
  /** Set when the last fetch of the user list failed — AppShell shows this
   *  instead of silently sitting blank forever with loading stuck true. */
  error: string | null;
  /** null while access is still loading — treat as "not yet known", not "denied". */
  allowedPages: string[] | null;
  hasAccess: (pageKey: string) => boolean;
  signInAs: (userId: string) => void;
  /** Clears the stored session — user becomes null and AppShell shows the sign-in gate. */
  signOut: () => void;
  refreshUsers: () => void;
}

const Ctx = createContext<CurrentUserState | null>(null);

export function CurrentUserProvider({ children }: { children: ReactNode }) {
  const [users, setUsers] = useState<AppUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [userId, setUserId] = useState<string | null>(() => {
    try { return localStorage.getItem(STORAGE_KEY); } catch { return null; }
  });
  const [allowedPages, setAllowedPages] = useState<string[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refreshUsers = useCallback(() => {
    api<AppUser[]>('/masters/users')
      .then(res => { setUsers(res); setError(null); setLoading(false); })
      // Without this, a failed fetch left `loading` stuck true forever —
      // AppShell renders nothing while loading, so the whole app just went
      // blank with no indication anything was wrong.
      .catch((err: unknown) => { setError(err instanceof Error ? err.message : 'Failed to load users'); setLoading(false); });
  }, []);
  // Refetch on focus too — someone sitting on the sign-in gate waiting for a
  // System admin to approve their account (or flip PENDING_APPROVAL to
  // Active elsewhere) has no push channel to know it happened, so switching
  // back to this tab is what picks up the change.
  useEffect(() => {
    refreshUsers();
    window.addEventListener('focus', refreshUsers);
    return () => window.removeEventListener('focus', refreshUsers);
  }, [refreshUsers]);

  const user = useMemo<AppUser | null>(() => {
    if (loading) return null;
    // No stored id — never signed in, or explicitly signed out. Show the
    // sign-in gate rather than silently picking someone, unlike before.
    if (!userId) return null;
    const found = users.find(u => u.id === userId);
    if (found) return found;
    // Stored id no longer matches anyone (e.g. deleted) — fall back to a
    // super admin (the guaranteed seeded one, or any other) rather than
    // locking the app open on a dangling reference.
    return users.find(u => u.role === SUPER_ADMIN_ROLE) ?? users[0] ?? null;
  }, [users, userId, loading]);

  const isSuperAdmin = user?.role === SUPER_ADMIN_ROLE;

  // Also poll while sitting on the sign-in gate — a newly-approved account
  // should appear in the picker without the person needing to know to
  // switch tabs and back or hit refresh. Not needed once signed in.
  useEffect(() => {
    if (loading || user) return;
    const interval = setInterval(refreshUsers, 15_000);
    return () => clearInterval(interval);
  }, [loading, user, refreshUsers]);

  useEffect(() => {
    if (!user || isSuperAdmin) { setAllowedPages(null); return; }
    let alive = true;
    const fetchAccess = () => {
      api<{ pages: string[] }>(`/access-control/${encodeURIComponent(user.id)}`).then(res => { if (alive) setAllowedPages(res.pages); });
    };
    fetchAccess();
    // Covers a session that's been open since before an admin granted new
    // pages elsewhere — refetch whenever the tab regains focus, rather than
    // only on sign-in, so newly granted pages show up without a manual
    // sign-out/sign-in.
    window.addEventListener('focus', fetchAccess);
    return () => { alive = false; window.removeEventListener('focus', fetchAccess); };
  }, [user, isSuperAdmin]);

  const signInAs = useCallback((id: string) => {
    setUserId(id);
    try { localStorage.setItem(STORAGE_KEY, id); } catch { /* private browsing */ }
  }, []);

  const signOut = useCallback(() => {
    setUserId(null);
    try { localStorage.removeItem(STORAGE_KEY); } catch { /* private browsing */ }
  }, []);

  const hasAccess = useCallback((pageKey: string): boolean => {
    if (!user) return false;
    if (isSuperAdmin) return true;
    if (pageKey === 'dashboard') return true;
    return allowedPages?.includes(pageKey) ?? false;
  }, [user, isSuperAdmin, allowedPages]);

  const value: CurrentUserState = { user, users, isSuperAdmin, loading, error, allowedPages, hasAccess, signInAs, signOut, refreshUsers };
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useCurrentUser(): CurrentUserState {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error('useCurrentUser must be used within <CurrentUserProvider>');
  return ctx;
}
