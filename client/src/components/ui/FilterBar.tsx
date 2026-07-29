import { forwardRef } from 'react';
import { Icon } from './Icon';
import type { ModuleFilterOption } from '@shared/types';

interface FilterBarProps {
  searchValue: string;
  onSearchChange: (v: string) => void;
  searchPlaceholder: string;
  statusValue: string;
  onStatusChange: (v: string) => void;
  statusOptions: ModuleFilterOption[];
  period?: { value: string; onChange: (v: string) => void };
}

export const FilterBar = forwardRef<HTMLInputElement, FilterBarProps>(function FilterBar(
  { searchValue, onSearchChange, searchPlaceholder, statusValue, onStatusChange, statusOptions, period },
  searchRef,
) {
  return (
    <div className="filters no-print">
      <div className="searchfield">
        <span className="ic"><Icon name="search" size={16} /></span>
        <input
          ref={searchRef}
          type="search"
          value={searchValue}
          onChange={e => onSearchChange(e.target.value)}
          placeholder={searchPlaceholder}
          aria-label={searchPlaceholder}
        />
        <kbd>/</kbd>
      </div>

      {period && (
        <select aria-label="Period" value={period.value} onChange={e => period.onChange(e.target.value)}>
          <option value="7d">Last 7 days</option>
          <option value="30d">Last 30 days</option>
          <option value="qtr">This quarter</option>
        </select>
      )}

      <select aria-label="Status" value={statusValue} onChange={e => onStatusChange(e.target.value)}>
        <option value="">All statuses</option>
        {statusOptions.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
    </div>
  );
});
