import { db } from '../db/client.js';
import { nextBusinessId } from '../db/ids.js';
import * as activityLog from './activityLog.js';
import * as inventory from './inventory.js';
import * as reversals from './reversals.js';

export interface ProductionLogItem { item_id: string; item_name: string; quantity: number }
export interface ProductionLogEntry {
  id: string; recorded_by: string | null; note: string | null; recorded_at: string;
  items: ProductionLogItem[]; total_quantity: number;
}

interface EntryLineInput { itemId: string; quantity: number }

/** The day-to-day production entry: an operator records what was produced at any
 *  time and every line posts straight into the Finished Goods Warehouse ledger.
 *  No line/shift/QC gate — production_batches is still there for runs that need
 *  formal quality tracking. Written in one transaction so a bad line fails the
 *  whole entry rather than leaving a partial stock posting. */
export async function recordEntry(params: {
  recordedBy: string; note?: string | null; items: EntryLineInput[]; actor?: string;
}): Promise<ProductionLogEntry> {
  const actor = params.actor ?? params.recordedBy;
  const lines = (params.items ?? []).filter(l => l && l.itemId);
  if (lines.length === 0) throw new Error('At least one product line is required');
  for (const l of lines) {
    if (!(l.quantity > 0)) throw new Error('Every product line needs a quantity greater than zero');
  }

  return await db.transaction(async () => {
    const id = await nextBusinessId('production_log_entries', 'PL-', 5);
    await db.prepare(
      `INSERT INTO production_log_entries (id, recorded_by, note) VALUES (?,?,?)`,
    ).run(id, params.recordedBy, params.note?.trim() || null);

    for (const l of lines) {
      await db.prepare(
        `INSERT INTO production_log_items (entry_id, item_id, quantity) VALUES (?,?,?)`,
      ).run(id, l.itemId, l.quantity);
      await inventory.postTransaction({
        itemId: l.itemId, direction: 'IN', quantity: l.quantity,
        sourceType: 'PRODUCTION', sourceId: id, actor,
        fromLocation: 'Production Floor', toLocation: 'Finished Goods Warehouse',
        note: `Production log ${id}`,
      });
    }

    const total = lines.reduce((s, l) => s + l.quantity, 0);
    await activityLog.record(
      actor, 'recorded', 'production_log', id,
      `Production log ${id}: ${total} unit(s) across ${lines.length} product line(s)`,
    );
    return (await getEntry(id))!;
  });
}

/** Module 17 reversal: posts an offsetting OUT for every line so warehouse stock
 *  returns to where it was. The entry row itself is never edited or deleted. */
export async function reverseEntry(id: string, params: { reason: string; actor: string }): Promise<{ reversal: reversals.Reversal; entry: ProductionLogEntry }> {
  const entry = await getEntry(id);
  if (!entry) throw new Error(`Unknown production log entry ${id}`);
  await reversals.assertNotReversed('production_log_entries', id);

  return await db.transaction(async () => {
    for (const line of entry.items) {
      await inventory.postTransaction({
        itemId: line.item_id, direction: 'OUT', quantity: line.quantity,
        sourceType: 'PRODUCTION', sourceId: id, actor: params.actor,
        fromLocation: 'Finished Goods Warehouse', toLocation: 'Production Floor',
        note: `Reversal of production log ${id}`,
      });
    }
    const reversal = await reversals.create({
      entityType: 'production_log_entries', entityId: id, reversedBy: params.actor, reason: params.reason,
      oldValue: JSON.stringify({ total_quantity: entry.total_quantity }), newValue: JSON.stringify({ total_quantity: 0 }),
    });
    await activityLog.record(
      params.actor, 'reversed', 'production_log', id,
      `Production log ${id} (${entry.total_quantity} unit(s)) reversed`,
      { oldValue: reversal.old_value, newValue: reversal.new_value, reason: reversal.reason },
    );
    return { reversal, entry: (await getEntry(id))! };
  });
}

export async function getEntry(id: string): Promise<ProductionLogEntry | undefined> {
  const rows = await listEntries();
  return rows.find(e => e.id === id);
}

export async function listEntries(): Promise<ProductionLogEntry[]> {
  const rows = await db.prepare(`
    SELECT e.id, e.recorded_by, e.note, e.recorded_at,
      COALESCE(
        json_agg(json_build_object('item_id', li.item_id, 'item_name', i.name, 'quantity', li.quantity) ORDER BY li.id)
          FILTER (WHERE li.id IS NOT NULL),
        '[]'
      ) AS items
    FROM production_log_entries e
    LEFT JOIN production_log_items li ON li.entry_id = e.id
    LEFT JOIN items i ON i.id = li.item_id
    GROUP BY e.id, e.recorded_by, e.note, e.recorded_at
    ORDER BY e.recorded_at DESC, e.id DESC
  `).all() as { id: string; recorded_by: string | null; note: string | null; recorded_at: string; items: ProductionLogItem[] }[];

  return rows.map(r => ({
    ...r,
    items: r.items ?? [],
    total_quantity: (r.items ?? []).reduce((s, l) => s + l.quantity, 0),
  }));
}
