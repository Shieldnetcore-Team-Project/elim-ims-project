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

export default function ControlPanelPage() {
  return (
    <>
      <PrintHeader />
      <div className="pagehead">
        <div><h1>Admin panel</h1><p className="pagesub">Users, roles, the audit log, and who can see what — super admin only.</p></div>
      </div>
      <Tabs tabs={[
        { key: 'users', label: 'Users', content: <ModulePage moduleKey="users" embedded /> },
        { key: 'roles', label: 'Roles & permissions', content: <ModulePage moduleKey="roles" embedded /> },
        { key: 'activity-log', label: 'Audit log', content: <ModulePage moduleKey="activity-log" embedded /> },
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
              <button className="btn btn-primary" onClick={save} disabled={saving}>{saving ? 'Saving…' : `Save access for ${selectedUser.name}`}</button>
            </div>
          </>
        )}

        {assignable.length === 0 && <EmptyState title="No assignable users yet" description="Everyone seeded so far is a super admin." onClear={() => {}} />}
      </div>
    </Card>
  );
}
