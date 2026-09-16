import { describe, it, expect, beforeAll } from 'vitest';
import { ensureMigrated, makeItem } from '../test/fixtures.js';
import * as retailStock from './retailStock.js';
import * as inventory from './inventory.js';

beforeAll(async () => { await ensureMigrated(); });

describe('retailStock warehouse -> retail transfer (dispatch then confirm)', () => {
  it('dispatch removes central stock but does NOT credit retail until confirmed', async () => {
    const itemId = await makeItem({ type: 'FINISHED_GOOD' });
    await inventory.adjustStock(itemId, 100, 'seed');
    const centralBefore = await inventory.getBalance(itemId);

    const t = await retailStock.dispatchToRetail({ issuedBy: 'WH', items: [{ itemId, quantity: 40, unitCost: 10 }] });
    expect(t.status).toBe('SENT');
    expect(await inventory.getBalance(itemId)).toBe(centralBefore - 40); // left the warehouse
    expect(await retailStock.getBalance(itemId)).toBe(0);                 // not retail stock yet

    const confirmed = await retailStock.confirmIntake(t.id, { confirmedBy: 'Retail Sup' });
    expect(confirmed.status).toBe('CONFIRMED');
    expect(confirmed.received_quantity).toBe(40);
    expect(await retailStock.getBalance(itemId)).toBe(40);
  });

  it('a short confirmation only credits what arrived and records the shortfall', async () => {
    const itemId = await makeItem({ type: 'FINISHED_GOOD' });
    await inventory.adjustStock(itemId, 100, 'seed');

    const t = await retailStock.dispatchToRetail({ issuedBy: 'WH', items: [{ itemId, quantity: 50, unitCost: 10 }] });
    await retailStock.confirmIntake(t.id, { confirmedBy: 'Retail Sup', lines: [{ itemId, receivedQuantity: 45 }] });

    expect(await retailStock.getBalance(itemId)).toBe(45);
    const [line] = await retailStock.listIntakeItems(t.id);
    expect(line.quantity).toBe(50);
    expect(line.received_quantity).toBe(45);
  });

  it('cannot receive more than was sent, and cannot confirm twice', async () => {
    const itemId = await makeItem({ type: 'FINISHED_GOOD' });
    await inventory.adjustStock(itemId, 100, 'seed');
    const t = await retailStock.dispatchToRetail({ issuedBy: 'WH', items: [{ itemId, quantity: 10, unitCost: 10 }] });

    await expect(retailStock.confirmIntake(t.id, { confirmedBy: 'X', lines: [{ itemId, receivedQuantity: 12 }] })).rejects.toThrow();
    await retailStock.confirmIntake(t.id, { confirmedBy: 'X' });
    await expect(retailStock.confirmIntake(t.id, { confirmedBy: 'X' })).rejects.toThrow();
  });

  it('rejects a dispatch larger than central warehouse stock', async () => {
    const itemId = await makeItem({ type: 'FINISHED_GOOD' });
    await inventory.adjustStock(itemId, 5, 'seed');
    await expect(retailStock.dispatchToRetail({ issuedBy: 'WH', items: [{ itemId, quantity: 6, unitCost: 10 }] })).rejects.toThrow();
  });
});
