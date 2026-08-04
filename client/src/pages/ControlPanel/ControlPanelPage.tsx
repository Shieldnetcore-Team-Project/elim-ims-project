import { useEffect, useState } from 'react';
import { NAV_GROUPS, ADMIN_ONLY_NAV_KEYS } from '@shared/moduleConfig';
import { api, apiPut } from '../../lib/apiClient';
import { useCurrentUser } from '../../lib/currentUser';
import { useUi } from '../../lib/uiState';
import { Card } from '../../components/ui/Card';
import { Tabs } from '../../components/ui/Tabs';
import { EmptyState } from '../../components/ui/EmptyState';
import { PrintHeader } from '../../components/ui/PrintHeader';
import { ModulePage } from '../Module/ModulePage';

const ASSIGNABLE_GROUPS = NAV_GROUPS
  .map(g => ({ group: g.group, items: g.items.filter(i => i.key !== 'dashboard' && !ADMIN_ONLY_NAV_KEYS.includes(i.key)) }))
  .filter(g => g.items.length > 0);

/** Not page-access — these gate the Approve/Reject action inside a page the
 *  requester and approver can both otherwise see (procurement, sales). Kept
 *  as separate grants (same user_page_access table, just page keys with no
 *  nav item) so a Procurement Officer can be given the "procurement" page
 *  without also being able to approve their own purchase orders — dual
 *  control, enforced server-side too (see requirePageAccess). */
const APPROVAL_CAPABILITIES: { key: string; label: string; description: string }[] = [
  { key: 'procurement-approve', label: 'Procurement approvals', description: 'Approve or reject purchase orders. Leave this off for whoever raises the PO.' },
  { key: 'sales-approve', label: 'Sales approvals', description: 'Approve or reject credit sales orders. Leave this off for the rep who created the order.' },
];

export default function ControlPanelPage() {
  return (
    <>
      <PrintHeader />
      <div className="pagehead">
        <div><h1>Admin Panel</h1><p className="pagesub">Users, roles, the audit log, and who can see what — super admin only.</p></div>
      </div>
      <Tabs tabs={[
        { key: 'users', label: 'Users', content: <ModulePage moduleKey="users" embedded /> },
        { key: 'roles', label: 'Roles & Permissions', content: <ModulePage moduleKey="roles" embedded /> },
        { key: 'activity-log', label: 'Audit Log', content: <ModulePage moduleKey="activity-log" embedded /> },
        { key: 'access', label: 'Access control', content: <AccessControlTab /> },
      ]} />
    </>
  );
}

function AccessControlTab() {
  const { users } = useCurrentUser();
  const ui = useUi();
  const assignable = users.filter(u => u.role !== 'System admin');
  const [selectedId, setSelectedId] = useState('');
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!selectedId && assignable.length > 0) setSelectedId(assignable[0].id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [assignable.length]);

  useEffect(() => {
    if (!selectedId) return;
    setLoaded(false);
    api<{ pages: string[] }>(`/access-control/${encodeURIComponent(selectedId)}`).then(res => {
      setChecked(new Set(res.pages));
      setLoaded(true);
    });
  }, [selectedId]);

  function toggle(key: string) {
    setChecked(prev => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  }

  async function save() {
    setSaving(true);
    try {
      await apiPut(`/access-control/${encodeURIComponent(selectedId)}`, { pages: [...checked] });
      ui.toast('Access updated');
    } finally {
      setSaving(false);
    }
  }

  const selectedUser = assignable.find(u => u.id === selectedId);

  return (
    <Card title="Page access" description="Dashboard is always visible to everyone; every other page is opt-in per user.">
      <div style={{ padding: 20, display: 'grid', gap: 20 }}>
        <div className="form-row" style={{ maxWidth: 380, marginBottom: 0 }}>
          <label htmlFor="cp-user">User</label>
          <select id="cp-user" value={selectedId} onChange={e => setSelectedId(e.target.value)}>
            {assignable.map(u => <option key={u.id} value={u.id}>{u.name} — {u.role}</option>)}
          </select>
        </div>

        {selectedUser && loaded && (
          <>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: 20 }}>
              {ASSIGNABLE_GROUPS.map(g => (
                <div key={g.group}>
                  <p style={{ fontSize: 11, fontWeight: 600, letterSpacing: '.08em', textTransform: 'uppercase', color: 'rgb(var(--muted))', marginBottom: 8 }}>{g.group}</p>
                  {g.items.map(item => (
                    <label key={item.key} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '4px 0', fontSize: 13, cursor: 'pointer' }}>
                      <input type="checkbox" checked={checked.has(item.key)} onChange={() => toggle(item.key)} />
                      {item.label}
                    </label>
                  ))}
                </div>
              ))}
            </div>
            <div>
              <p style={{ fontSize: 11, fontWeight: 600, letterSpacing: '.08em', textTransform: 'uppercase', color: 'rgb(var(--muted))', marginBottom: 4 }}>
                Approvals — dual control
              </p>
              <p className="sub" style={{ marginBottom: 10 }}>
                Separate from page access above, so the person who requests something isn't also the one who approves it.
              </p>
              <div style={{ display: 'grid', gap: 8, maxWidth: 480 }}>
                {APPROVAL_CAPABILITIES.map(cap => (
                  <label
                    key={cap.key}
                    style={{ display: 'flex', alignItems: 'flex-start', gap: 8, padding: '8px 10px', border: '1px solid rgb(var(--line))', borderRadius: 8, cursor: 'pointer' }}
                  >
                    <input type="checkbox" checked={checked.has(cap.key)} onChange={() => toggle(cap.key)} style={{ marginTop: 2 }} />
                    <span>
                      <span style={{ display: 'block', fontSize: 13, fontWeight: 500 }}>{cap.label}</span>
                      <span className="sub">{cap.description}</span>
                    </span>
                  </label>
                ))}
              </div>
            </div>

            <div>
              <button className="btn btn-primary" onClick={save} disabled={saving}>{saving ? 'Saving…' : `Save access for ${selectedUser.name}`}</button>
            </div>
          </>
        )}

        {assignable.length === 0 && <EmptyState title="No assignable users yet" description="Everyone seeded so far is a super admin." onClear={() => {}} />}
      </div>
    </Card>
  );
}
