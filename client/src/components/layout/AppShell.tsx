import { Outlet, useLocation } from 'react-router-dom';
import { NAV_GROUPS, ADMIN_ONLY_NAV_KEYS } from '@shared/moduleConfig';
import { Sidebar } from './Sidebar';
import { Topbar } from './Topbar';
import { SignInGate } from './SignInGate';
import { Toasts } from '../ui/Toasts';
import { CommandPalette } from '../command-palette/CommandPalette';
import { ShortcutsDialog } from '../shortcuts/ShortcutsDialog';
import { Icon } from '../ui/Icon';
import { useUi } from '../../lib/uiState';
import { useCurrentUser } from '../../lib/currentUser';

const ALL_NAV_ITEMS = NAV_GROUPS.flatMap(g => g.items);

function AccessDenied() {
  return (
    <div className="empty" style={{ marginTop: 60 }}>
      <span className="ring"><Icon name="lock" size={20} /></span>
      <h1 style={{ marginTop: 16, fontSize: 22 }}>You don&apos;t have access to this page</h1>
      <p className="sub" style={{ marginTop: 6, maxWidth: 360 }}>
        Ask a super admin to grant it from the Admin panel, or switch to an account that already has it.
      </p>
    </div>
  );
}

function LoadFailed({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div className="empty" style={{ marginTop: 60 }}>
      <span className="ring"><Icon name="alert-triangle" size={20} /></span>
      <h1 style={{ marginTop: 16, fontSize: 22 }}>Couldn&apos;t reach the server</h1>
      <p className="sub" style={{ marginTop: 6, maxWidth: 360 }}>{message}</p>
      <button className="btn btn-secondary" style={{ marginTop: 16 }} onClick={onRetry}>Try again</button>
    </div>
  );
}

export function AppShell() {
  const ui = useUi();
  const location = useLocation();
  const { user, loading, error, refreshUsers, isSuperAdmin, allowedPages, hasAccess } = useCurrentUser();

  const pageKey = ALL_NAV_ITEMS.find(i => i.path === location.pathname)?.key;
  const gated = !!pageKey && pageKey !== 'dashboard';
  const stillCheckingAccess = gated && !isSuperAdmin && allowedPages === null;

  if (loading) return null;
  if (error && !user) return <LoadFailed message={error} onRetry={refreshUsers} />;
  if (!user) return <SignInGate />;

  let allowed = true;
  if (pageKey && ADMIN_ONLY_NAV_KEYS.includes(pageKey)) allowed = isSuperAdmin;
  else if (gated) allowed = isSuperAdmin || hasAccess(pageKey!);

  return (
    <>
      <a href="#main" className="skip">Skip to main content</a>
      <div id="live" role="status" aria-live="polite" className="sr" />
      <div className={`scrim${ui.drawerOpen ? ' open' : ''}`} onClick={ui.closeDrawer} />

      <Sidebar />

      <div className={`shell${ui.railCollapsed ? ' rail-collapsed' : ''}`}>
        <Topbar />
        <main id="main" tabIndex={-1}>
          <div className="wrap">
            {stillCheckingAccess ? null : allowed ? <Outlet /> : <AccessDenied />}
          </div>
        </main>
      </div>

      <Toasts />
      <CommandPalette />
      <ShortcutsDialog />
    </>
  );
}
