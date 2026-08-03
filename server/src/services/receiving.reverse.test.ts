import { describe, it, expect, beforeAll } from 'vitest';
import { db } from '../db/client.js';
import { ensureMigrated, makeItem, makeSupplier, uniqueId } from '../test/fixtures.js';
import * as receiving from './receiving.js';
import * as inventory from './inventory.js';

beforeAll(() => ensureMigrated());

function accountNet(account: string): number {
  return (db.prepare(`SELECT COALESCE(SUM(debit) - SUM(credit), 0) AS v FROM ledger WHERE account = ?`).get(account) as { v: number }).v;
}

describe('receiving.reverseGoodsReceived', () => {
  it('undoes the accepted-quantity inventory IN and the Inventory/Accounts payable ledger pair', () => {
    const itemId = makeItem();
    const supplierId = makeSupplier();
    const poId = uniqueId('TST-PO-');
    db.prepare(`INSERT INTO purchase_orders (id, supplier_id, status) VALUES (?,?, 'APPROVED')`).run(poId, supplierId);
    db.prepare(`INSERT INTO purchase_order_items (po_id, item_id, quantity, unit_price) VALUES (?,?,?,?)`).run(poId, itemId, 20, 50);

    const before = { onHand: inventory.getBalance(itemId), inv: accountNet('Inventory'), ap: accountNet('Accounts payable') };

    const grn = receiving.receiveGoods({ poId, receivedBy: 'Test Receiver', items: [{ itemId, quantity: 20 }] });
    receiving.inspectGoodsReceived(grn.id, { inspectionOfficer: 'Test Inspector', lines: [{ itemId, acceptedQuantity: 20, rejectedQuantity: 0 }] });

    const afterInspect = { onHand: inventory.getBalance(itemId), inv: accountNet('Inventory'), ap: accountNet('Accounts payable') };
    expect(afterInspect.onHand - before.onHand).toBe(20);
    expect(afterInspect.inv - before.inv).toBe(1000);
    expect(afterInspect.ap - before.ap).toBe(-1000);

    receiving.reverseGoodsReceived(grn.id, { reason: 'unit test reversal of a goods receipt', actor: 'Test Actor' });
    const afterReverse = { onHand: inventory.getBalance(itemId), inv: accountNet('Inventory'), ap: accountNet('Accounts payable') };
    expect(afterReverse.onHand).toBe(before.onHand);
    expect(afterReverse.inv).toBe(before.inv);
    expect(afterReverse.ap).toBe(before.ap);

    expect(() => receiving.reverseGoodsReceived(grn.id, { reason: 'a second reversal attempt', actor: 'Test Actor' })).toThrow();
  });

  it('refuses to reverse a GRN that has not been inspected yet', () => {
    const itemId = makeItem();
    const supplierId = makeSupplier();
    const poId = uniqueId('TST-PO-');
    db.prepare(`INSERT INTO purchase_orders (id, supplier_id, status) VALUES (?,?, 'APPROVED')`).run(poId, supplierId);
    db.prepare(`INSERT INTO purchase_order_items (po_id, item_id, quantity, unit_price) VALUES (?,?,?,?)`).run(poId, itemId, 5, 10);
    const grn = receiving.receiveGoods({ poId, receivedBy: 'Test Receiver', items: [{ itemId, quantity: 5 }] });
    expect(() => receiving.reverseGoodsReceived(grn.id, { reason: 'should be refused, not inspected yet', actor: 'Test Actor' })).toThrow();
  });
});
