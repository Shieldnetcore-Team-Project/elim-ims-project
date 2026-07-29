import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import { api, apiPost } from '../../lib/apiClient';
import { naira, number } from '../../lib/format';
import { useUi, useRegisterSearchFocus } from '../../lib/uiState';
import { Card } from '../../components/ui/Card';
import { KpiRow } from '../../components/ui/KpiCard';
import { Pill } from '../../components/ui/Pill';
import { Modal } from '../../components/ui/Modal';
import { EmptyState } from '../../components/ui/EmptyState';
import { PrintHeader } from '../../components/ui/PrintHeader';
import { DeleteButton } from '../../components/ui/DeleteButton';
import { NumberInput } from '../../components/ui/NumberInput';
import { usePendingDeletions } from '../../lib/pendingDeletions';

interface Balance {
  id: string; name: string; category: string; type: string; uom: string;
  reorder_point: number; unit_cost: number; on_hand: number;
}

function statusFor(b: Balance): string {
  if (b.on_hand <= 0) return 'OUT_OF_STOCK';
  if (b.on_hand < b.reorder_point) return 'LOW_STOCK';
  return 'IN_STOCK';
}

export default function InventoryPage() {
  const ui = useUi();
  const [balances, setBalances] = useState<Balance[]>([]);
  const [query, setQuery] = useState('');
  const [reloadKey, setReloadKey] = useState(0);
  const [adjustTarget, setAdjustTarget] = useState<Balance | null>(null);

  const refresh = useCallback(() => setReloadKey(k => k + 1), []);
  useRegisterSearchFocus(useCallback(() => document.getElementById('inv-search')?.focus(), []));
  const pendingDeletions = usePendingDeletions('items', reloadKey);

  useEffect(() => { api<Balance[]>('/inventory/balances').then(setBalances); }, [reloadKey]);

  const rows = useMemo(() => {
    const q = query.trim().toLowerCase();
    return balances.filter(b => !q || b.name.toLowerCase().includes(q) || b.category.toLowerCase().includes(q) || b.id.toLowerCase().includes(q));
  }, [balances, query]);

  const kpis = useMemo(() => [
    { key: 'total', label: 'Total SKUs', icon: 'box' as const, value: number(balances.length) },
    { key: 'value', label: 'Inventory value', icon: 'chart' as const, value: naira(balances.reduce((s, b) => s + b.on_hand * b.unit_cost, 0)) },
    { key: 'low', label: 'Low stock', icon: 'clock' as const, value: number(balances.filter(b => statusFor(b) === 'LOW_STOCK').length) },
    { key: 'out', label: 'Out of stock', icon: 'box' as const, value: number(balances.filter(b => statusFor(b) === 'OUT_OF_STOCK').length) },
  ], [balances]);

  return (
    <>
      <PrintHeader />
      <div className="pagehead">
        <div><h1>Inventory</h1><p className="pagesub">Stock on hand, derived from every transaction ever posted against it. Click a row to adjust.</p></div>
      </div>

      <div className="filters no-print">
        <div className="searchfield">
          <input id="inv-search" type="search" value={query} onChange={e => setQuery(e.target.value)} placeholder="Search SKU, item or category" aria-label="Search inventory" />
          <kbd>/</kbd>
        </div>
      </div>

      <KpiRow kpis={kpis} />

      <Card title="Stock on hand" description={`${rows.length} of ${balances.length} items shown.`}>
        <div style={{ overflowX: 'auto' }}>
          <table>
            <thead><tr><th>SKU</th><th>Item</th><th>Category</th><th className="num">On hand</th><th className="num">Reorder at</th><th>Status</th><th className="no-print" /></tr></thead>
            <tbody>
              {rows.map(b => (
                <tr key={b.id} className="row-clickable" onClick={() => setAdjustTarget(b)}>
                  <td className="mono" style={{ fontSize: 12, color: 'rgb(var(--aqua-700))' }}>{b.id}</td>
                  <td style={{ fontWeight: 500 }}>{b.name}</td>
                  <td className="sub">{b.category}</td>
                  <td className="num tnum">{b.on_hand.toLocaleString('en-NG')} {b.uom}</td>
                  <td className="num tnum">{b.reorder_point.toLocaleString('en-NG')}</td>
                  <td><Pill status={statusFor(b)} /></td>
                  <td className="no-print">
                    <DeleteButton entityType="items" entityId={b.id} entityLabel={b.name} pending={pendingDeletions.has(b.id)} onRequested={() => { refresh(); ui.toast('Deletion requested — pending admin approval'); }} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {rows.length === 0 && <EmptyState title="No items match that" description="Try a different search term." onClear={() => setQuery('')} />}
      </Card>

      {adjustTarget && (
        <AdjustStock
          item={adjustTarget}
          onClose={() => setAdjustTarget(null)}
          onAdjusted={() => { setAdjustTarget(null); refresh(); ui.toast(`${adjustTarget.name} adjusted`); }}
        />
      )}
    </>
  );
}

function AdjustStock({ item, onClose, onAdjusted }: { item: Balance; onClose: () => void; onAdjusted: () => void }) {
  const [delta, setDelta] = useState('');
  const [note, setNote] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setSaving(true); setError(null);
    try {
      await apiPost('/inventory/adjust', { itemId: item.id, delta: Number(delta), note });
      onAdjusted();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong');
    } finally { setSaving(false); }
  }

  return (
    <Modal title={`Adjust stock — ${item.name}`} onClose={onClose} onSubmit={submit} submitLabel="Post adjustment" saving={saving} error={error}>
      <p className="sub" style={{ marginBottom: 14 }}>Currently {item.on_hand.toLocaleString('en-NG')} {item.uom} on hand ({item.id}).</p>
      <div className="form-row">
        <label htmlFor="adj-delta">Change (use a negative number to remove stock)</label>
        <NumberInput id="adj-delta" allowDecimal={false} allowNegative value={delta} onChange={setDelta} placeholder="e.g. -12 or 50" required autoFocus />
      </div>
      <div className="form-row">
        <label htmlFor="adj-note">Reason</label>
        <input id="adj-note" value={note} onChange={e => setNote(e.target.value)} placeholder="e.g. Cycle count correction" required />
      </div>
      <p className="sub">This posts a real ADJUSTMENT transaction to the inventory ledger — it isn't a direct edit of the on-hand figure.</p>
    </Modal>
  );
}
