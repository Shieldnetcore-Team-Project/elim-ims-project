import { describe, it, expect, beforeAll } from 'vitest';
import { db } from '../db/client.js';
import { ensureMigrated, makeItem, makeSupplier, uniqueId } from '../test/fixtures.js';
import * as receiving from './receiving.js';
import * as inventory from './inventory.js';

beforeAll(async () => { await ensureMigrated(); });

async function accountNet(account: string): Promise<number> {
  return ((await db.prepare(`SELECT COALESCE(SUM(debit) - SUM(credit), 0) AS v FROM ledger WHERE account = ?`).get(account)) as { v: number }).v;
}

describe('receiving.reverseGoodsReceived', () => {
  it('undoes the accepted-quantity inventory IN and the Inventory/Accounts payable ledger pair', async () => {
    const itemId = await makeItem();
    const supplierId = await makeSupplier();
    const poId = uniqueId('TST-PO-');
    await db.prepare(`INSERT INTO purchase_orders (id, supplier_id, status) VALUES (?,?, 'APPROVED')`).run(poId, supplierId);
    await db.prepare(`INSERT INTO purchase_order_items (po_id, item_id, quantity, unit_price) VALUES (?,?,?,?)`).run(poId, itemId, 20, 50);

    const before = { onHand: await inventory.getBalance(itemId), inv: await accountNet('Inventory'), ap: await accountNet('Accounts payable') };

    const grn = await receiving.receiveGoods({ poId, receivedBy: 'Test Receiver', items: [{ itemId, quantity: 20 }] });
    await receiving.inspectGoodsReceived(grn.id, { inspectionOfficer: 'Test Inspector', lines: [{ itemId, acceptedQuantity: 20, rejectedQuantity: 0 }] });

    const afterInspect = { onHand: await inventory.getBalance(itemId), inv: await accountNet('Inventory'), ap: await accountNet('Accounts payable') };
    expect(afterInspect.onHand - before.onHand).toBe(20);
    expect(afterInspect.inv - before.inv).toBe(1000);
    expect(afterInspect.ap - before.ap).toBe(-1000);

    await receiving.reverseGoodsReceived(grn.id, { reason: 'unit test reversal of a goods receipt', actor: 'Test Actor' });
    const afterReverse = { onHand: await inventory.getBalance(itemId), inv: await accountNet('Inventory'), ap: await accountNet('Accounts payable') };
    expect(afterReverse.onHand).toBe(before.onHand);
    expect(afterReverse.inv).toBe(before.inv);
    expect(afterReverse.ap).toBe(before.ap);

    await expect(receiving.reverseGoodsReceived(grn.id, { reason: 'a second reversal attempt', actor: 'Test Actor' })).rejects.toThrow();
  });

  it('refuses to reverse a GRN that has not been inspected yet', async () => {
    const itemId = await makeItem();
    const supplierId = await makeSupplier();
    const poId = uniqueId('TST-PO-');
    await db.prepare(`INSERT INTO purchase_orders (id, supplier_id, status) VALUES (?,?, 'APPROVED')`).run(poId, supplierId);
    await db.prepare(`INSERT INTO purchase_order_items (po_id, item_id, quantity, unit_price) VALUES (?,?,?,?)`).run(poId, itemId, 5, 10);
    const grn = await receiving.receiveGoods({ poId, receivedBy: 'Test Receiver', items: [{ itemId, quantity: 5 }] });
    await expect(receiving.reverseGoodsReceived(grn.id, { reason: 'should be refused, not inspected yet', actor: 'Test Actor' })).rejects.toThrow();
  });
});
