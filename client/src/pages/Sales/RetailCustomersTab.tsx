import { useEffect, useMemo, useState } from 'react';
import { api } from '../../lib/apiClient';
import { naira, number } from '../../lib/format';
import { Card } from '../../components/ui/Card';
import { Pill } from '../../components/ui/Pill';
import { EmptyState } from '../../components/ui/EmptyState';

interface RetailCustomerActivity {
  id: string; name: string; location: string | null; phone: string | null;
  purchase_count: number; total_spent: number; last_purchase_at: string; needs_follow_up: 0 | 1;
}

export function RetailCustomersTab({ reloadKey }: { reloadKey: number }) {
  const [rows, setRows] = useState<RetailCustomerActivity[]>([]);
  const [followUpOnly, setFollowUpOnly] = useState(false);

  useEffect(() => { api<RetailCustomerActivity[]>('/sales/retail-customers').then(setRows); }, [reloadKey]);

  const filtered = useMemo(() => followUpOnly ? rows.filter(r => r.needs_follow_up) : rows, [rows, followUpOnly]);
  const followUpCount = useMemo(() => rows.filter(r => r.needs_follow_up).length, [rows]);

  return (
    <Card
      title="Retail customers" description="Purchase frequency and consistency by customer — flagged when no purchase in the last 30 days."
      action={
        <button className={`btn btn-sm no-print ${followUpOnly ? 'btn-primary' : 'btn-secondary'}`} onClick={() => setFollowUpOnly(v => !v)}>
          {followUpOnly ? 'Showing follow-up only' : `Needs follow-up (${followUpCount})`}
        </button>
      }
    >
      <div className="table-wrap">
        <table>
          <thead><tr><th>Customer</th><th>Location</th><th>Phone</th><th className="num">Purchases</th><th className="num">Total spent</th><th>Last purchase</th><th>Status</th></tr></thead>
          <tbody>
            {filtered.map(r => (
              <tr key={r.id}>
                <td style={{ fontWeight: 500 }}>{r.name}</td>
                <td className="sub">{r.location ?? '—'}</td>
                <td className="sub">{r.phone ?? '—'}</td>
                <td className="num tnum">{number(r.purchase_count)}</td>
                <td className="num tnum">{naira(r.total_spent)}</td>
                <td className="sub">{r.last_purchase_at}</td>
                <td><Pill status={r.needs_follow_up ? 'FOLLOW_UP_DUE' : 'ACTIVE'} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {filtered.length === 0 && (
        <EmptyState
          title={followUpOnly ? 'Nobody is overdue for follow-up' : 'No retail purchases yet'}
          description={followUpOnly ? 'Every customer has purchased within the last 30 days.' : 'Purchase history appears here once a retail sale is recorded against a customer.'}
          onClear={() => setFollowUpOnly(false)}
        />
      )}
    </Card>
  );
}
