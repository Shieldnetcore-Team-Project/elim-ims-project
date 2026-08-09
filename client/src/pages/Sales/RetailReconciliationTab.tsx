import { useEffect, useState } from 'react';
import { api } from '../../lib/apiClient';
import { naira, number } from '../../lib/format';
import { Card } from '../../components/ui/Card';
import { EmptyState } from '../../components/ui/EmptyState';
import { Icon } from '../../components/ui/Icon';

interface DailyReportLine { item_id: string; item_name: string; quantity: number }
interface CategoryPaymentLine { category: string; payment_method: string; amount: number }
interface RetailBalance { id: string; name: string; category: string; uom: string; unit_cost: number; on_hand: number }
interface DailyActivity { type: 'INTAKE' | 'SALE'; id: string; at: string; detail: string }
interface DailyReport {
  date: string; received: DailyReportLine[]; salesByCategoryAndPayment: CategoryPaymentLine[];
  remainingBalance: RetailBalance[]; activity: DailyActivity[];
}

function today(): string { return new Date().toISOString().slice(0, 10); }

export function RetailReconciliationTab() {
  const [date, setDate] = useState(today());
  const [report, setReport] = useState<DailyReport | null>(null);

  useEffect(() => { api<DailyReport>('/retail-stock/daily-report', { date }).then(setReport); }, [date]);

  const receivedTotal = report?.received.reduce((s, r) => s + r.quantity, 0) ?? 0;
  const salesTotal = report?.salesByCategoryAndPayment.reduce((s, r) => s + r.amount, 0) ?? 0;
  const remainingValue = report?.remainingBalance.reduce((s, b) => s + b.on_hand * b.unit_cost, 0) ?? 0;

  return (
    <>
      <Card
        title="Daily reconciliation" description="End-of-day breakdown of what Retail received, sold, and still holds."
        action={
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }} className="no-print">
            <input aria-label="Business date" type="date" value={date} onChange={e => setDate(e.target.value)} max={today()} />
            <button className="btn btn-primary btn-sm" onClick={() => window.print()}><Icon name="print" size={14} /> Print</button>
          </div>
        }
      >
        <div style={{ display: 'flex', gap: 24, flexWrap: 'wrap', padding: '10px 20px 16px' }}>
          <p className="sub">Received {date} <strong style={{ color: 'rgb(var(--ink))' }}>{number(receivedTotal)}</strong></p>
          <p className="sub">Sales {date} <strong style={{ color: 'rgb(var(--ink))' }}>{naira(salesTotal)}</strong></p>
          <p className="sub">Remaining stock value <strong style={{ color: 'rgb(var(--ink))' }}>{naira(remainingValue)}</strong></p>
        </div>

        <p className="card-title" style={{ padding: '4px 20px', fontSize: 14 }}>Received today</p>
        <div className="table-wrap">
          <table>
            <thead><tr><th>Item</th><th className="num">Quantity</th></tr></thead>
            <tbody>
              {report?.received.map(r => <tr key={r.item_id}><td>{r.item_name}</td><td className="num tnum">{number(r.quantity)}</td></tr>)}
            </tbody>
          </table>
        </div>
        {report?.received.length === 0 && <EmptyState title="Nothing posted today" description="No intake from the warehouse was recorded on this date." onClear={() => {}} />}

        <p className="card-title" style={{ padding: '16px 20px 4px', fontSize: 14 }}>Sales by category and payment mode</p>
        <div className="table-wrap">
          <table>
            <thead><tr><th>Category</th><th>Payment mode</th><th className="num">Amount</th></tr></thead>
            <tbody>
              {report?.salesByCategoryAndPayment.map((r, i) => (
                <tr key={i}><td>{r.category}</td><td className="sub">{r.payment_method}</td><td className="num tnum">{naira(r.amount)}</td></tr>
              ))}
            </tbody>
          </table>
        </div>
        {report?.salesByCategoryAndPayment.length === 0 && <EmptyState title="No sales today" description="No retail sale was recorded on this date." onClear={() => {}} />}

        <p className="card-title" style={{ padding: '16px 20px 4px', fontSize: 14 }}>Remaining inventory balance</p>
        <div className="table-wrap">
          <table>
            <thead><tr><th>Item</th><th>Category</th><th className="num">On hand</th><th className="num">Value</th></tr></thead>
            <tbody>
              {report?.remainingBalance.map(b => (
                <tr key={b.id}><td>{b.name}</td><td className="sub">{b.category}</td><td className="num tnum">{number(b.on_hand)}</td><td className="num tnum">{naira(b.on_hand * b.unit_cost)}</td></tr>
              ))}
            </tbody>
          </table>
        </div>

        <p className="card-title" style={{ padding: '16px 20px 4px', fontSize: 14 }}>Activity breakdown</p>
        <div className="table-wrap">
          <table>
            <thead><tr><th>Type</th><th>Ref</th><th>Time</th><th>Detail</th></tr></thead>
            <tbody>
              {report?.activity.map(a => (
                <tr key={`${a.type}-${a.id}`}>
                  <td className="sub">{a.type === 'INTAKE' ? 'Posting' : 'Sale'}</td>
                  <td className="mono" style={{ fontSize: 12 }}>{a.id}</td>
                  <td className="sub">{a.at}</td>
                  <td>{a.detail}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {report?.activity.length === 0 && <EmptyState title="No activity" description="Nothing was posted or sold in Retail on this date." onClear={() => {}} />}
      </Card>
    </>
  );
}
