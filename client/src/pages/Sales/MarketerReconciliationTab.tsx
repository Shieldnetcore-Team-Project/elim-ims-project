import { useEffect, useMemo, useState } from 'react';
import { api } from '../../lib/apiClient';
import { number } from '../../lib/format';
import { Card } from '../../components/ui/Card';
import { KpiRow } from '../../components/ui/KpiCard';
import { Pill } from '../../components/ui/Pill';
import { EmptyState } from '../../components/ui/EmptyState';

interface ReconciliationLine {
  marketer_id: string; marketer_name: string; item_id: string; item_name: string;
  assigned: number; sold: number; returned: number; remaining: number;
  pending_assignment: number; pending_return: number; discrepancy: number; status: string;
}

const STATUS_ORDER = ['SHORT', 'EXCESS', 'PENDING_VERIFICATION', 'PENDING_RETURN', 'BALANCED'];

/** Management's view of Section "END-OF-DAY MARKETER RECONCILIATION" —
 *  Assigned = Sold + Returned + Remaining always holds arithmetically; what
 *  this surfaces is *why* a line isn't cleanly closed out yet (an
 *  unconfirmed assignment, an unverified return claim) or where a verified
 *  physical count came back short or over what was claimed. */
export function MarketerReconciliationTab({ reloadKey }: { reloadKey: number }) {
  const [rows, setRows] = useState<ReconciliationLine[]>([]);
  const [onlyDiscrepancies, setOnlyDiscrepancies] = useState(false);

  useEffect(() => { api<ReconciliationLine[]>('/marketer-reconciliation').then(setRows); }, [reloadKey]);

  const sorted = useMemo(
    () => [...rows].sort((a, b) => STATUS_ORDER.indexOf(a.status) - STATUS_ORDER.indexOf(b.status) || a.marketer_name.localeCompare(b.marketer_name)),
    [rows],
  );
  const visible = onlyDiscrepancies ? sorted.filter(r => r.status !== 'BALANCED') : sorted;

  const kpis = useMemo(() => [
    { key: 'short', label: 'Short', icon: 'clock' as const, value: number(rows.filter(r => r.status === 'SHORT').length) },
    { key: 'excess', label: 'Excess', icon: 'clock' as const, value: number(rows.filter(r => r.status === 'EXCESS').length) },
    { key: 'pending', label: 'Pending verification', icon: 'clock' as const, value: number(rows.filter(r => r.status === 'PENDING_VERIFICATION' || r.status === 'PENDING_RETURN').length) },
    { key: 'balanced', label: 'Balanced', icon: 'chart' as const, value: number(rows.filter(r => r.status === 'BALANCED').length) },
  ], [rows]);

  return (
    <>
      <KpiRow kpis={kpis} />
      <Card
        title="Marketer reconciliation" description={`${visible.length} of ${rows.length} marketer/item line(s) shown — Assigned = Sold + Returned + Remaining.`}
        action={
          <label className="no-print" style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13 }}>
            <input type="checkbox" checked={onlyDiscrepancies} onChange={e => setOnlyDiscrepancies(e.target.checked)} />
            Discrepancies only
          </label>
        }
      >
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Marketer</th><th>Product</th><th className="num">Assigned</th><th className="num">Sold</th>
                <th className="num">Returned</th><th className="num">Remaining</th><th className="num">Unaccounted</th><th>Status</th>
              </tr>
            </thead>
            <tbody>
              {visible.map(r => (
                <tr key={`${r.marketer_id}-${r.item_id}`}>
                  <td style={{ fontWeight: 500 }}>{r.marketer_name}</td>
                  <td>{r.item_name}</td>
                  <td className="num tnum">{number(r.assigned)}</td>
                  <td className="num tnum">{number(r.sold)}</td>
                  <td className="num tnum">{number(r.returned)}</td>
                  <td className="num tnum">{number(r.remaining)}</td>
                  <td className="num tnum">{r.discrepancy !== 0 ? number(Math.abs(r.discrepancy)) : '—'}</td>
                  <td><Pill status={r.status} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {visible.length === 0 && (
          <EmptyState
            title={onlyDiscrepancies ? 'No discrepancies' : 'No marketer stock activity yet'}
            description={onlyDiscrepancies ? 'Every marketer/item line is balanced or fully verified.' : 'Reconciliation lines appear once stock is assigned to a marketer.'}
            onClear={() => setOnlyDiscrepancies(false)}
          />
        )}
      </Card>
    </>
  );
}
