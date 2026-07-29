import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { api } from './apiClient';

export interface AppUser { id: string; name: string; email: string | null; role: string; status: string }

const STORAGE_KEY = 'elim.currentUserId';
const SUPER_ADMIN_ROLE = 'System admin';

interface CurrentUserState {
  user: AppUser | null;
  users: AppUser[];
  isSuperAdmin: boolean;
  /** null while access is still loading — treat as "not yet known", not "denied". */
  allowedPages: string[] | null;
  hasAccess: (pageKey: string) => boolean;
  signInAs: (userId: string) => void;
  refreshUsers: () => void;
}

const Ctx = createContext<CurrentUserState | null>(null);

export function CurrentUserProvider({ children }: { children: ReactNode }) {
  const [users, setUsers] = useState<AppUser[]>([]);
  const [userId, setUserId] = useState<string | null>(() => {
    try { return localStorage.getItem(STORAGE_KEY); } catch { return null; }
  });
  const [allowedPages, setAllowedPages] = useState<string[] | null>(null);

  const refreshUsers = useCallback(() => { api<AppUser[]>('/masters/users').then(setUsers); }, []);
  useEffect(() => { refreshUsers(); }, [refreshUsers]);

  const user = useMemo<AppUser | null>(() => {
    if (users.length === 0) return null;
    const found = userId ? users.find(u => u.id === userId) : undefined;
    if (found) return found;
    // Stored id missing, deleted, or nothing chosen yet — fall back to a super admin
    // (the guaranteed seeded one, or any other) so the app never opens fully locked out.
    return users.find(u => u.role === SUPER_ADMIN_ROLE) ?? users[0];
  }, [users, userId]);

  const isSuperAdmin = user?.role === SUPER_ADMIN_ROLE;

  useEffect(() => {
    if (!user || isSuperAdmin) { setAllowedPages(null); return; }
    let alive = true;
    api<{ pages: string[] }>(`/access-control/${encodeURIComponent(user.id)}`).then(res => { if (alive) setAllowedPages(res.pages); });
    return () => { alive = false; };
  }, [user, isSuperAdmin]);

  const signInAs = useCallback((id: string) => {
    setUserId(id);
    try { localStorage.setItem(STORAGE_KEY, id); } catch { /* private browsing */ }
  }, []);

  const hasAccess = useCallback((pageKey: string): boolean => {
    if (!user) return false;
    if (isSuperAdmin) return true;
    if (pageKey === 'dashboard') return true;
    return allowedPages?.includes(pageKey) ?? false;
  }, [user, isSuperAdmin, allowedPages]);

  const value: CurrentUserState = { user, users, isSuperAdmin, allowedPages, hasAccess, signInAs, refreshUsers };
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useCurrentUser(): CurrentUserState {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error('useCurrentUser must be used within <CurrentUserProvider>');
  return ctx;
}
