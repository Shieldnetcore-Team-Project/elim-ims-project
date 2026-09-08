import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../../lib/apiClient';
import { number } from '../../lib/format';
import { Card } from '../../components/ui/Card';
import { KpiRow } from '../../components/ui/KpiCard';
import { EmptyState } from '../../components/ui/EmptyState';
import { PrintHeader } from '../../components/ui/PrintHeader';
import { Icon } from '../../components/ui/Icon';

interface StockPositionLine {
  item_id: string; item_name: string; category: string; unit: string;
  physical_stock: number; assigned_stock: number; pending_return: number; available_stock: number;
}

export default function StorePage() {
  const [stock, setStock] = useState<StockPositionLine[]>([]);
  const [query, setQuery] = useState('');

  useEffect(() => {
    api<StockPositionLine[]>('/inventory/stock-position').then(setStock);
  }, []);

  const rows = useMemo(() => {
    const q = query.trim().toLowerCase();
    return stock.filter(l => !q || l.item_name.toLowerCase().includes(q) || l.category.toLowerCase().includes(q));
  }, [stock, query]);

  const totals = useMemo(() => stock.reduce((s, l) => ({
    physical: s.physical + l.physical_stock,
    assigned: s.assigned + l.assigned_stock,
    available: s.available + l.available_stock,
  }), { physical: 0, assigned: 0, available: 0 }), [stock]);

  const kpis = [
    { key: 'skus', label: 'Finished good SKUs', icon: 'box' as const, value: number(stock.length) },
    { key: 'physical', label: 'Physical stock', icon: 'warehouse' as const, value: number(totals.physical) },
    { key: 'assigned', label: 'Assigned out', icon: 'truck' as const, value: number(totals.assigned) },
    { key: 'available', label: 'Available to assign', icon: 'cart' as const, value: number(totals.available) },
  ];

  return (
    <>
      <PrintHeader />
      <div className="pagehead">
        <div>
          <h1>Store</h1>
          <p className="pagesub">Finished goods on hand, ready to assign out to a Distributor, Sales Rep, or Walk-in customer.</p>
        </div>
      </div>

      <KpiRow kpis={kpis} />

      <div className="filters no-print">
        <div className="searchfield">
          <input id="store-search" type="search" value={query} onChange={e => setQuery(e.target.value)} placeholder="Search finished goods" aria-label="Search finished goods" />
          <kbd>/</kbd>
        </div>
      </div>

      <Card title="Finished goods" description={`${rows.length} of ${stock.length} item(s) shown.`}>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Item</th><th>Category</th><th>Unit</th>
                <th className="num">Physical stock</th><th className="num">Assigned</th><th className="num">Available</th>
                <th className="no-print">Assign</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(l => (
                <tr key={l.item_id}>
                  <td style={{ fontWeight: 500 }}>{l.item_name}</td>
                  <td className="sub">{l.category}</td>
                  <td className="sub">{l.unit}</td>
                  <td className="num tnum">{l.physical_stock.toLocaleString('en-NG')}</td>
                  <td className="num tnum">{l.assigned_stock.toLocaleString('en-NG')}</td>
                  <td className="num tnum">{l.available_stock.toLocaleString('en-NG')}</td>
                  <td className="no-print"><AssignMenu itemId={l.item_id} disabled={l.available_stock <= 0} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {rows.length === 0 && <EmptyState title="No finished goods yet" description="Finished goods appear here once a production batch is packaged." onClear={() => setQuery('')} />}
      </Card>
    </>
  );
}

function AssignMenu({ itemId, disabled }: { itemId: string; disabled: boolean }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const navigate = useNavigate();

  useEffect(() => {
    function onMouseDown(e: MouseEvent) {
      if (ref.current && e.target instanceof Node && !ref.current.contains(e.target)) setOpen(false);
    }
    document.addEventListener('mousedown', onMouseDown);
    return () => document.removeEventListener('mousedown', onMouseDown);
  }, []);

  function go(path: string) {
    setOpen(false);
    navigate(path);
  }

  return (
    <div style={{ position: 'relative' }} ref={ref}>
      <button type="button" className="btn btn-secondary btn-sm" aria-haspopup="menu" aria-expanded={open} disabled={disabled} onClick={() => setOpen(o => !o)}>
        Assign <Icon name="chevronRight" size={12} className={open ? 'rotate-180' : undefined} />
      </button>
      {open && (
        <div className="menu" role="menu">
          <button role="menuitem" onClick={() => go(`/sales?tab=orders&assignItem=${encodeURIComponent(itemId)}`)}>
            <Icon name="truck" size={16} className="muted-icon" />
            <span><span style={{ display: 'block', fontSize: 13 }}>Distributor</span><span style={{ display: 'block', fontSize: 11, color: 'rgb(var(--muted))' }}>Opens a new sales order</span></span>
          </button>
          <button role="menuitem" onClick={() => go(`/sales?tab=marketer-stock&assignItem=${encodeURIComponent(itemId)}`)}>
            <Icon name="users" size={16} className="muted-icon" />
            <span><span style={{ display: 'block', fontSize: 13 }}>Sales rep</span><span style={{ display: 'block', fontSize: 11, color: 'rgb(var(--muted))' }}>Issues stock on consignment</span></span>
          </button>
          <button role="menuitem" onClick={() => go(`/pos?tab=retail-stock&assignItem=${encodeURIComponent(itemId)}`)}>
            <Icon name="wallet" size={16} className="muted-icon" />
            <span><span style={{ display: 'block', fontSize: 13 }}>Walk-in customer</span><span style={{ display: 'block', fontSize: 11, color: 'rgb(var(--muted))' }}>Posts an intake to Retail</span></span>
          </button>
        </div>
      )}
    </div>
  );
}
