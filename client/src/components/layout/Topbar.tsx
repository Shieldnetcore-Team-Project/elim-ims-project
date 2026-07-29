import { useEffect, useState } from 'react';
import { Icon } from '../ui/Icon';
import { useUi } from '../../lib/uiState';
import { useCurrentUser } from '../../lib/currentUser';
import { todayLagos } from '../../lib/format';
import type { ThemePref } from '../../lib/theme';
import { SignInAsPicker } from './SignInAsPicker';

const THEME_OPTIONS: { value: ThemePref; icon: 'sun' | 'moon' | 'monitor'; label: string }[] = [
  { value: 'light', icon: 'sun', label: 'Light' },
  { value: 'dark', icon: 'moon', label: 'Dark' },
  { value: 'system', icon: 'monitor', label: 'System' },
];

function initials(name: string): string {
  return name.split(' ').map(p => p[0]).filter(Boolean).slice(0, 2).join('').toUpperCase();
}

export function Topbar() {
  const ui = useUi();
  const { user } = useCurrentUser();
  const [today, setToday] = useState('');
  const [pickerOpen, setPickerOpen] = useState(false);
  useEffect(() => { setToday(todayLagos.format(new Date())); }, []);

  return (
    <header className="topbar">
      <button className="iconbtn menubtn" onClick={ui.openDrawer} aria-label="Open navigation">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
          <path d="M4 12h16M4 6h16M4 18h16" />
        </svg>
      </button>

      <button className="searchbtn" onClick={ui.openPalette}>
        <Icon name="search" size={16} />
        <span style={{ flex: 1 }}>Search orders, batches, customers</span>
        <kbd>⌘K</kbd>
      </button>

      <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 12 }}>
        <span className="mono datewrap" style={{ fontSize: 12, color: 'rgb(var(--muted))' }}>{today}</span>

        <div className="seg segwrap" role="radiogroup" aria-label="Colour theme">
          {THEME_OPTIONS.map(opt => (
            <button
              key={opt.value} role="radio" aria-checked={ui.themePref === opt.value}
              aria-label={opt.label} title={opt.label} onClick={() => ui.setTheme(opt.value)}
            >
              <Icon name={opt.icon} size={14} />
            </button>
          ))}
        </div>

        <button
          className="iconbtn" style={{ position: 'relative' }} aria-label="3 unread notifications"
          onClick={() => ui.toast('Notifications arrive in a future module.')}
        >
          <Icon name="bell" size={18} />
          <span style={{ position: 'absolute', right: 7, top: 7, width: 8, height: 8, borderRadius: 999, background: 'rgb(var(--stop))', boxShadow: '0 0 0 2px rgb(var(--card))' }} />
        </button>

        <div style={{ width: 1, height: 24, background: 'rgb(var(--line))' }} />

        <button
          style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '4px 8px 4px 4px', borderRadius: 8 }}
          onClick={() => setPickerOpen(true)}
          title="Switch user"
        >
          <span style={{ width: 32, height: 32, borderRadius: 999, background: 'rgb(var(--ink-700))', color: '#fff', display: 'grid', placeItems: 'center', fontFamily: "'Plus Jakarta Sans'", fontSize: 12, fontWeight: 600 }}>
            {user ? initials(user.name) : '…'}
          </span>
          <span style={{ textAlign: 'left', lineHeight: 1.25 }} className="datewrap">
            <span style={{ display: 'block', fontSize: 12, fontWeight: 600 }}>{user?.name ?? 'Loading…'}</span>
            <span style={{ display: 'block', fontSize: 11, color: 'rgb(var(--muted))' }}>{user?.role ?? ''}</span>
          </span>
          <Icon name="switch" size={14} className="muted-icon" />
        </button>
      </div>

      {pickerOpen && <SignInAsPicker onClose={() => setPickerOpen(false)} />}
    </header>
  );
}
