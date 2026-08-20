import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import { api, apiPost } from '../../lib/apiClient';
import { naira, number } from '../../lib/format';
import { useUi, useRegisterSearchFocus } from '../../lib/uiState';
import { Card } from '../../components/ui/Card';
import { KpiRow } from '../../components/ui/KpiCard';
import { Pill } from '../../components/ui/Pill';
import { Tabs } from '../../components/ui/Tabs';
import { Modal } from '../../components/ui/Modal';
import { EmptyState } from '../../components/ui/EmptyState';
import { PrintHeader } from '../../components/ui/PrintHeader';
import { DeleteButton } from '../../components/ui/DeleteButton';
import { NumberInput } from '../../components/ui/NumberInput';
import { usePendingDeletions } from '../../lib/pendingDeletions';
import { ReportToolbar } from '../../components/ui/ReportToolbar';
import { inRange, type DateRange } from '../../lib/reportExport';
import { exportCsv, type CsvColumn } from '../../lib/csv';
import { Icon } from '../../components/ui/Icon';

interface Balance {
  id: string; name: string; category: string; type: string; uom: string;
  reorder_point: number; unit_cost: number; on_hand: number;
}

interface Transaction {
  id: number; txn_no: string; item_name: string; category: string; unit: string; branch: string;
  source_type: string; direction: 'IN' | 'OUT'; quantity: number; qty_before: number; qty_after: number;
  from_location: string | null; to_location: string | null;
  actor: string | null; note: string | null; status: string; created_at: string;
}

interface StockPositionLine {
  item_id: string; item_name: string; category: string; unit: string;
  physical_stock: number; assigned_stock: number; pending_return: number; available_stock: number;
}

function statusFor(b: Balance): string {
  if (b.on_hand <= 0) return 'OUT_OF_STOCK';
  if (b.on_hand < b.reorder_point) return 'LOW_STOCK';
  return 'IN_STOCK';
}

const titleCase = (s: string) => s.toLowerCase().replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());

export default function InventoryPage() {
  const ui = useUi();
  const [balances, setBalances] = useState<Balance[]>([]);
  const [transactions, setTransactions] = useState<Transaction[]>([]);
  const [stockPosition, setStockPosition] = useState<StockPositionLine[]>([]);
  const [query, setQuery] = useState('');
  const [reloadKey, setReloadKey] = useState(0);
  const [adjustTarget, setAdjustTarget] = useState<Balance | null>(null);
  const [txnRange, setTxnRange] = useState<DateRange | null>(null);

  const refresh = useCallback(() => setReloadKey(k => k + 1), []);
  useRegisterSearchFocus(useCallback(() => document.getElementById('inv-search')?.focus(), []));
  const pendingDeletions = usePendingDeletions('items', reloadKey);

  useEffect(() => {
    api<Balance[]>('/inventory/balances').then(setBalances);
    api<Transaction[]>('/inventory/transactions').then(setTransactions);
    api<StockPositionLine[]>('/inventory/stock-position').then(setStockPosition);
  }, [reloadKey]);

  const stockPositionTotals = useMemo(() => stockPosition.reduce((s, l) => ({
    physical_stock: s.physical_stock + l.physical_stock,
    assigned_stock: s.assigned_stock + l.assigned_stock,
    pending_return: s.pending_return + l.pending_return,
    available_stock: s.available_stock + l.available_stock,
  }), { physical_stock: 0, assigned_stock: 0, pending_return: 0, available_stock: 0 }), [stockPosition]);

  const stockPositionColumns: CsvColumn<StockPositionLine>[] = useMemo(() => [
    { label: 'Item', get: l => l.item_name },
    { label: 'Category', get: l => l.category },
    { label: 'Unit', get: l => l.unit },
    { label: 'Physical Stock', get: l => l.physical_stock },
    { label: 'Assigned Stock', get: l => l.assigned_stock },
    { label: 'Pending Return', get: l => l.pending_return },
    { label: 'Available Stock', get: l => l.available_stock },
  ], []);

  const rows = useMemo(() => {
    const q = query.trim().toLowerCase();
    return balances.filter(b => !q || b.name.toLowerCase().includes(q) || b.category.toLowerCase().includes(q) || b.id.toLowerCase().includes(q));
  }, [balances, query]);

  const filteredTransactions = useMemo(() => transactions.filter(t => inRange(t.created_at, txnRange)), [transactions, txnRange]);
  const txnColumns: CsvColumn<Transaction>[] = useMemo(() => [
    { label: 'Transaction No.', get: t => t.txn_no },
    { label: 'Date & Time', get: t => t.created_at },
    { label: 'Product', get: t => t.item_name },
    { label: 'Category', get: t => t.category },
    { label: 'Unit', get: t => t.unit },
    { label: 'Type', get: t => titleCase(t.source_type) },
    { label: 'Transaction Type', get: t => t.direction === 'IN' ? 'Stock In' : 'Stock Out' },
    { label: 'From', get: t => t.from_location ?? '' },
    { label: 'To', get: t => t.to_location ?? '' },
    { label: 'Qty Before', get: t => t.qty_before },
    { label: 'Qty Changed', get: t => t.direction === 'IN' ? t.quantity : -t.quantity },
    { label: 'Qty After', get: t => t.qty_after },
    { label: 'Performed By', get: t => t.actor ?? '' },
    { label: 'Remarks', get: t => t.note ?? '' },
    { label: 'Status', get: t => t.status },
  ], []);

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

      <KpiRow kpis={kpis} />

      <Tabs tabs={[
        {
          key: 'stock', label: 'General Inventory', content: (
            <>
              <div className="filters no-print">
                <div className="searchfield">
                  <input id="inv-search" type="search" value={query} onChange={e => setQuery(e.target.value)} placeholder="Search SKU, item or category" aria-label="Search inventory" />
                  <kbd>/</kbd>
                </div>
              </div>

              <Card title="General Inventory" description={`${rows.length} of ${balances.length} items shown.`}>
                <div className="table-wrap">
                  <table>
                    <thead><tr><th>SKU</th><th>Item</th><th>Category</th><th>Unit</th><th className="num">Quantity</th><th className="num">Reorder at</th><th className="num">Value</th><th>Status</th><th className="no-print" /></tr></thead>
                    <tbody>
                      {rows.map(b => (
                        <tr key={b.id} className="row-clickable" onClick={() => setAdjustTarget(b)}>
                          <td className="mono" style={{ fontSize: 12, color: 'rgb(var(--aqua-700))' }}>{b.id}</td>
                          <td style={{ fontWeight: 500 }}>{b.name}</td>
                          <td className="sub">{b.category}</td>
                          <td className="sub">{b.uom}</td>
                          <td className="num tnum">{b.on_hand.toLocaleString('en-NG')}</td>
                          <td className="num tnum">{b.reorder_point.toLocaleString('en-NG')}</td>
                          <td className="num tnum">{naira(b.on_hand * b.unit_cost)}</td>
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
            </>
          ),
        },
        {
          key: 'stock-position', label: 'Stock Position', content: (
            <Card
              title="Stock Position"
              description="Physical, Assigned, Pending Return and Available stock for every finished good — kept as four separate figures, never collapsed into one balance, so it's clear why physical stock and system availability can temporarily differ (e.g. a marketer return claimed but not yet physically received)."
            >
              <div className="no-print" style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 12 }}>
                <button type="button" className="btn btn-secondary btn-sm" onClick={() => exportCsv('elim-stock-position.csv', stockPositionColumns, stockPosition)}>
                  <Icon name="table" size={14} /> CSV
                </button>
              </div>
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>Item</th><th>Category</th><th>Unit</th>
                      <th className="num">Physical Stock</th><th className="num">Assigned Stock</th>
                      <th className="num">Pending Return</th><th className="num">Available Stock</th>
                    </tr>
                  </thead>
                  <tbody>
                    {stockPosition.map(l => (
                      <tr key={l.item_id}>
                        <td style={{ fontWeight: 500 }}>{l.item_name}</td>
                        <td className="sub">{l.category}</td>
                        <td className="sub">{l.unit}</td>
                        <td className="num tnum">{l.physical_stock.toLocaleString('en-NG')}</td>
                        <td className="num tnum">{l.assigned_stock.toLocaleString('en-NG')}</td>
                        <td className="num tnum">{l.pending_return > 0 ? l.pending_return.toLocaleString('en-NG') : '—'}</td>
                        <td className="num tnum">{l.available_stock.toLocaleString('en-NG')}</td>
                      </tr>
                    ))}
                  </tbody>
                  {stockPosition.length > 0 && (
                    <tfoot>
                      <tr>
                        <td colSpan={3} style={{ fontWeight: 600 }}>Total</td>
                        <td className="num tnum" style={{ fontWeight: 600 }}>{stockPositionTotals.physical_stock.toLocaleString('en-NG')}</td>
                        <td className="num tnum" style={{ fontWeight: 600 }}>{stockPositionTotals.assigned_stock.toLocaleString('en-NG')}</td>
                        <td className="num tnum" style={{ fontWeight: 600 }}>{stockPositionTotals.pending_return.toLocaleString('en-NG')}</td>
                        <td className="num tnum" style={{ fontWeight: 600 }}>{stockPositionTotals.available_stock.toLocaleString('en-NG')}</td>
                      </tr>
                    </tfoot>
                  )}
                </table>
              </div>
              {stockPosition.length === 0 && <EmptyState title="No finished goods yet" description="Stock position tracks finished goods once they exist as items." onClear={() => {}} />}
            </Card>
          ),
        },
        {
          key: 'transactions', label: 'Inventory Transactions', content: (
            <Card title="Inventory Transactions" description={`${filteredTransactions.length} of ${transactions.length} transactions shown.`}>
              <ReportToolbar rows={filteredTransactions} columns={txnColumns} filenameBase="elim-inventory-transactions" onRangeChange={setTxnRange} />
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>Transaction No.</th><th>Date &amp; Time</th><th>Product</th><th>Category</th><th>Unit</th>
                      <th>Type</th><th>Transaction Type</th><th>From</th><th>To</th><th className="num">Qty Before</th><th className="num">Qty Changed</th>
                      <th className="num">Qty After</th><th>Performed By</th><th>Remarks</th><th>Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filteredTransactions.map(t => {
                      const changed = t.direction === 'IN' ? t.quantity : -t.quantity;
                      return (
                        <tr key={t.id}>
                          <td className="mono" style={{ fontSize: 12, color: 'rgb(var(--aqua-700))' }}>{t.txn_no}</td>
                          <td className="sub">{t.created_at}</td>
                          <td style={{ fontWeight: 500 }}>{t.item_name}</td>
                          <td className="sub">{t.category}</td>
                          <td className="sub">{t.unit}</td>
                          <td className="sub">{titleCase(t.source_type)}</td>
                          <td>{t.direction === 'IN' ? 'Stock In' : 'Stock Out'}</td>
                          <td className="sub">{t.from_location ?? '—'}</td>
                          <td className="sub">{t.to_location ?? '—'}</td>
                          <td className="num tnum">{t.qty_before.toLocaleString('en-NG')}</td>
                          <td className="num tnum">{changed > 0 ? '+' : ''}{changed.toLocaleString('en-NG')}</td>
                          <td className="num tnum">{t.qty_after.toLocaleString('en-NG')}</td>
                          <td>{t.actor ?? '—'}</td>
                          <td className="sub">{t.note ?? '—'}</td>
                          <td><Pill status={t.status} /></td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              {filteredTransactions.length === 0 && <EmptyState title="No transactions match that range" description="Transactions appear once stock moves in or out." onClear={() => {}} />}
            </Card>
          ),
        },
      ]} />

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
