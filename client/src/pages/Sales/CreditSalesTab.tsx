import { useEffect, useMemo, useState } from 'react';
import { api } from '../../lib/apiClient';
import { naira, number } from '../../lib/format';
import { Card } from '../../components/ui/Card';
import { KpiRow } from '../../components/ui/KpiCard';
import { Pill } from '../../components/ui/Pill';
import { EmptyState } from '../../components/ui/EmptyState';

interface CreditTransaction {
  id: string; customer_name: string; marketer_name: string; created_at: string; due_date: string | null;
  credit_limit: number; amount: number; amount_paid: number; balance: number;
  last_payment_date: string | null; recovery_status: string;
}

/** Section 15: every credit transaction tracked as its own row, separate
 *  from the general Orders list — Customer/Marketer/Invoice/Amount/Credit
 *  Date/Due Date/Credit Limit/Amount Paid/Amount Outstanding/Recovery Date/
 *  Recovery Status, exactly as specified. */
export function CreditSalesTab({ reloadKey }: { reloadKey: number }) {
  const [rows, setRows] = useState<CreditTransaction[]>([]);
  const [statusFilter, setStatusFilter] = useState('');

  useEffect(() => { api<CreditTransaction[]>('/marketer-customers/reports/credit-transactions').then(setRows); }, [reloadKey]);

  const visible = useMemo(() => statusFilter ? rows.filter(r => r.recovery_status === statusFilter) : rows, [rows, statusFilter]);

  const kpis = useMemo(() => [
    { key: 'credit', label: 'Credit', icon: 'clock' as const, value: number(rows.filter(r => r.recovery_status === 'CREDIT').length) },
    { key: 'partial', label: 'Partially paid', icon: 'clock' as const, value: number(rows.filter(r => r.recovery_status === 'PARTIALLY_PAID').length) },
    { key: 'overdue', label: 'Overdue', icon: 'clock' as const, value: number(rows.filter(r => r.recovery_status === 'OVERDUE').length) },
    { key: 'outstanding', label: 'Total outstanding', icon: 'chart' as const, value: naira(rows.reduce((s, r) => s + Math.max(r.balance, 0), 0)) },
  ], [rows]);

  return (
    <>
      <KpiRow kpis={kpis} />
      <Card
        title="Credit sales" description={`${visible.length} of ${rows.length} credit transaction(s) shown.`}
        action={
          <select aria-label="Recovery status" className="no-print" value={statusFilter} onChange={e => setStatusFilter(e.target.value)}>
            <option value="">All statuses</option>
            <option value="CREDIT">Credit</option>
            <option value="PARTIALLY_PAID">Partially paid</option>
            <option value="FULLY_PAID">Fully paid</option>
            <option value="OVERDUE">Overdue</option>
          </select>
        }
      >
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Invoice</th><th>Customer</th><th>Marketer</th><th className="num">Amount</th><th>Credit date</th><th>Due date</th>
                <th className="num">Credit limit</th><th className="num">Paid</th><th className="num">Outstanding</th><th>Recovery date</th><th>Status</th>
              </tr>
            </thead>
            <tbody>
              {visible.map(r => (
                <tr key={r.id}>
                  <td className="mono" style={{ fontSize: 12, color: 'rgb(var(--aqua-700))' }}>{r.id}</td>
                  <td>{r.customer_name}</td>
                  <td>{r.marketer_name}</td>
                  <td className="num tnum">{naira(r.amount)}</td>
                  <td className="sub">{r.created_at}</td>
                  <td className="sub">{r.due_date ?? '—'}</td>
                  <td className="num tnum">{naira(r.credit_limit)}</td>
                  <td className="num tnum">{naira(r.amount_paid)}</td>
                  <td className="num tnum">{naira(Math.max(r.balance, 0))}</td>
                  <td className="sub">{r.last_payment_date ?? '—'}</td>
                  <td><Pill status={r.recovery_status} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {visible.length === 0 && <EmptyState title="No credit transactions" description="Raised when a marketer sells to a field customer on credit." onClear={() => setStatusFilter('')} />}
      </Card>
    </>
  );
}
