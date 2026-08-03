import { useEffect, useState, type FormEvent } from 'react';
import { api, apiPost } from '../../lib/apiClient';
import { naira, number } from '../../lib/format';
import { useUi } from '../../lib/uiState';
import { useCurrentUser } from '../../lib/currentUser';
import { Modal } from '../../components/ui/Modal';
import { Icon } from '../../components/ui/Icon';

interface Item { id: string; name: string }
interface ReceiptItem { item_id: string; quantity: number; unit_price: number; line_total: number }
interface ReceiptPayment { id: string; amount: number; method: string | null; received_at: string }
interface PosReceipt {
  salesId: string; createdAt: string; rep: string | null; total: number;
  items: ReceiptItem[]; payments: ReceiptPayment[]; printCount: number;
}

export function PosReceiptModal({ salesId, onClose }: { salesId: string; onClose: () => void }) {
  const ui = useUi();
  const { user } = useCurrentUser();
  const isManager = user?.role === 'Sales manager';
  const [receipt, setReceipt] = useState<PosReceipt | null>(null);
  const [items, setItems] = useState<Item[]>([]);
  const [reason, setReason] = useState('');
  const [printing, setPrinting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api<PosReceipt>(`/pos-receipts/${encodeURIComponent(salesId)}`).then(setReceipt);
    api<Item[]>('/masters/items').then(setItems);
  }, [salesId]);

  const needsApproval = (receipt?.printCount ?? 0) > 0;

  async function print(e: FormEvent) {
    e.preventDefault();
    if (needsApproval && !isManager) { setError('Only a Sales manager can approve a reprint'); return; }
    if (needsApproval && !reason.trim()) { setError('A reason is required to reprint a receipt'); return; }
    setPrinting(true); setError(null);
    try {
      await apiPost(`/pos-receipts/${encodeURIComponent(salesId)}/print`, {
        actor: user?.name ?? 'System Administrator',
        overrideUserId: needsApproval ? user?.id : undefined,
        reason: needsApproval ? reason.trim() : undefined,
      });
      window.print();
      ui.toast(needsApproval ? 'Reprint approved and recorded' : 'Receipt printed');
      onClose();
    } catch (err) { setError(err instanceof Error ? err.message : 'Something went wrong'); }
    finally { setPrinting(false); }
  }

  return (
    <Modal title={`Receipt — ${salesId}`} onClose={onClose} onSubmit={print} submitLabel={needsApproval ? 'Approve & print' : 'Print'} saving={printing} error={error}>
      {!receipt && <p className="sub">Loading…</p>}
      {receipt && (
        <>
          <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 10 }}>
            <p className="sub">{receipt.createdAt}</p>
            <p className="sub">Cashier: {receipt.rep ?? '—'}</p>
          </div>
          <div className="table-wrap">
            <table>
              <thead><tr><th>Item</th><th className="num">Qty</th><th className="num">Unit price</th><th className="num">Total</th></tr></thead>
              <tbody>
                {receipt.items.map((it, i) => (
                  <tr key={i}>
                    <td>{items.find(x => x.id === it.item_id)?.name ?? it.item_id}</td>
                    <td className="num tnum">{number(it.quantity)}</td>
                    <td className="num tnum">{naira(it.unit_price)}</td>
                    <td className="num tnum">{naira(it.line_total)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p style={{ textAlign: 'right', fontWeight: 700, margin: '8px 0' }}>Total: {naira(receipt.total)}</p>

          <p className="card-title" style={{ fontSize: 14, marginBottom: 4 }}>Payment</p>
          <div className="table-wrap">
            <table>
              <thead><tr><th>Method</th><th className="num">Amount</th></tr></thead>
              <tbody>
                {receipt.payments.map(p => (
                  <tr key={p.id}><td>{p.method}</td><td className="num tnum">{naira(p.amount)}</td></tr>
                ))}
              </tbody>
            </table>
          </div>

          {receipt.printCount > 0 && (
            <div style={{ marginTop: 14, padding: '10px 12px', border: '1px solid rgb(var(--border))', borderRadius: 8 }}>
              <p className="sub" style={{ fontWeight: 600 }}>⚠ This receipt has already been printed {receipt.printCount} time{receipt.printCount > 1 ? 's' : ''}. Reprinting requires Manager Approval.</p>
              {isManager ? (
                <div className="form-row" style={{ marginTop: 8 }}>
                  <label htmlFor="receipt-reason">Reason for reprint</label>
                  <input id="receipt-reason" value={reason} onChange={e => setReason(e.target.value)} placeholder="e.g. customer lost original receipt" required />
                  <p className="sub" style={{ marginTop: 4 }}>Approving as {user!.name} (Sales manager).</p>
                </div>
              ) : (
                <p className="sub" style={{ marginTop: 6 }}>Only a Sales manager can approve a reprint.</p>
              )}
            </div>
          )}
        </>
      )}
    </Modal>
  );
}
