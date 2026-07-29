import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { NAV_GROUPS, ADMIN_ONLY_NAV_KEYS } from '@shared/moduleConfig';
import { Icon } from '../ui/Icon';
import { useUi } from '../../lib/uiState';
import { useCurrentUser } from '../../lib/currentUser';

interface Command { id: string; label: string; group: string; hint?: string; run: () => void }

export function CommandPalette() {
  const ui = useUi();
  const navigate = useNavigate();
  const { isSuperAdmin, hasAccess } = useCurrentUser();
  const [query, setQuery] = useState('');
  const [index, setIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  const commands = useMemo<Command[]>(() => {
    const navCommands = NAV_GROUPS.flatMap(g => g.items)
      .filter(item => ADMIN_ONLY_NAV_KEYS.includes(item.key) ? isSuperAdmin : (isSuperAdmin || hasAccess(item.key)))
      .map(item => ({
        id: 'nav:' + item.key, label: item.label, group: item.group,
        hint: item.moduleNo ? 'Module ' + String(item.moduleNo).padStart(2, '0') : undefined,
        run: () => navigate(item.path),
      }));
    return [
      ...navCommands,
      { id: 'theme', label: 'Switch theme', group: 'Preferences', run: ui.toggleTheme },
      { id: 'print', label: 'Print this page', group: 'Preferences', run: () => window.print() },
      { id: 'export', label: 'Export the current view as CSV', group: 'Records', run: ui.runExport },
      { id: 'shortcuts', label: 'Show keyboard shortcuts', group: 'General', run: ui.openHelp },
    ];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [navigate, ui.toggleTheme, ui.runExport, ui.openHelp, isSuperAdmin, hasAccess]);

  const results = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return commands;
    return commands.filter(c => c.label.toLowerCase().includes(q) || c.group.toLowerCase().includes(q));
  }, [commands, query]);

  useEffect(() => { if (index >= results.length) setIndex(0); }, [results, index]);

  useEffect(() => {
    if (ui.paletteOpen) { setQuery(''); setIndex(0); requestAnimationFrame(() => inputRef.current?.focus()); }
  }, [ui.paletteOpen]);

  if (!ui.paletteOpen) return null;

  function run(i: number) {
    const c = results[i];
    ui.closePalette();
    c?.run();
  }

  return (
    <div className="overlay" onClick={e => { if (e.target === e.currentTarget) ui.closePalette(); }}>
      <div className="palette" role="dialog" aria-modal="true" aria-label="Command palette">
        <div className="palette-input">
          <Icon name="search" size={16} className="muted-icon" />
          <input
            ref={inputRef}
            value={query}
            onChange={e => { setQuery(e.target.value); setIndex(0); }}
            placeholder="Go to a screen, or run a command"
            aria-label="Search commands"
            onKeyDown={e => {
              if (e.key === 'ArrowDown') { e.preventDefault(); setIndex(i => (i + 1) % Math.max(results.length, 1)); }
              if (e.key === 'ArrowUp') { e.preventDefault(); setIndex(i => (i - 1 + results.length) % Math.max(results.length, 1)); }
              if (e.key === 'Enter') { e.preventDefault(); run(index); }
              if (e.key === 'Escape') ui.closePalette();
            }}
          />
          <kbd>esc</kbd>
        </div>
        <ul className="palette-list" role="listbox">
          {results.length === 0 && (
            <li style={{ padding: '32px 12px', textAlign: 'center', fontSize: 13, color: 'rgb(var(--muted))' }}>
              Nothing matches &ldquo;{query}&rdquo;.
            </li>
          )}
          {results.map((c, i) => (
            <li key={c.id}>
              <button
                className={'palette-item' + (i === index ? ' on' : '')}
                role="option"
                aria-selected={i === index}
                onMouseEnter={() => setIndex(i)}
                onClick={() => run(i)}
              >
                <Icon name="arrowRight" size={16} className="muted-icon" />
                <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{c.label}</span>
                <span style={{ fontSize: 11, color: 'rgb(var(--muted))', fontFamily: c.hint ? "'IBM Plex Mono'" : undefined }}>{c.hint || c.group}</span>
              </button>
            </li>
          ))}
        </ul>
        <div className="palette-foot"><span>↑↓ to move</span><span>↵ to open</span><span style={{ marginLeft: 'auto' }}>⌘K anywhere</span></div>
      </div>
    </div>
  );
}
