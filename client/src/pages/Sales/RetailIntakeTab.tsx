import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { api, apiPost } from '../../lib/apiClient';
import { naira, number } from '../../lib/format';
import { useUi } from '../../lib/uiState';
import { Card } from '../../components/ui/Card';
import { Modal } from '../../components/ui/Modal';
import { LineItemsInput, type LineItemValue } from '../../components/ui/LineItemsInput';
import { EmptyState } from '../../components/ui/EmptyState';
import { Icon } from '../../components/ui/Icon';

interface Item { id: string; name: string; type: string; unit_cost: number }
interface RetailBalance { id: string; name: string; category: string; uom: string; unit_cost: number; on_hand: number }
interface RetailIntake { id: string; issued_by: string | null; actor: string | null; created_at: string; item_count: number; total_quantity: number }
interface CentralBalance { id: string; on_hand: number }

export function RetailIntakeTab({ items }: { items: Item[] }) {
  const ui = useUi();
  const [balances, setBalances] = useState<RetailBalance[]>([]);
  const [intakes, setIntakes] = useState<RetailIntake[]>([]);
  const [centralBalances, setCentralBalances] = useState<CentralBalance[]>([]);
  const [reloadKey, setReloadKey] = useState(0);
  const [intakeOpen, setIntakeOpen] = useState(false);
  const refresh = useCallback(() => setReloadKey(k => k + 1), []);

  useEffect(() => {
    api<RetailBalance[]>('/retail-stock/balances').then(setBalances);
    api<RetailIntake[]>('/retail-stock/intakes').then(setIntakes);
    api<CentralBalance[]>('/inventory/balances').then(setCentralBalances);
  }, [reloadKey]);

  return (
    <>
      <Card
        title="Retail stock" description="Products transferred in from the central warehouse — Retail's own running balance."
        action={<button className="btn btn-primary btn-sm no-print" onClick={() => setIntakeOpen(true)}><Icon name="plus" size={14} /> New intake</button>}
      >
        <div className="table-wrap">
          <table>
            <thead><tr><th>Item</th><th>Category</th><th className="num">On hand</th><th className="num">Unit cost</th><th className="num">Value</th></tr></thead>
            <tbody>
              {balances.map(b => (
                <tr key={b.id}>
                  <td>{b.name}</td>
                  <td className="sub">{b.category}</td>
                  <td className="num tnum">{number(b.on_hand)}</td>
                  <td className="num tnum">{naira(b.unit_cost)}</td>
                  <td className="num tnum">{naira(b.on_hand * b.unit_cost)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {balances.length === 0 && <EmptyState title="No stock posted to Retail yet" description="Post an intake to transfer product in from the central warehouse." onClear={() => {}} />}
      </Card>

      <Card title="Intake history" description="Every transfer of stock from the warehouse into Retail.">
        <div className="table-wrap">
          <table>
            <thead><tr><th>Intake</th><th>Issued by</th><th className="num">Lines</th><th className="num">Total qty</th><th>Date</th></tr></thead>
            <tbody>
              {intakes.map(i => (
                <tr key={i.id}>
                  <td className="mono" style={{ fontSize: 12, color: 'rgb(var(--aqua-700))' }}>{i.id}</td>
                  <td>{i.issued_by ?? '—'}</td>
                  <td className="num tnum">{number(i.item_count)}</td>
                  <td className="num tnum">{number(i.total_quantity)}</td>
                  <td className="sub">{i.created_at}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {intakes.length === 0 && <EmptyState title="No intakes yet" description="Nothing has been transferred to Retail from the warehouse yet." onClear={() => {}} />}
      </Card>

      {intakeOpen && (
        <NewIntake
          items={items} centralBalances={centralBalances}
          onClose={() => setIntakeOpen(false)}
          onCreated={() => { setIntakeOpen(false); refresh(); ui.toast('Stock posted to Retail'); }}
        />
      )}
    </>
  );
}

function NewIntake({ items, centralBalances, onClose, onCreated }: {
  items: Item[]; centralBalances: CentralBalance[]; onClose: () => void; onCreated: () => void;
}) {
  const [issuedBy, setIssuedBy] = useState('');
  const [lines, setLines] = useState<LineItemValue[]>([{ itemId: items[0]?.id ?? '', quantity: '10', unitPrice: String(items[0]?.unit_cost ?? 0) }]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const centralOnHand = (itemId: string) => centralBalances.find(b => b.id === itemId)?.on_hand ?? 0;

  async function submit(e: FormEvent) {
    e.preventDefault();
    setSaving(true); setError(null);
    try {
      await apiPost('/retail-stock/intake', {
        issuedBy,
        items: lines.map(l => ({ itemId: l.itemId, quantity: Number(l.quantity), unitCost: Number(l.unitPrice) })),
      });
      onCreated();
    } catch (err) { setError(err instanceof Error ? err.message : 'Something went wrong'); }
    finally { setSaving(false); }
  }

  return (
    <Modal title="Post intake to Retail" onClose={onClose} onSubmit={submit} submitLabel="Post intake" saving={saving} error={error} wide>
      <div className="form-row"><label htmlFor="ri-issued-by">Issued by</label><input id="ri-issued-by" value={issuedBy} onChange={e => setIssuedBy(e.target.value)} required autoFocus /></div>
      <LineItemsInput items={lines} options={items} onChange={setLines} />
      {lines.map(l => {
        const available = centralOnHand(l.itemId);
        const requested = Number(l.quantity) || 0;
        if (requested <= available) return null;
        const name = items.find(i => i.id === l.itemId)?.name ?? l.itemId;
        return <p key={l.itemId} className="sub" style={{ color: 'rgb(var(--stop))' }}>Only {available.toLocaleString('en-NG')} of {name} available in the central warehouse.</p>;
      })}
      <p className="sub">Moves stock out of the central warehouse into Retail's own on-hand balance — nothing is sold yet.</p>
    </Modal>
  );
}
