import { NavLink } from 'react-router-dom';
import { NAV_GROUPS, ADMIN_ONLY_NAV_KEYS } from '@shared/moduleConfig';
import { Icon } from '../ui/Icon';
import { useUi } from '../../lib/uiState';
import { useCurrentUser } from '../../lib/currentUser';

export function Sidebar() {
  const ui = useUi();
  const { isSuperAdmin, hasAccess } = useCurrentUser();

  const visibleGroups = NAV_GROUPS
    .map(g => ({
      group: g.group,
      items: g.items.filter(item => ADMIN_ONLY_NAV_KEYS.includes(item.key) ? isSuperAdmin : (isSuperAdmin || hasAccess(item.key))),
    }))
    .filter(g => g.items.length > 0);

  return (
    <aside className={`rail${ui.drawerOpen ? ' open' : ''}${ui.railCollapsed ? ' collapsed' : ''}`} aria-label="Main navigation">
      <div className="rail-head">
        <span className="rail-logo"><Icon name="drop" size={20} /></span>
        <div style={{ minWidth: 0 }}>
          <p className="rail-name">Elim Table<span style={{ color: 'rgb(var(--aqua-300))' }}> Water</span></p>
          <p className="rail-sub">Factory Operations</p>
        </div>
        <button className="rail-close" onClick={ui.closeDrawer} aria-label="Close navigation">
          <Icon name="x" size={16} />
        </button>
      </div>

      <nav className="rail-nav">
        {visibleGroups.map(g => (
          <div className="rail-group" key={g.group}>
            <p className="rail-group-label">{g.group}</p>
            {g.items.map(item => (
              <NavLink
                key={item.key}
                to={item.path}
                onClick={ui.closeDrawer}
                end={item.path === '/'}
                title={item.label}
                className={({ isActive }) => 'rail-item' + (isActive ? ' active' : '')}
              >
                <Icon name={item.icon} />
                <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis' }}>{item.label}</span>
              </NavLink>
            ))}
          </div>
        ))}
      </nav>

      <div className="rail-live">
        <p style={{ fontSize: 12, fontWeight: 600, color: 'rgb(var(--rail-text))' }}>Treatment line running</p>
        <p style={{ fontSize: 11, lineHeight: 1.5, color: 'rgb(var(--rail-dim))', marginTop: 4 }}>
          RO, UV and ozone stages nominal. Last QC pass 06:12.
        </p>
        <p style={{ marginTop: 10, display: 'flex', alignItems: 'center', gap: 6 }}>
          <span style={{ width: 6, height: 6, borderRadius: 999, background: 'rgb(var(--aqua-300))', display: 'block', animation: 'pulse 2s infinite' }} />
          <span className="mono" style={{ fontSize: 11, color: 'rgb(var(--aqua-300))' }}>TR-4471</span>
        </p>
      </div>

      <button
        className="rail-collapse"
        onClick={ui.toggleRailCollapsed}
        aria-label={ui.railCollapsed ? 'Expand navigation' : 'Collapse navigation'}
        title={ui.railCollapsed ? 'Expand' : 'Collapse'}
      >
        <Icon name="chevronRight" size={16} className={ui.railCollapsed ? undefined : 'rotate-180'} />
        <span>Collapse</span>
      </button>
    </aside>
  );
}
