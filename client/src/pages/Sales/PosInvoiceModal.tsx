import { useEffect, useState, type FormEvent } from 'react';
import { api, apiPost } from '../../lib/apiClient';
import { naira, number } from '../../lib/format';
import { useUi } from '../../lib/uiState';
import { useCurrentUser } from '../../lib/currentUser';
import { Modal } from '../../components/ui/Modal';
import { PrintHeader } from '../../components/ui/PrintHeader';

interface Item { id: string; name: string }
interface ReceiptItem { item_id: string; quantity: number; unit_price: number; line_total: number }
interface ReceiptPayment { id: string; amount: number; method: string | null; received_at: string }
interface PosReceipt {
  salesId: string; createdAt: string; rep: string | null; total: number;
  items: ReceiptItem[]; payments: ReceiptPayment[];
}

/** The formal document a retail customer can request for their own records —
 *  Section 9's "Print invoice", distinct from the till Receipt. Carries the
 *  company letterhead (PrintHeader) and the customer's name, unlike the
 *  Receipt which is a short till slip. Reprinting is unrestricted (see
 *  posReceipts.recordPrint) — still logged for the audit trail, just not
 *  gated behind manager approval like a receipt reprint. */
export function PosInvoiceModal({ salesId, customerName, customerLocation, onClose }: {
  salesId: string; customerName: string; customerLocation: string | null; onClose: () => void;
}) {
  const ui = useUi();
  const { user } = useCurrentUser();
  const [receipt, setReceipt] = useState<PosReceipt | null>(null);
  const [items, setItems] = useState<Item[]>([]);
  const [printing, setPrinting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api<PosReceipt>(`/pos-receipts/${encodeURIComponent(salesId)}`).then(setReceipt);
    api<Item[]>('/masters/items').then(setItems);
  }, [salesId]);

  async function print(e: FormEvent) {
    e.preventDefault();
    setPrinting(true); setError(null);
    try {
      await apiPost(`/pos-receipts/${encodeURIComponent(salesId)}/print`, {
        actor: user?.name ?? 'System Administrator', documentType: 'INVOICE',
      });
      window.print();
      ui.toast('Invoice printed');
      onClose();
    } catch (err) { setError(err instanceof Error ? err.message : 'Something went wrong'); }
    finally { setPrinting(false); }
  }

  return (
    <Modal title={`Invoice — ${salesId}`} onClose={onClose} onSubmit={print} submitLabel="Print" saving={printing} error={error}>
      <PrintHeader />
      {!receipt && <p className="sub">Loading…</p>}
      {receipt && (
        <>
          <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 10 }}>
            <div>
              <p style={{ fontWeight: 500 }}>{customerName}</p>
              {customerLocation && <p className="sub">{customerLocation}</p>}
            </div>
            <div style={{ textAlign: 'right' }}>
              <p className="sub">{receipt.createdAt}</p>
              <p className="sub">Sold by: {receipt.rep ?? '—'}</p>
            </div>
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
        </>
      )}
    </Modal>
  );
}
