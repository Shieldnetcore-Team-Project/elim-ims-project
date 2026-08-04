import { useState, type CSSProperties, type ReactNode } from 'react';

// Tells descendant .card-head elements how far down the sticky tab bar pushes
// them — inherited through any wrapper/fragment, so pages can nest content
// however they like without hand-tuning each Card's offset.
const STICKY_CARD_TOP = { '--sticky-card-top': '108px' } as CSSProperties;

export function Tabs({ tabs }: { tabs: { key: string; label: string; content: ReactNode; badge?: number }[] }) {
  const [active, setActive] = useState(tabs[0]?.key);
  const current = tabs.find(t => t.key === active) ?? tabs[0];

  return (
    <div>
      <div className="tabs no-print" role="tablist">
        {tabs.map(t => (
          <button key={t.key} role="tab" aria-selected={t.key === active} className={`tab${t.key === active ? ' active' : ''}`} onClick={() => setActive(t.key)}>
            {t.label}
            {!!t.badge && (
              <span className="tab-badge" aria-label={`${t.badge} need${t.badge === 1 ? 's' : ''} attention`}>
                {t.badge > 99 ? '99+' : t.badge}
              </span>
            )}
          </button>
        ))}
      </div>
      <div style={STICKY_CARD_TOP}>{current?.content}</div>
    </div>
  );
}
