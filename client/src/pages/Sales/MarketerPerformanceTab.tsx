import { useEffect, useMemo, useState } from 'react';
import { api } from '../../lib/apiClient';
import { naira, number } from '../../lib/format';
import { Card } from '../../components/ui/Card';
import { KpiRow } from '../../components/ui/KpiCard';
import { EmptyState } from '../../components/ui/EmptyState';
import { ReportToolbar } from '../../components/ui/ReportToolbar';
import type { DateRange } from '../../lib/reportExport';
import type { CsvColumn } from '../../lib/csv';

interface PerformanceRow {
  marketer_id: string; marketer_name: string;
  cash_sales: number; credit_sales: number; credit_recovered: number; outstanding_credit: number;
  total_sales: number; eligible_sales: number; commissionable_sales: number; commission_rate: number; commission: number;
  stock_received: number; stock_sold: number; stock_returned: number; stock_outstanding: number;
}

const COLUMNS: CsvColumn<PerformanceRow>[] = [
  { label: 'Marketer', get: r => r.marketer_name },
  { label: 'Cash sales', get: r => r.cash_sales },
  { label: 'Credit sales', get: r => r.credit_sales },
  { label: 'Credit recovered', get: r => r.credit_recovered },
  { label: 'Outstanding credit', get: r => r.outstanding_credit },
  { label: 'Total sales', get: r => r.total_sales },
  { label: 'Commissionable sales', get: r => r.commissionable_sales },
  { label: 'Commission', get: r => r.commission },
  { label: 'Stock received', get: r => r.stock_received },
  { label: 'Stock sold', get: r => r.stock_sold },
  { label: 'Stock returned', get: r => r.stock_returned },
  { label: 'Stock outstanding', get: r => r.stock_outstanding },
];

/** Marketer Commission and Performance report. The one rule this whole page
 *  exists to make visible: a marketer earns no commission on unrecovered
 *  credit — Commissionable Sales (Cash + Recovered Credit) is shown right
 *  next to Total Sales so the gap is never hidden in a single blended
 *  number. Commission rate is whatever's configured in Settings ("Marketer
 *  commission rate") — never a number baked into this page.
 *
 *  Section 39: Daily/Monthly/Yearly/Custom Date filtering + PDF/Excel/CSV
 *  export. Because this report is server-aggregated (sums per marketer, not
 *  raw rows), the date window is resolved by ReportToolbar and re-fetched
 *  from the server rather than filtered client-side — Outstanding Credit and
 *  Stock Outstanding stay live/all-time regardless of the window (see the
 *  service's own doc comment for why). */
export function MarketerPerformanceTab({ reloadKey }: { reloadKey: number }) {
  const [rows, setRows] = useState<PerformanceRow[]>([]);
  const [range, setRange] = useState<DateRange | null>(null);

  useEffect(() => {
    api<PerformanceRow[]>('/marketer-performance', range ? { from: range.from, to: range.to } : undefined).then(setRows);
  }, [reloadKey, range]);

  const totals = useMemo(() => rows.reduce((s, r) => ({
    totalSales: s.totalSales + r.total_sales,
    unrecovered: s.unrecovered + r.outstanding_credit,
    commissionable: s.commissionable + r.commissionable_sales,
    commission: s.commission + r.commission,
  }), { totalSales: 0, unrecovered: 0, commissionable: 0, commission: 0 }), [rows]);

  const rate = rows[0]?.commission_rate ?? 0;
  const kpis = useMemo(() => [
    { key: 'total', label: 'Total sales', icon: 'chart' as const, value: naira(totals.totalSales) },
    { key: 'unrecovered', label: 'Unrecovered credit', icon: 'clock' as const, value: naira(totals.unrecovered) },
    { key: 'commissionable', label: 'Commissionable sales', icon: 'wallet' as const, value: naira(totals.commissionable) },
    { key: 'commission', label: `Commission (${rate}%)`, icon: 'bank' as const, value: naira(totals.commission) },
  ], [totals, rate]);

  return (
    <>
      <KpiRow kpis={kpis} />
      <Card
        title="Marketer performance & commission"
        description="A marketer does not receive commission for unrecovered credit — Commissionable Sales excludes it. Commission rate is configured under Settings → “Marketer commission rate”. Outstanding Credit and Stock Outstanding are always live, regardless of the selected window."
      >
        <ReportToolbar rows={rows} columns={COLUMNS} filenameBase="elim-marketer-performance" onRangeChange={setRange} />
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Marketer</th><th className="num">Cash sales</th><th className="num">Credit sales</th><th className="num">Credit recovered</th>
                <th className="num">Outstanding credit</th><th className="num">Total sales</th><th className="num">Commissionable</th><th className="num">Commission</th>
                <th className="num">Stock received</th><th className="num">Stock sold</th><th className="num">Stock returned</th><th className="num">Stock outstanding</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(r => (
                <tr key={r.marketer_id}>
                  <td style={{ fontWeight: 500 }}>{r.marketer_name}</td>
                  <td className="num tnum">{naira(r.cash_sales)}</td>
                  <td className="num tnum">{naira(r.credit_sales)}</td>
                  <td className="num tnum">{naira(r.credit_recovered)}</td>
                  <td className="num tnum">{naira(r.outstanding_credit)}</td>
                  <td className="num tnum">{naira(r.total_sales)}</td>
                  <td className="num tnum">{naira(r.commissionable_sales)}</td>
                  <td className="num tnum" style={{ fontWeight: 600 }}>{naira(r.commission)}</td>
                  <td className="num tnum">{number(r.stock_received)}</td>
                  <td className="num tnum">{number(r.stock_sold)}</td>
                  <td className="num tnum">{number(r.stock_returned)}</td>
                  <td className="num tnum">{number(r.stock_outstanding)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {rows.length === 0 && <EmptyState title="No marketers yet" description="Add a customer of type Marketer to see their performance here." onClear={() => setRange(null)} />}
      </Card>
    </>
  );
}
