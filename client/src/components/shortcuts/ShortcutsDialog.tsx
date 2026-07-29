import { Icon } from '../ui/Icon';
import { useUi } from '../../lib/uiState';

const SHORTCUTS = [
  { group: 'Navigation', items: [
    { keys: ['⌘', 'K'], label: 'Open the command palette' },
    { keys: ['/'], label: 'Focus the search box' },
    { keys: ['?'], label: 'Show this list' },
  ] },
  { group: 'Records', items: [
    { keys: ['E'], label: 'Export the current list' },
    { keys: ['T'], label: 'Toggle light and dark' },
    { keys: ['⌘', 'P'], label: 'Print the current page' },
  ] },
  { group: 'General', items: [{ keys: ['Esc'], label: 'Close a dialog or menu' }] },
];

export function ShortcutsDialog() {
  const ui = useUi();
  if (!ui.helpOpen) return null;

  return (
    <div className="overlay" onClick={e => { if (e.target === e.currentTarget) ui.closeHelp(); }}>
      <div className="dialog" role="dialog" aria-modal="true" aria-labelledby="helpTitle">
        <div className="dialog-head">
          <h2 id="helpTitle" className="card-title">Keyboard shortcuts</h2>
          <button className="iconbtn" onClick={ui.closeHelp} aria-label="Close" style={{ width: 28, height: 28 }}>
            <Icon name="x" size={16} />
          </button>
        </div>
        <div style={{ padding: 20, maxHeight: '60vh', overflowY: 'auto' }}>
          {SHORTCUTS.map(g => (
            <section key={g.group} style={{ marginBottom: 20 }}>
              <h3 style={{ fontSize: 11, fontWeight: 600, letterSpacing: '.14em', textTransform: 'uppercase', color: 'rgb(var(--muted))', marginBottom: 8 }}>{g.group}</h3>
              {g.items.map(s => (
                <div key={s.label} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16, padding: '3px 0' }}>
                  <span style={{ fontSize: 13 }}>{s.label}</span>
                  <span style={{ display: 'flex', gap: 4 }}>{s.keys.map(k => <kbd key={k}>{k}</kbd>)}</span>
                </div>
              ))}
            </section>
          ))}
        </div>
        <p style={{ borderTop: '1px solid rgb(var(--line))', padding: '10px 20px', fontSize: 11, color: 'rgb(var(--muted))' }}>
          Shortcuts are ignored while you are typing in a field.
        </p>
      </div>
    </div>
  );
}
