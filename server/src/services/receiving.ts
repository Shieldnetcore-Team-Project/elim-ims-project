import { db } from '../db/client.js';
import { nextBusinessId } from '../db/ids.js';
import * as activityLog from './activityLog.js';
import * as procurement from './procurement.js';
import * as inventory from './inventory.js';
import * as finance from './finance.js';
import * as reversals from './reversals.js';

export interface GoodsReceived {
  id: string; po_id: string; received_by: string | null;
  driver_name: string | null; driver_phone: string | null; vehicle_number: string | null;
  delivery_date: string | null; invoice_number: string | null; waybill_number: string | null;
  inspection_officer: string | null; inspected_at: string | null;
  status: string; received_at: string;
}
export interface GoodsReceivedItem {
  id: number; grn_id: string; item_id: string;
  expected_quantity: number | null; quantity: number;
  accepted_quantity: number | null; rejected_quantity: number | null;
  short_quantity: number | null; over_quantity: number | null; rejection_reason: string | null;
}
export interface InspectionLine { itemId: string; acceptedQuantity: number; rejectedQuantity: number; rejectionReason?: string }

/** Records a delivery against a PO — driver/vehicle/invoice/waybill detail plus what
 *  was physically delivered per line. expected_quantity is snapshotted from the PO's
 *  own line here (never taken from the caller — it's a fact the system already has).
 *  Never touches inventory_transactions — nothing posts to stock until inspectGoodsReceived
 *  below decides what's accepted. */
export async function receiveGoods(params: {
  poId: string; receivedBy: string;
  items: { itemId: string; quantity: number; bagQuantity?: number }[];
  driverName?: string; driverPhone?: string; vehicleNumber?: string;
  deliveryDate?: string; invoiceNumber?: string; waybillNumber?: string;
  actor?: string;
}): Promise<GoodsReceived> {
  const id = await nextBusinessId('goods_received', 'GRN-2026-', 5);
  await db.prepare(
    `INSERT INTO goods_received (id, po_id, received_by, driver_name, driver_phone, vehicle_number, delivery_date, invoice_number, waybill_number)
     VALUES (?,?,?,?,?,?,?,?,?)`,
  ).run(
    id, params.poId, params.receivedBy, params.driverName ?? null, params.driverPhone ?? null,
    params.vehicleNumber ?? null, params.deliveryDate ?? null, params.invoiceNumber ?? null, params.waybillNumber ?? null,
  );

  const expectedFor = db.prepare('SELECT quantity FROM purchase_order_items WHERE po_id = ? AND item_id = ?');
  const insertItem = db.prepare('INSERT INTO goods_received_items (grn_id, item_id, expected_quantity, quantity) VALUES (?,?,?,?)');
  for (const it of params.items) {
    const expected = (await expectedFor.get(params.poId, it.itemId) as { quantity: number } | undefined)?.quantity ?? null;
    await insertItem.run(id, it.itemId, expected, await procurement.resolveQuantity(it.itemId, it.quantity, it.bagQuantity));
  }
  await procurement.setStatus(params.poId, 'RECEIVED', params.actor ?? params.receivedBy);
  await activityLog.record(params.actor ?? params.receivedBy, 'recorded', 'goods_received', id, `Goods receipt ${id} against ${params.poId}, pending inspection`);
  return (await getGoodsReceived(id))!;
}

/** The only path that moves a GRN out of PENDING_INSPECTION, and the only place that
 *  posts inventory for a purchase — see services/qualityControl.ts for why the old
 *  QC pass/fail verdict no longer does either of those for a goods receipt. Only the
 *  accepted quantity per line ever reaches inventory_transactions; any rejected
 *  quantity raises a linked supplier_returns record instead. Validated in full before
 *  anything is written, then applied inside one transaction. */
export async function inspectGoodsReceived(grnId: string, params: {
  inspectionOfficer: string; lines: InspectionLine[]; actor?: string;
}): Promise<GoodsReceived> {
  const grn = await getGoodsReceived(grnId);
  if (!grn) throw new Error(`Unknown goods receipt ${grnId}`);
  if (grn.status !== 'PENDING_INSPECTION') throw new Error(`${grnId} has already been inspected (status ${grn.status})`);

  const items = await listItemsFor(grnId);
  const byItem = new Map(items.map(it => [it.item_id, it]));

  for (const line of params.lines) {
    const item = byItem.get(line.itemId);
    if (!item) throw new Error(`${line.itemId} is not on goods receipt ${grnId}`);
    if (line.acceptedQuantity < 0 || line.rejectedQuantity < 0) {
      throw new Error(`${line.itemId}: accepted/rejected quantity cannot be negative`);
    }
    if (line.acceptedQuantity + line.rejectedQuantity !== item.quantity) {
      throw new Error(`${line.itemId}: accepted (${line.acceptedQuantity}) + rejected (${line.rejectedQuantity}) must equal delivered (${item.quantity})`);
    }
  }

  const actor = params.actor ?? params.inspectionOfficer;
  const totalAccepted = params.lines.reduce((s, l) => s + l.acceptedQuantity, 0);
  const totalRejected = params.lines.reduce((s, l) => s + l.rejectedQuantity, 0);
  const status = totalRejected === 0 ? 'ACCEPTED' : totalAccepted === 0 ? 'REJECTED' : 'PARTIALLY_ACCEPTED';
  const rejectedLines = params.lines.filter(l => l.rejectedQuantity > 0);

  const supplierId = (await db.prepare('SELECT supplier_id FROM purchase_orders WHERE id = ?').get(grn.po_id) as { supplier_id: string }).supplier_id;
  const priceFor = db.prepare('SELECT unit_price FROM purchase_order_items WHERE po_id = ? AND item_id = ?');

  await db.transaction(async () => {
    let acceptedValue = 0;
    for (const line of params.lines) {
      const item = byItem.get(line.itemId)!;
      const expected = item.expected_quantity ?? item.quantity;
      const short = Math.max(expected - item.quantity, 0);
      const over = Math.max(item.quantity - expected, 0);
      await db.prepare(
        `UPDATE goods_received_items SET accepted_quantity=?, rejected_quantity=?, short_quantity=?, over_quantity=?, rejection_reason=? WHERE id=?`,
      ).run(line.acceptedQuantity, line.rejectedQuantity, short, over, line.rejectionReason ?? null, item.id);

      if (line.acceptedQuantity > 0) {
        await inventory.postTransaction({
          itemId: line.itemId, direction: 'IN', quantity: line.acceptedQuantity,
          sourceType: 'PURCHASE', sourceId: grnId, actor,
          fromLocation: 'Supplier', toLocation: 'Raw Material Store',
          note: `Accepted at inspection of ${grnId}`,
        });
        const unitPrice = (await priceFor.get(grn.po_id, line.itemId) as { unit_price: number } | undefined)?.unit_price ?? 0;
        acceptedValue += line.acceptedQuantity * unitPrice;
      }
    }

    await db.prepare(`UPDATE goods_received SET status=?, inspection_officer=?, inspected_at=now() WHERE id=?`)
      .run(status, params.inspectionOfficer, grnId);

    // Only accepted goods become a payable — a rejected quantity never enters
    // inventory (above) and correspondingly never owes the supplier anything.
    await finance.postSupplierInvoice({
      supplierId, amount: acceptedValue, referenceId: grnId,
      description: `Goods accepted on ${grnId}`, actor,
    });

    let returnId: string | null = null;
    if (rejectedLines.length > 0) {
      returnId = await nextBusinessId('supplier_returns', 'SRN-', 4);
      await db.prepare('INSERT INTO supplier_returns (id, grn_id, po_id, supplier_id, created_by) VALUES (?,?,?,?,?)')
        .run(returnId, grnId, grn.po_id, supplierId, actor);
      const insertReturnItem = db.prepare('INSERT INTO supplier_return_items (return_id, item_id, quantity, reason) VALUES (?,?,?,?)');
      for (const l of rejectedLines) await insertReturnItem.run(returnId, l.itemId, l.rejectedQuantity, l.rejectionReason ?? null);
    }

    await activityLog.record(
      actor, 'inspected', 'goods_received', grnId,
      `${grnId} inspected by ${params.inspectionOfficer}: ${totalAccepted} accepted, ${totalRejected} rejected${returnId ? `, return ${returnId} raised` : ''}`,
    );
  });

  return (await getGoodsReceived(grnId))!;
}

/** Module 17 reversal: undoes the inventory IN (accepted quantity per line) and the
 *  Inventory/Accounts payable ledger pair inspectGoodsReceived posted — status is
 *  never mutated (see reversals.ts). Only callable once actually inspected. */
export async function reverseGoodsReceived(grnId: string, params: { reason: string; actor: string }): Promise<{ reversal: reversals.Reversal; grn: GoodsReceived }> {
  const grn = await getGoodsReceived(grnId);
  if (!grn) throw new Error(`Unknown goods receipt ${grnId}`);
  if (grn.status === 'PENDING_INSPECTION') throw new Error(`${grnId} hasn't been inspected yet — nothing to reverse`);
  await reversals.assertNotReversed('goods_received', grnId);

  const supplierId = (await db.prepare('SELECT supplier_id FROM purchase_orders WHERE id = ?').get(grn.po_id) as { supplier_id: string }).supplier_id;
  const priceFor = db.prepare('SELECT unit_price FROM purchase_order_items WHERE po_id = ? AND item_id = ?');

  return await db.transaction(async () => {
    let acceptedValue = 0;
    for (const item of await listItemsFor(grnId)) {
      if (!item.accepted_quantity || item.accepted_quantity <= 0) continue;
      await inventory.postTransaction({
        itemId: item.item_id, direction: 'OUT', quantity: item.accepted_quantity,
        sourceType: 'PURCHASE', sourceId: grnId, actor: params.actor,
        fromLocation: 'Raw Material Store', toLocation: 'Supplier',
        note: `Reversal of ${grnId}`,
      });
      const unitPrice = (await priceFor.get(grn.po_id, item.item_id) as { unit_price: number } | undefined)?.unit_price ?? 0;
      acceptedValue += item.accepted_quantity * unitPrice;
    }

    if (acceptedValue > 0) {
      await finance.postLedger({ account: 'Accounts payable', debit: acceptedValue, credit: 0, referenceType: 'goods_received_reversal', referenceId: grnId, description: `Reversal of goods accepted on ${grnId}`, actor: params.actor, supplierId });
      await finance.postLedger({ account: 'Inventory', debit: 0, credit: acceptedValue, referenceType: 'goods_received_reversal', referenceId: grnId, description: `Reversal of goods accepted on ${grnId}`, actor: params.actor });
    }

    const reversal = await reversals.create({
      entityType: 'goods_received', entityId: grnId, reversedBy: params.actor, reason: params.reason,
      oldValue: JSON.stringify({ acceptedValue }), newValue: JSON.stringify({ acceptedValue: 0 }),
    });
    await activityLog.record(
      params.actor, 'reversed', 'goods_received', grnId,
      `Goods receipt ${grnId} (₦${acceptedValue.toLocaleString('en-NG')} accepted) reversed`,
      { oldValue: reversal.old_value, newValue: reversal.new_value, reason: reversal.reason },
    );
    return { reversal, grn: (await getGoodsReceived(grnId))! };
  });
}

/** Writer of goods_received.status for transitions that aren't the inspection
 *  itself — currently just supplierReturns.markCompleted flipping a GRN to RETURNED. */
export async function setStatus(id: string, status: string, actor = 'System Administrator'): Promise<void> {
  await db.prepare('UPDATE goods_received SET status = ? WHERE id = ?').run(status, id);
  await activityLog.record(actor, 'updated status of', 'goods_received', id, `Goods receipt ${id} → ${status}`);
}

export async function getGoodsReceived(id: string): Promise<GoodsReceived | undefined> {
  return await db.prepare('SELECT * FROM goods_received WHERE id = ?').get(id) as GoodsReceived | undefined;
}

export async function listItemsFor(grnId: string): Promise<GoodsReceivedItem[]> {
  return await db.prepare('SELECT * FROM goods_received_items WHERE grn_id = ?').all(grnId) as unknown as GoodsReceivedItem[];
}

export async function listGoodsReceived() {
  return await db.prepare(`
    SELECT gr.*, po.supplier_id, s.name AS supplier_name
    FROM goods_received gr
    JOIN purchase_orders po ON po.id = gr.po_id
    JOIN suppliers s ON s.id = po.supplier_id
    ORDER BY gr.id DESC
  `).all();
}

/** GRNs awaiting inspection — backs both the (retired) Quality Control "goods
 *  received" list and the new Procurement "Pending inspection" tab. */
export async function pendingQc() {
  return await db.prepare(`
    SELECT gr.*, po.supplier_id, s.name AS supplier_name
    FROM goods_received gr
    JOIN purchase_orders po ON po.id = gr.po_id
    JOIN suppliers s ON s.id = po.supplier_id
    WHERE gr.status = 'PENDING_INSPECTION'
    ORDER BY gr.id DESC
  `).all();
}
