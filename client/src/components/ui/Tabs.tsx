import { useState, type ReactNode } from 'react';

export function Tabs({ tabs }: { tabs: { key: string; label: string; content: ReactNode }[] }) {
  const [active, setActive] = useState(tabs[0]?.key);
  const current = tabs.find(t => t.key === active) ?? tabs[0];

  return (
    <div>
      <div className="tabs no-print" role="tablist">
        {tabs.map(t => (
          <button key={t.key} role="tab" aria-selected={t.key === active} className={`tab${t.key === active ? ' active' : ''}`} onClick={() => setActive(t.key)}>
            {t.label}
          </button>
        ))}
      </div>
      {current?.content}
    </div>
  );
}
