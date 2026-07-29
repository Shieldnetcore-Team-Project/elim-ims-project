import { Icon } from './Icon';

export interface FilterChip { id: string; label: string; value: string }

export function Chips({ chips, onRemove, onClearAll }: { chips: FilterChip[]; onRemove: (id: string) => void; onClearAll: () => void }) {
  if (chips.length === 0) return null;
  return (
    <div className="chips no-print">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" style={{ color: 'rgb(var(--muted))' }}>
        <path d="M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3M1 14h6M9 8h6M17 16h6" />
      </svg>
      {chips.map(c => (
        <span className="chip" key={c.id}>
          <span style={{ color: 'rgb(var(--muted))' }}>{c.label}:</span>
          <span style={{ fontWeight: 500 }}>{c.value}</span>
          <button onClick={() => onRemove(c.id)} aria-label={`Remove ${c.label} filter`}>
            <Icon name="x" size={12} />
          </button>
        </span>
      ))}
      {chips.length > 1 && (
        <button className="btn btn-sm" style={{ height: 24, fontSize: 11, color: 'rgb(var(--muted))' }} onClick={onClearAll}>Clear all</button>
      )}
    </div>
  );
}
