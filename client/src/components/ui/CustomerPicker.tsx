import { useEffect, useMemo, useRef, useState } from 'react';
import { apiPost } from '../../lib/apiClient';
import { Icon } from './Icon';

export type PickableCustomerType = 'RETAIL' | 'MARKETER' | 'DISTRIBUTOR';
export interface PickableCustomer {
  id: string; name: string; location?: string | null; customer_type?: PickableCustomerType;
}

/** Searchable customer field with inline "add new" — type a name, pick a match,
 *  or create the customer on the spot. A created customer is persisted to
 *  /masters/customers straight away (so it shows on the Customers page) and is
 *  selected immediately; `onCreated` lets the parent refetch its master list. */
export function CustomerPicker({
  customers, value, onChange, onCreated,
  createType = 'MARKETER', allowCreate = true, id, placeholder,
}: {
  customers: PickableCustomer[];
  value: string;
  onChange: (id: string) => void;
  onCreated?: (created: PickableCustomer) => void;
  createType?: PickableCustomerType;
  allowCreate?: boolean;
  id?: string;
  placeholder?: string;
}) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Customers created here, kept until the parent's refetch catches up so the
  // selection resolves to a real name with no flicker.
  const [extra, setExtra] = useState<PickableCustomer[]>([]);
  const wrapRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const all = useMemo(() => {
    const seen = new Set(customers.map(c => c.id));
    return [...customers, ...extra.filter(c => !seen.has(c.id))];
  }, [customers, extra]);

  const selected = all.find(c => c.id === value) ?? null;
  const q = search.trim().toLowerCase();
  const matches = useMemo(
    () => (q ? all.filter(c => c.name.toLowerCase().includes(q)) : all).slice(0, 50),
    [all, q],
  );
  const exactExists = all.some(c => c.name.trim().toLowerCase() === q);
  const canOfferCreate = allowCreate && q.length > 0 && !exactExists;

  useEffect(() => {
    if (!open) return;
    // Focus the search box ourselves — `autoFocus` inside a modal can lose the
    // race with the dialog, leaving keystrokes to fall through to the app's
    // global keyboard shortcuts instead of the field.
    const raf = requestAnimationFrame(() => inputRef.current?.focus());
    function onDocMouseDown(e: MouseEvent) {
      if (wrapRef.current && e.target instanceof Node && !wrapRef.current.contains(e.target)) {
        setOpen(false); setSearch(''); setError(null);
      }
    }
    document.addEventListener('mousedown', onDocMouseDown);
    return () => { cancelAnimationFrame(raf); document.removeEventListener('mousedown', onDocMouseDown); };
  }, [open]);

  function pick(c: PickableCustomer) {
    onChange(c.id);
    setOpen(false); setSearch(''); setError(null);
  }

  async function createFromSearch() {
    const name = search.trim();
    if (!name || creating) return;
    setCreating(true); setError(null);
    try {
      const created = await apiPost<PickableCustomer>('/masters/customers', { name, customerType: createType });
      setExtra(xs => [...xs, created]);
      onChange(created.id);
      onCreated?.(created);
      setOpen(false); setSearch('');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not add customer');
    } finally {
      setCreating(false);
    }
  }

  return (
    <div className="customer-picker" ref={wrapRef}>
      <button
        type="button" id={id} className="customer-picker-trigger"
        aria-haspopup="listbox" aria-expanded={open}
        onClick={e => { e.stopPropagation(); setOpen(o => !o); }}
      >
        <span className={selected ? undefined : 'sub'}>
          {selected
            ? selected.name
            : (placeholder ?? (customers.length === 0 ? 'No customers yet — type to add one' : 'Select or search a customer'))}
        </span>
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <path d="m6 9 6 6 6-6" />
        </svg>
      </button>

      {open && (
        <div
          className="customer-picker-pop" role="listbox"
          // Keep keystrokes here from reaching the app's global keyboard
          // shortcuts (uiState.tsx) when focus briefly isn't on the input.
          onKeyDown={e => {
            e.stopPropagation();
            if (e.key === 'Escape') { e.preventDefault(); setOpen(false); setSearch(''); }
          }}
        >
          <div className="customer-picker-search">
            <Icon name="search" size={14} className="muted-icon" />
            <input
              ref={inputRef} type="search" value={search} placeholder="Search customer name…"
              onChange={e => setSearch(e.target.value)}
              onKeyDown={e => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  if (matches.length === 1) pick(matches[0]);
                  else if (canOfferCreate) createFromSearch();
                }
              }}
            />
          </div>
          <div className="customer-picker-list">
            {matches.map(c => (
              <button
                type="button" key={c.id} role="option" aria-selected={c.id === value}
                className={`customer-picker-opt${c.id === value ? ' is-selected' : ''}`}
                onClick={() => pick(c)}
              >
                <span>{c.name}</span>
                {c.customer_type && <span className="sub" style={{ fontSize: 11 }}>{c.customer_type.toLowerCase()}</span>}
              </button>
            ))}
            {matches.length === 0 && !canOfferCreate && (
              <p className="sub" style={{ padding: '8px 10px' }}>
                {q ? 'No matching customer.' : (allowCreate ? 'Type a name to search or add a new customer.' : 'No customers available.')}
              </p>
            )}
            {canOfferCreate && (
              <button
                type="button" className="customer-picker-opt customer-picker-add"
                onClick={createFromSearch} disabled={creating}
              >
                <Icon name="plus" size={13} />
                <span>{creating ? 'Adding…' : `Add “${search.trim()}” as new ${createType.toLowerCase()}`}</span>
              </button>
            )}
          </div>
          {error && <p className="sub customer-picker-error">{error}</p>}
        </div>
      )}
    </div>
  );
}
