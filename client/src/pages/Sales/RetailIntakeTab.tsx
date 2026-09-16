import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import { api, apiPost } from '../../lib/apiClient';
import { naira, number } from '../../lib/format';
import { useUi } from '../../lib/uiState';
import { Card } from '../../components/ui/Card';
import { Pill } from '../../components/ui/Pill';
import { Modal } from '../../components/ui/Modal';
import { LineItemsInput, type LineItemValue } from '../../components/ui/LineItemsInput';
import { EmptyState } from '../../components/ui/EmptyState';
import { Icon } from '../../components/ui/Icon';
import { NumberInput } from '../../components/ui/NumberInput';

interface Item { id: string; name: string; type: string; unit_cost: number }
interface RetailBalance { id: string; name: string; category: string; uom: string; unit_cost: number; on_hand: number }
interface RetailIntake {
  id: string; issued_by: string | null; actor: string | null; status: 'SENT' | 'CONFIRMED';
  confirmed_by: string | null; confirmed_at: string | null; created_at: string;
  item_count: number; total_quantity: number; received_quantity: number;
}
interface RetailIntakeItem { item_id: string; item_name: string; quantity: number; received_quantity: number | null; unit_cost: number }
interface CentralBalance { id: string; on_hand: number }

export function RetailIntakeTab({ items, autoIntakeItemId }: { items: Item[]; autoIntakeItemId?: string }) {
  const ui = useUi();
  const [balances, setBalances] = useState<RetailBalance[]>([]);
  const [intakes, setIntakes] = useState<RetailIntake[]>([]);
  const [centralBalances, setCentralBalances] = useState<CentralBalance[]>([]);
  const [reloadKey, setReloadKey] = useState(0);
  const [dispatchOpen, setDispatchOpen] = useState(() => Boolean(autoIntakeItemId));
  const [confirmTarget, setConfirmTarget] = useState<RetailIntake | null>(null);
  const refresh = useCallback(() => setReloadKey(k => k + 1), []);

  useEffect(() => {
    api<RetailBalance[]>('/retail-stock/balances').then(setBalances);
    api<RetailIntake[]>('/retail-stock/intakes').then(setIntakes);
    api<CentralBalance[]>('/inventory/balances').then(setCentralBalances);
  }, [reloadKey]);

  const awaitingConfirmation = useMemo(() => intakes.filter(i => i.status === 'SENT').length, [intakes]);

  return (
    <>
      <Card
        title="Retail stock — remaining by type"
        description="What Retail is holding right now, per product. Rises when a warehouse transfer is confirmed, falls on every POS sale."
        action={<button className="btn btn-primary btn-sm no-print" onClick={() => setDispatchOpen(true)}><Icon name="plus" size={14} /> Send to Retail</button>}
      >
        <div className="table-wrap">
          <table>
            <thead><tr><th>Product</th><th>Category</th><th className="num">On hand</th><th className="num">Unit cost</th><th className="num">Value</th></tr></thead>
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
        {balances.length === 0 && <EmptyState title="No stock in Retail yet" description="Send a transfer from the central warehouse, then confirm it here." onClear={() => {}} />}
      </Card>

      <Card
        title="Transfers from the warehouse"
        description={`Every dispatch from the central warehouse into Retail. ${awaitingConfirmation > 0 ? `${awaitingConfirmation} awaiting Retail's confirmation.` : 'All confirmed.'}`}
      >
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Transfer</th><th>Sent by</th><th className="num">Lines</th><th className="num">Sent</th><th className="num">Received</th>
                <th>Status</th><th>Confirmed by</th><th>Date</th><th className="no-print">Action</th>
              </tr>
            </thead>
            <tbody>
              {intakes.map(i => (
                <tr key={i.id}>
                  <td className="mono" style={{ fontSize: 12, color: 'rgb(var(--aqua-700))' }}>{i.id}</td>
                  <td>{i.issued_by ?? '—'}</td>
                  <td className="num tnum">{number(i.item_count)}</td>
                  <td className="num tnum">{number(i.total_quantity)}</td>
                  <td className="num tnum">
                    {i.status === 'CONFIRMED' ? (
                      <span style={{ color: i.received_quantity < i.total_quantity ? 'rgb(var(--stop))' : undefined }}>{number(i.received_quantity)}</span>
                    ) : '—'}
                  </td>
                  <td><Pill status={i.status} /></td>
                  <td className="sub">{i.confirmed_by ?? '—'}</td>
                  <td className="sub">{i.status === 'CONFIRMED' ? (i.confirmed_at ?? i.created_at) : i.created_at}</td>
                  <td className="no-print">
                    {i.status === 'SENT' && <button className="btn btn-secondary btn-sm" onClick={() => setConfirmTarget(i)}>Review &amp; confirm</button>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {intakes.length === 0 && <EmptyState title="No transfers yet" description="Nothing has been sent to Retail from the warehouse yet." onClear={() => {}} />}
      </Card>

      {dispatchOpen && (
        <DispatchToRetail
          items={items} centralBalances={centralBalances} initialItemId={autoIntakeItemId}
          onClose={() => setDispatchOpen(false)}
          onDispatched={() => { setDispatchOpen(false); refresh(); ui.toast('Sent to Retail — awaiting their confirmation'); }}
        />
      )}
      {confirmTarget && (
        <ConfirmIntake
          intake={confirmTarget}
          onClose={() => setConfirmTarget(null)}
          onConfirmed={() => { setConfirmTarget(null); refresh(); ui.toast(`${confirmTarget.id} confirmed`); }}
        />
      )}
    </>
  );
}

function DispatchToRetail({ items, centralBalances, initialItemId, onClose, onDispatched }: {
  items: Item[]; centralBalances: CentralBalance[]; initialItemId?: string; onClose: () => void; onDispatched: () => void;
}) {
  const [issuedBy, setIssuedBy] = useState('');
  const [lines, setLines] = useState<LineItemValue[]>(() => {
    const preselected = initialItemId ? items.find(i => i.id === initialItemId) : undefined;
    return [{ itemId: preselected?.id ?? items[0]?.id ?? '', quantity: '10', unitPrice: String(preselected?.unit_cost ?? items[0]?.unit_cost ?? 0) }];
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const centralOnHand = (itemId: string) => centralBalances.find(b => b.id === itemId)?.on_hand ?? 0;

  async function submit(e: FormEvent) {
    e.preventDefault();
    setSaving(true); setError(null);
    try {
      await apiPost('/retail-stock/dispatch', {
        issuedBy,
        items: lines.map(l => ({ itemId: l.itemId, quantity: Number(l.quantity), unitCost: Number(l.unitPrice) })),
      });
      onDispatched();
    } catch (err) { setError(err instanceof Error ? err.message : 'Something went wrong'); }
    finally { setSaving(false); }
  }

  return (
    <Modal title="Send products to Retail" onClose={onClose} onSubmit={submit} submitLabel="Send" saving={saving} error={error} wide>
      <div className="form-row"><label htmlFor="ri-issued-by">Sent by</label><input id="ri-issued-by" value={issuedBy} onChange={e => setIssuedBy(e.target.value)} required autoFocus /></div>
      <LineItemsInput items={lines} options={items} onChange={setLines} />
      {lines.map(l => {
        const available = centralOnHand(l.itemId);
        const requested = Number(l.quantity) || 0;
        if (requested <= available) return null;
        const name = items.find(i => i.id === l.itemId)?.name ?? l.itemId;
        return <p key={l.itemId} className="sub" style={{ color: 'rgb(var(--stop))' }}>Only {available.toLocaleString('en-NG')} of {name} available in the central warehouse.</p>;
      })}
      <p className="sub">Stock leaves the central warehouse now. It only enters Retail's balance once Retail reviews and confirms what arrived.</p>
    </Modal>
  );
}

function ConfirmIntake({ intake, onClose, onConfirmed }: { intake: RetailIntake; onClose: () => void; onConfirmed: () => void }) {
  const [lines, setLines] = useState<{ itemId: string; name: string; sent: number; received: string }[] | null>(null);
  const [confirmedBy, setConfirmedBy] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api<{ items: RetailIntakeItem[] }>(`/retail-stock/intakes/${encodeURIComponent(intake.id)}`).then(full => {
      setLines(full.items.map(it => ({ itemId: it.item_id, name: it.item_name, sent: it.quantity, received: String(it.quantity) })));
    });
  }, [intake.id]);

  const anyShort = useMemo(() => (lines ?? []).some(l => Number(l.received) < l.sent), [lines]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!lines) return;
    for (const l of lines) {
      const r = Number(l.received);
      if (!Number.isFinite(r) || r < 0) { setError(`${l.name}: received quantity must be zero or more`); return; }
      if (r > l.sent) { setError(`${l.name}: cannot receive more than the ${l.sent} sent`); return; }
    }
    setSaving(true); setError(null);
    try {
      await apiPost(`/retail-stock/intakes/${encodeURIComponent(intake.id)}/confirm`, {
        confirmedBy,
        lines: lines.map(l => ({ itemId: l.itemId, receivedQuantity: Number(l.received) })),
      });
      onConfirmed();
    } catch (err) { setError(err instanceof Error ? err.message : 'Something went wrong'); }
    finally { setSaving(false); }
  }

  return (
    <Modal title={`Review & confirm ${intake.id}`} onClose={onClose} onSubmit={submit} submitLabel="Confirm receipt" saving={saving} error={error} wide>
      <p className="sub" style={{ marginBottom: 12 }}>
        Enter what actually arrived from the warehouse. Only the received quantity enters Retail stock; a shortfall is recorded against this transfer.
      </p>
      <div className="form-row"><label htmlFor="ri-confirmed-by">Confirmed by</label><input id="ri-confirmed-by" value={confirmedBy} onChange={e => setConfirmedBy(e.target.value)} required autoFocus /></div>
      {lines === null && <p className="sub">Loading transfer lines…</p>}
      {lines?.map((l, i) => (
        <div className="lineitem-row" key={l.itemId}>
          <div style={{ flex: 2 }}>
            <p style={{ fontSize: 13 }}>{l.name}</p>
            <p className="sub" style={{ fontSize: 12 }}>Sent {l.sent.toLocaleString('en-NG')}</p>
          </div>
          <div style={{ width: 120 }}>
            <NumberInput
              ariaLabel={`Received quantity for ${l.name}`} allowDecimal={false} value={l.received}
              onChange={v => setLines(ls => ls!.map((x, idx) => idx === i ? { ...x, received: v } : x))} required
            />
          </div>
          {Number(l.received) < l.sent && (
            <p className="sub" style={{ width: 90, color: 'rgb(var(--stop))', fontSize: 12 }}>short {(l.sent - Number(l.received)).toLocaleString('en-NG')}</p>
          )}
        </div>
      ))}
      {anyShort && <p className="sub" style={{ color: 'rgb(var(--stop))' }}>A shortfall will be logged against this transfer for follow-up — it does not return to the warehouse automatically.</p>}
    </Modal>
  );
}
