import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import type {
  KpiMetric, ProductVolume, TrendPoint,
  SalesOverviewPoint, ProfitLossPoint, LowStockAlert, TopProduct, StockStatus,
} from '@shared/types';
import { api } from '../../lib/apiClient';
import { useDebouncedValue } from '../../hooks/useDebouncedValue';
import { useRegisterExport, useRegisterSearchFocus, useUi } from '../../lib/uiState';
import { exportCsv } from '../../lib/csv';
import { KpiRow } from '../../components/ui/KpiCard';
import { ChartCard } from '../../components/charts/ChartCard';
import { TrendChart } from '../../components/charts/TrendChart';
import { ComparisonChart } from '../../components/charts/ComparisonChart';
import { SalesOverviewChart } from '../../components/charts/SalesOverviewChart';
import { ProfitLossChart } from '../../components/charts/ProfitLossChart';
import { DonutChart } from '../../components/charts/DonutChart';
import { Card } from '../../components/ui/Card';
import { Pill } from '../../components/ui/Pill';
import { Icon } from '../../components/ui/Icon';
import { EmptyState } from '../../components/ui/EmptyState';
import { ExportMenu } from '../../components/ui/ExportMenu';
import { PrintHeader } from '../../components/ui/PrintHeader';
import { BatchTrace } from './BatchTrace';

interface DeliveryRun {
  id: string; sales_id: string; customer_name: string; customer_location: string;
  driver: string | null; route: string | null; status: string; dispatched_at: string; delivered_at: string | null;
}

export function DashboardPage() {
  const ui = useUi();
  const [kpis, setKpis] = useState<KpiMetric[]>([]);
  const [trend, setTrend] = useState<TrendPoint[]>([]);
  const [byProduct, setByProduct] = useState<ProductVolume[]>([]);
  const [runs, setRuns] = useState<DeliveryRun[]>([]);
  const [salesOverview, setSalesOverview] = useState<SalesOverviewPoint[]>([]);
  const [plPeriod, setPlPeriod] = useState<'7d' | '30d' | 'qtr'>('7d');
  const [profitLoss, setProfitLoss] = useState<ProfitLossPoint[]>([]);
  const [lowStock, setLowStock] = useState<LowStockAlert[]>([]);
  const [topProducts, setTopProducts] = useState<TopProduct[]>([]);
  const [stockStatus, setStockStatus] = useState<StockStatus | null>(null);
  const [query, setQuery] = useState('');
  const debouncedQuery = useDebouncedValue(query, 250);
  const [selectedDelivery, setSelectedDelivery] = useState<string | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    api<KpiMetric[]>('/dashboard/kpis').then(setKpis);
    api<TrendPoint[]>('/dashboard/trend').then(setTrend);
    api<ProductVolume[]>('/dashboard/by-product').then(setByProduct);
    api<DeliveryRun[]>('/deliveries').then(setRuns);
    api<SalesOverviewPoint[]>('/dashboard/sales-overview').then(setSalesOverview);
    api<LowStockAlert[]>('/dashboard/low-stock').then(setLowStock);
    api<TopProduct[]>('/dashboard/top-products').then(setTopProducts);
    api<StockStatus>('/dashboard/stock-status').then(setStockStatus);
  }, []);

  useEffect(() => {
    api<ProfitLossPoint[]>('/dashboard/profit-loss', { period: plPeriod }).then(setProfitLoss);
  }, [plPeriod]);

  const rows = useMemo(() => {
    const q = debouncedQuery.trim().toLowerCase();
    const filtered = q
      ? runs.filter(r => r.id.toLowerCase().includes(q) || r.customer_name.toLowerCase().includes(q) || r.sales_id.toLowerCase().includes(q))
      : runs;
    return filtered.slice(0, 10);
  }, [runs, debouncedQuery]);

  const handleExportCsv = useCallback(() => {
    exportCsv('elim-deliveries.csv', [
      { label: 'Waybill', get: (r: DeliveryRun) => r.id },
      { label: 'Sales order', get: (r: DeliveryRun) => r.sales_id },
      { label: 'Customer', get: (r: DeliveryRun) => r.customer_name },
      { label: 'Location', get: (r: DeliveryRun) => r.customer_location },
      { label: 'Driver', get: (r: DeliveryRun) => r.driver ?? '' },
      { label: 'Status', get: (r: DeliveryRun) => r.status.replace(/_/g, ' ') },
      { label: 'Dispatched', get: (r: DeliveryRun) => r.dispatched_at },
    ], rows);
    ui.toast(`${rows.length} rows exported to elim-deliveries.csv`);
  }, [rows, ui]);

  useRegisterExport(handleExportCsv);
  useRegisterSearchFocus(useCallback(() => searchRef.current?.focus(), []));

  return (
    <>
      <PrintHeader />
      <div className="pagehead">
        <div>
          <h1>Dashboard</h1>
          <p className="pagesub">Plant operations for today — Elim Water Factory, Idu, Abuja.</p>
        </div>
        <div style={{ display: 'flex', gap: 8, position: 'relative' }} className="no-print">
          <ExportMenu onCsv={handleExportCsv} rowCount={rows.length} />
        </div>
      </div>

      <div className="filters no-print">
        <div className="searchfield">
          <input ref={searchRef} type="search" value={query} onChange={e => setQuery(e.target.value)} placeholder="Search deliveries, customers or sales orders" aria-label="Search deliveries" />
          <kbd>/</kbd>
        </div>
      </div>

      <KpiRow kpis={kpis} />

      <div className="grid2">
        <ChartCard title="Output and yield" description="Units filled per day against production yield, last seven days.">
          {trend.length > 0 && <TrendChart data={trend} />}
        </ChartCard>
        <ChartCard title="By product" description="Units filled this week.">
          {byProduct.length > 0 && <ComparisonChart data={byProduct} />}
        </ChartCard>
      </div>

      <div className="grid2">
        <ChartCard title="Sales overview" description="Daily sales against the profit trend, last seven days.">
          {salesOverview.length > 0 && <SalesOverviewChart data={salesOverview} />}
        </ChartCard>
        <Card
          title="Profit & loss analysis"
          description="Revenue less operating expenses over the selected period."
          action={(
            <select aria-label="Period" value={plPeriod} onChange={e => setPlPeriod(e.target.value as '7d' | '30d' | 'qtr')} className="no-print">
              <option value="7d">Last 7 days</option>
              <option value="30d">Last 30 days</option>
              <option value="qtr">This quarter</option>
            </select>
          )}
        >
          <div style={{ padding: 20 }}>
            <div style={{ height: 240, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
              {profitLoss.length > 0 && <ProfitLossChart data={profitLoss} />}
            </div>
          </div>
        </Card>
      </div>

      <div className="grid3">
        <Card
          title="Low stock alerts"
          description="Items at or below their reorder point."
          action={<Link to="/inventory" className="sub no-print">View inventory →</Link>}
        >
          {lowStock.length > 0 ? (
            <>
              <div className="table-wrap">
                <table>
                  <thead><tr><th>Product</th><th className="num">Current stock</th><th>Status</th></tr></thead>
                  <tbody>
                    {lowStock.map(item => (
                      <tr key={item.id}>
                        <td><p style={{ fontWeight: 500, color: 'rgb(var(--ink-900))' }}>{item.name}</p><p className="sub">{item.uom}</p></td>
                        <td className="num tnum">{item.onHand.toLocaleString('en-NG')} / {item.reorderPoint.toLocaleString('en-NG')}</td>
                        <td><Pill status={item.onHand <= 0 ? 'OUT_OF_STOCK' : 'LOW_STOCK'} /></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div style={{ padding: '4px 20px 20px' }} className="no-print">
                <Link to="/procurement" className="btn btn-secondary btn-sm" style={{ width: '100%', justifyContent: 'center' }}>
                  Restock needed
                </Link>
              </div>
            </>
          ) : (
            <EmptyState title="Nothing low on stock" description="Every item is above its reorder point." onClear={() => {}} />
          )}
        </Card>

        <Card title="Top selling products" description="Units sold, last 30 days.">
          {topProducts.length > 0 ? (
            <div style={{ padding: 20, display: 'grid', gap: 4 }}>
              {topProducts.map(p => (
                <div key={p.id} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '8px 0', borderBottom: '1px solid rgb(var(--line))' }}>
                  <span className="kpi-tile"><Icon name="box" size={16} /></span>
                  <p style={{ flex: 1, fontWeight: 500, color: 'rgb(var(--ink-900))' }}>{p.name}</p>
                  <p className="sub tnum">{p.unitsSold.toLocaleString('en-NG')} sold</p>
                </div>
              ))}
            </div>
          ) : (
            <EmptyState title="No sales yet" description="Top sellers show up once orders start shipping." onClear={() => {}} />
          )}
        </Card>

        <ChartCard title="Stock status" description="Share of items in each stock state.">
          {stockStatus && (
            <DonutChart data={[
              { label: 'In stock', value: stockStatus.inStock, tone: 'ok' },
              { label: 'Low stock', value: stockStatus.lowStock, tone: 'wait' },
              { label: 'Out of stock', value: stockStatus.outOfStock, tone: 'stop' },
            ]} />
          )}
        </ChartCard>
      </div>

      {selectedDelivery && <BatchTrace deliveryId={selectedDelivery} onClose={() => setSelectedDelivery(null)} />}

      <section className="card" style={{ marginTop: 24 }}>
        <div className="card-head">
          <div><h2 className="card-title">Recent deliveries</h2><p className="card-desc">Dispatched from Fleet &amp; delivery. Click a row to trace it.</p></div>
          <Link to="/fleet" className="sub no-print">View all in Fleet &amp; delivery →</Link>
        </div>
        <div className="table-wrap">
          <table>
            <thead>
              <tr><th>Waybill</th><th>Customer</th><th>Sales order</th><th>Driver</th><th>Dispatched</th><th>Status</th></tr>
            </thead>
            <tbody>
              {rows.map(r => (
                <tr key={r.id} className="row-clickable" onClick={() => setSelectedDelivery(r.id)}>
                  <td><span className="mono" style={{ fontSize: 12, color: 'rgb(var(--aqua-700))' }}>{r.id}</span></td>
                  <td><p style={{ fontWeight: 500, color: 'rgb(var(--ink-900))' }}>{r.customer_name}</p><p className="sub">{r.route ?? r.customer_location}</p></td>
                  <td className="mono" style={{ fontSize: 12 }}>{r.sales_id}</td>
                  <td>{r.driver}</td>
                  <td className="sub">{r.dispatched_at}</td>
                  <td><Pill status={r.status} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {rows.length === 0 && (
          <EmptyState
            title="No deliveries match that"
            description="Dispatch a sales order from Fleet & delivery, or try a different search."
            onClear={() => setQuery('')}
          />
        )}
        <div className="tfoot no-print">
          <p className="sub tnum">Showing {rows.length} of {runs.length} deliveries</p>
        </div>
      </section>

      <p className="sub no-print" style={{ marginTop: 24, textAlign: 'center' }}>
        Press <kbd>?</kbd> for keyboard shortcuts · <kbd>⌘K</kbd> for the command palette
      </p>
    </>
  );
}
