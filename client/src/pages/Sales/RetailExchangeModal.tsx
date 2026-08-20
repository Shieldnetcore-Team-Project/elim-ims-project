import { useEffect, useState, type FormEvent } from 'react';
import { api, apiPost } from '../../lib/apiClient';
import { naira, number } from '../../lib/format';
import { useUi } from '../../lib/uiState';
import { useCurrentUser } from '../../lib/currentUser';
import { Modal } from '../../components/ui/Modal';
import { NumberInput } from '../../components/ui/NumberInput';
import { LineItemsInput, type LineItemValue } from '../../components/ui/LineItemsInput';

interface Item { id: string; name: string; type: string; unit_cost: number }
interface ReceiptItem { item_id: string; quantity: number; unit_price: number; line_total: number }
interface PosReceipt { salesId: string; items: ReceiptItem[] }
const POS_METHODS = ['Cash', 'Transfer', 'POS Terminal'] as const;
type PosMethod = typeof POS_METHODS[number];

/** Section 10: a controlled correction against an already-posted retail sale.
 *  Never edits sales_items on the original order — records a return (line
 *  quantities + reason, refunded and posted back to Retail stock immediately)
 *  and, only if the customer is taking something different away, opens a
 *  brand new POS sale for it. "Original Sale -> Return/Correction -> New
 *  Sale" ends up as three separate, linked rows, exactly as the spec asks. */
export function RetailExchangeModal({ salesId, customerName, onClose, onCompleted }: {
  salesId: string; customerName: string; onClose: () => void; onCompleted: () => void;
}) {
  const ui = useUi();
  const { user } = useCurrentUser();
  const [receipt, setReceipt] = useState<PosReceipt | null>(null);
  const [items, setItems] = useState<Item[]>([]);
  const [returnQty, setReturnQty] = useState<Record<string, string>>({});
  const [reason, setReason] = useState('');
  const [staff, setStaff] = useState(user?.name ?? '');
  const [wantsReplacement, setWantsReplacement] = useState(false);
  const [newLines, setNewLines] = useState<LineItemValue[]>([{ itemId: '', quantity: '1', unitPrice: '0' }]);
  const [newMethod, setNewMethod] = useState<PosMethod>('Cash');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api<PosReceipt>(`/pos-receipts/${encodeURIComponent(salesId)}`).then(setReceipt);
    api<Item[]>('/masters/items').then(rows => setItems(rows.filter(i => i.type === 'FINISHED_GOOD')));
  }, [salesId]);

  const returnLines = Object.entries(returnQty)
    .map(([itemId, q]) => ({ itemId, quantity: Number(q) || 0 }))
    .filter(l => l.quantity > 0);
  const returnedAmount = receipt
    ? returnLines.reduce((s, l) => s + l.quantity * (receipt.items.find(i => i.item_id === l.itemId)?.unit_price ?? 0), 0)
    : 0;
  const newTotal = newLines.reduce((s, l) => s + (Number(l.quantity) || 0) * (Number(l.unitPrice) || 0), 0);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (returnLines.length === 0) { setError('Enter a quantity to return for at least one line'); return; }
    if (wantsReplacement && newLines.every(l => !l.itemId || Number(l.quantity) <= 0)) {
      setError('Add at least one replacement line, or turn off "Customer wants a replacement"');
      return;
    }
    setSaving(true); setError(null);
    try {
      await apiPost('/retail-exchanges', {
        originalSalesId: salesId, returns: returnLines, reason, staff, actor: staff,
        newSaleItems: wantsReplacement
          ? newLines.filter(l => l.itemId && Number(l.quantity) > 0).map(l => ({ itemId: l.itemId, quantity: Number(l.quantity), unitPrice: Number(l.unitPrice) }))
          : undefined,
        newSalePayments: wantsReplacement ? [{ method: newMethod, amount: newTotal }] : undefined,
      });
      onCompleted();
    } catch (err) { setError(err instanceof Error ? err.message : 'Something went wrong'); }
    finally { setSaving(false); }
  }

  return (
    <Modal title={`Return / exchange — ${salesId}`} onClose={onClose} onSubmit={submit} submitLabel="Record" saving={saving} error={error} wide>
      <p className="sub" style={{ marginBottom: 10 }}>{customerName} — enter the quantity coming back for each line. The original sale is never changed; this posts a linked correction.</p>
      {!receipt && <p className="sub">Loading…</p>}
      {receipt && (
        <div className="table-wrap" style={{ marginBottom: 12 }}>
          <table>
            <thead><tr><th>Item</th><th className="num">Originally sold</th><th className="num">Unit price</th><th style={{ width: 120 }}>Quantity to return</th></tr></thead>
            <tbody>
              {receipt.items.map(it => (
                <tr key={it.item_id}>
                  <td>{items.find(x => x.id === it.item_id)?.name ?? it.item_id}</td>
                  <td className="num tnum">{number(it.quantity)}</td>
                  <td className="num tnum">{naira(it.unit_price)}</td>
                  <td>
                    <NumberInput
                      ariaLabel={`Quantity to return for ${it.item_id}`} allowDecimal={false}
                      value={returnQty[it.item_id] ?? ''}
                      onChange={v => setReturnQty(q => ({ ...q, [it.item_id]: v }))}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {returnedAmount > 0 && <p className="sub" style={{ marginBottom: 10 }}>Refund due: <strong style={{ color: 'rgb(var(--ink))' }}>{naira(returnedAmount)}</strong></p>}

      <div className="form-grid">
        <div className="form-row">
          <label htmlFor="rxg-reason">Reason</label>
          <input id="rxg-reason" value={reason} onChange={e => setReason(e.target.value)} placeholder="e.g. Customer wants a different quantity" required />
        </div>
        <div className="form-row">
          <label htmlFor="rxg-staff">Staff</label>
          <input id="rxg-staff" value={staff} onChange={e => setStaff(e.target.value)} required />
        </div>
      </div>

      <label style={{ display: 'flex', alignItems: 'center', gap: 8, margin: '12px 0' }}>
        <input type="checkbox" checked={wantsReplacement} onChange={e => setWantsReplacement(e.target.checked)} />
        Customer wants a replacement (different product/quantity)
      </label>

      {wantsReplacement && (
        <>
          <LineItemsInput items={newLines} options={items} onChange={setNewLines} />
          <div className="form-row" style={{ maxWidth: 220 }}>
            <label htmlFor="rxg-method">Payment method</label>
            <select id="rxg-method" value={newMethod} onChange={e => setNewMethod(e.target.value as PosMethod)}>
              {POS_METHODS.map(m => <option key={m} value={m}>{m}</option>)}
            </select>
          </div>
          <p className="sub">New sale total: {naira(newTotal)} — created as its own transaction, linked back to {salesId}.</p>
        </>
      )}
    </Modal>
  );
}
