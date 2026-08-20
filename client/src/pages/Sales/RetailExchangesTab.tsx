import { useEffect, useState } from 'react';
import { api } from '../../lib/apiClient';
import { Card } from '../../components/ui/Card';
import { EmptyState } from '../../components/ui/EmptyState';

interface RetailExchange {
  id: string; original_sales_id: string; new_sales_id: string | null; customer_name: string;
  reason: string; staff: string | null; created_at: string;
}

/** Read-only audit trail for Section 10 — every retail return/exchange ever
 *  recorded, each one still pointing at its untouched original sale. */
export function RetailExchangesTab({ reloadKey }: { reloadKey: number }) {
  const [rows, setRows] = useState<RetailExchange[]>([]);

  useEffect(() => { api<RetailExchange[]>('/retail-exchanges').then(setRows); }, [reloadKey]);

  return (
    <Card title="Returns & exchanges" description={`${rows.length} record(s) — each linked to its original sale, never editing it.`}>
      <div className="table-wrap">
        <table>
          <thead><tr><th>Exchange</th><th>Original sale</th><th>New sale</th><th>Customer</th><th>Reason</th><th>Staff</th><th>Date</th></tr></thead>
          <tbody>
            {rows.map(r => (
              <tr key={r.id}>
                <td className="mono" style={{ fontSize: 12, color: 'rgb(var(--aqua-700))' }}>{r.id}</td>
                <td className="mono" style={{ fontSize: 12 }}>{r.original_sales_id}</td>
                <td className="mono" style={{ fontSize: 12 }}>{r.new_sales_id ?? '—'}</td>
                <td>{r.customer_name}</td>
                <td className="sub">{r.reason}</td>
                <td>{r.staff ?? '—'}</td>
                <td className="sub">{r.created_at}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {rows.length === 0 && <EmptyState title="No returns or exchanges yet" description="Recorded from a completed retail sale's Return/Exchange action." onClear={() => {}} />}
    </Card>
  );
}
