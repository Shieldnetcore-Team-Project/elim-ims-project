import { db } from '../db/client.js';
import { nextBusinessId } from '../db/ids.js';
import * as activityLog from './activityLog.js';
import * as inventory from './inventory.js';

const EMPTY_BOTTLE_ITEM_NAME = 'Empty 20L Dispenser Bottle';
const FILLED_ITEM_NAME = '20L Dispenser';

export interface EmptyBottleRun {
  id: string; quantity_issued: number; issued_by: string | null; status: 'OPEN' | 'RECONCILED';
  damaged_quantity: number | null; leaking_quantity: number | null; finished_quantity: number | null; returned_quantity: number | null;
  actor: string | null; started_at: string; reconciled_at: string | null;
}
export interface ConditionSummary {
  goodEmpty: number; damagedEmpty: number; leakingEmpty: number; repairableEmpty: number; scrappedEmpty: number; warehouseFinishedGoods: number;
}

export function getEmptyBottleItem(): { id: string; name: string; unit_cost: number } {
  const item = db.prepare('SELECT id, name, unit_cost FROM items WHERE name = ?').get(EMPTY_BOTTLE_ITEM_NAME) as { id: string; name: string; unit_cost: number } | undefined;
  if (!item) throw new Error(`No item named "${EMPTY_BOTTLE_ITEM_NAME}" exists`);
  return item;
}

function getFilledItem(): { id: string; name: string; unit_cost: number } {
  const item = db.prepare('SELECT id, name, unit_cost FROM items WHERE name = ?').get(FILLED_ITEM_NAME) as { id: string; name: string; unit_cost: number } | undefined;
  if (!item) throw new Error(`No item named "${FILLED_ITEM_NAME}" exists`);
  return item;
}

function sumEvents(itemId: string, eventType: string, sourceState?: string): number {
  const row = sourceState
    ? db.prepare(`SELECT COALESCE(SUM(quantity), 0) AS q FROM empty_bottle_condition_events WHERE item_id = ? AND event_type = ? AND source_state = ?`).get(itemId, eventType, sourceState) as { q: number }
    : db.prepare(`SELECT COALESCE(SUM(quantity), 0) AS q FROM empty_bottle_condition_events WHERE item_id = ? AND event_type = ?`).get(itemId, eventType) as { q: number };
  return row.q;
}

export function conditionSummary(): ConditionSummary {
  const item = getEmptyBottleItem();
  const damagedEmpty = sumEvents(item.id, 'DAMAGED') - sumEvents(item.id, 'TRIAGED_TO_REPAIRABLE', 'DAMAGED') - sumEvents(item.id, 'TRIAGED_TO_SCRAPPED', 'DAMAGED');
  const leakingEmpty = sumEvents(item.id, 'LEAKING') - sumEvents(item.id, 'TRIAGED_TO_REPAIRABLE', 'LEAKING') - sumEvents(item.id, 'TRIAGED_TO_SCRAPPED', 'LEAKING');
  const repairableEmpty = sumEvents(item.id, 'TRIAGED_TO_REPAIRABLE') - sumEvents(item.id, 'REPAIRED_TO_GOOD');
  const scrappedEmpty = sumEvents(item.id, 'TRIAGED_TO_SCRAPPED');
  return {
    goodEmpty: inventory.getBalance(item.id), damagedEmpty, leakingEmpty, repairableEmpty, scrappedEmpty,
    warehouseFinishedGoods: inventory.getBalance(getFilledItem().id),
  };
}

export function listRuns(): EmptyBottleRun[] {
  return db.prepare('SELECT * FROM empty_bottle_runs ORDER BY id DESC').all() as unknown as EmptyBottleRun[];
}

export function getRun(id: string): EmptyBottleRun | undefined {
  return db.prepare('SELECT * FROM empty_bottle_runs WHERE id = ?').get(id) as EmptyBottleRun | undefined;
}

/** "Production starts with Total Empty Bottles" — pulls a specific quantity
 *  out of the Empty Bottle Warehouse for this run, which can be less than
 *  everything on hand. Mirrors marketerStock.issueStock's OUT-at-issue shape. */
export function startRun(params: { quantityIssued: number; issuedBy: string; actor?: string }): { id: string } {
  if (params.quantityIssued <= 0) throw new Error('quantityIssued must be positive');
  const item = getEmptyBottleItem();
  const available = inventory.getBalance(item.id);
  if (params.quantityIssued > available) {
    throw new Error(`Only ${available} ${item.name} available in the warehouse — cannot issue ${params.quantityIssued}`);
  }

  const actor = params.actor ?? params.issuedBy;
  const id = nextBusinessId('empty_bottle_runs', 'EBR-', 4);
  db.exec('BEGIN');
  try {
    inventory.postTransaction({
      itemId: item.id, direction: 'OUT', quantity: params.quantityIssued, unitCost: item.unit_cost,
      sourceType: 'MATERIAL_ISSUE', sourceId: id, actor,
      fromLocation: 'Finished Goods Warehouse', toLocation: 'Production Floor',
      note: `Issued to production run ${id}`,
    });
    db.prepare('INSERT INTO empty_bottle_runs (id, quantity_issued, issued_by, actor) VALUES (?,?,?,?)').run(id, params.quantityIssued, params.issuedBy, actor);
    activityLog.record(actor, 'started empty-bottle run', 'empty_bottle_run', id, `${params.quantityIssued} ${item.name} issued to production`);
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  return { id };
}

/** Reconciles a run in one call — damaged, leaking, and finished counts are
 *  always known together by the time anyone reconciles. "Must reconcile
 *  automatically": the leftover (issued − damaged − leaking − finished) is
 *  never asked for, it's computed and returned to the warehouse itself. */
export function reconcileRun(runId: string, params: { damaged: number; leaking: number; finishedProduction: number; actor: string }): { id: string; returned: number } {
  const run = getRun(runId);
  if (!run) throw new Error(`Unknown run ${runId}`);
  if (run.status !== 'OPEN') throw new Error(`${runId} is already ${run.status}`);
  if (params.damaged < 0 || params.leaking < 0 || params.finishedProduction < 0) throw new Error('Quantities cannot be negative');

  const explained = params.damaged + params.leaking + params.finishedProduction;
  if (explained > run.quantity_issued) {
    throw new Error(`Cannot account for ${explained} — only ${run.quantity_issued} was issued for ${runId}`);
  }
  const returned = run.quantity_issued - explained;

  const emptyItem = getEmptyBottleItem();
  const filledItem = getFilledItem();

  db.exec('BEGIN');
  try {
    if (params.damaged > 0) {
      db.prepare(`INSERT INTO empty_bottle_condition_events (item_id, event_type, quantity, run_id, actor) VALUES (?,'DAMAGED',?,?,?)`)
        .run(emptyItem.id, params.damaged, runId, params.actor);
    }
    if (params.leaking > 0) {
      db.prepare(`INSERT INTO empty_bottle_condition_events (item_id, event_type, quantity, run_id, actor) VALUES (?,'LEAKING',?,?,?)`)
        .run(emptyItem.id, params.leaking, runId, params.actor);
    }
    if (returned > 0) {
      inventory.postTransaction({
        itemId: emptyItem.id, direction: 'IN', quantity: returned, unitCost: emptyItem.unit_cost,
        sourceType: 'PRODUCTION', sourceId: runId, actor: params.actor,
        fromLocation: 'Production Floor', toLocation: 'Finished Goods Warehouse',
        note: `Unused, returned from production run ${runId}`,
      });
    }
    if (params.finishedProduction > 0) {
      inventory.postTransaction({
        itemId: filledItem.id, direction: 'IN', quantity: params.finishedProduction, unitCost: filledItem.unit_cost,
        sourceType: 'PRODUCTION', sourceId: runId, actor: params.actor,
        fromLocation: 'Production Floor', toLocation: 'Finished Goods Warehouse',
        note: `Finished production from empty-bottle run ${runId}`,
      });
    }
    db.prepare(`
      UPDATE empty_bottle_runs SET status = 'RECONCILED', damaged_quantity = ?, leaking_quantity = ?, finished_quantity = ?, returned_quantity = ?, reconciled_at = datetime('now')
      WHERE id = ?
    `).run(params.damaged, params.leaking, params.finishedProduction, returned, runId);

    activityLog.record(params.actor, 'reconciled empty-bottle run', 'empty_bottle_run', runId,
      `${params.damaged} damaged, ${params.leaking} leaking, ${params.finishedProduction} finished, ${returned} returned unused`);
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  return { id: runId, returned };
}

/** Damaged/leaking bottles are a deliberate later decision, not part of the
 *  reconciliation form itself — the worked example never gives repairable/
 *  scrapped counts up front. */
export function triageDefective(params: { fromState: 'DAMAGED' | 'LEAKING'; repairable: number; scrapped: number; actor: string }): void {
  if (params.repairable < 0 || params.scrapped < 0) throw new Error('Quantities cannot be negative');
  const total = params.repairable + params.scrapped;
  if (total <= 0) throw new Error('Nothing to triage');

  const item = getEmptyBottleItem();
  const summary = conditionSummary();
  const currentUntriaged = params.fromState === 'DAMAGED' ? summary.damagedEmpty : summary.leakingEmpty;
  if (total > currentUntriaged) {
    throw new Error(`Cannot triage ${total} — only ${currentUntriaged} ${params.fromState.toLowerCase()} bottles are untriaged`);
  }

  db.exec('BEGIN');
  try {
    if (params.repairable > 0) {
      db.prepare(`INSERT INTO empty_bottle_condition_events (item_id, event_type, quantity, source_state, actor) VALUES (?,'TRIAGED_TO_REPAIRABLE',?,?,?)`)
        .run(item.id, params.repairable, params.fromState, params.actor);
    }
    if (params.scrapped > 0) {
      db.prepare(`INSERT INTO empty_bottle_condition_events (item_id, event_type, quantity, source_state, actor) VALUES (?,'TRIAGED_TO_SCRAPPED',?,?,?)`)
        .run(item.id, params.scrapped, params.fromState, params.actor);
    }
    activityLog.record(params.actor, 'triaged defective empty bottles', 'item', item.id,
      `${params.fromState}: ${params.repairable} to repairable, ${params.scrapped} scrapped`);
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

/** The only point Repairable feeds back into Good — a repaired bottle
 *  physically re-enters the warehouse, so this posts a real inventory IN. */
export function completeRepair(params: { quantity: number; actor: string }): void {
  if (params.quantity <= 0) throw new Error('quantity must be positive');
  const item = getEmptyBottleItem();
  const summary = conditionSummary();
  if (params.quantity > summary.repairableEmpty) {
    throw new Error(`Cannot repair ${params.quantity} — only ${summary.repairableEmpty} are repairable`);
  }

  db.exec('BEGIN');
  try {
    db.prepare(`INSERT INTO empty_bottle_condition_events (item_id, event_type, quantity, actor) VALUES (?,'REPAIRED_TO_GOOD',?,?)`)
      .run(item.id, params.quantity, params.actor);
    inventory.postTransaction({
      itemId: item.id, direction: 'IN', quantity: params.quantity, unitCost: item.unit_cost,
      sourceType: 'ADJUSTMENT', actor: params.actor,
      fromLocation: 'Repair', toLocation: 'Finished Goods Warehouse',
      note: 'Repaired, returned to warehouse',
    });
    activityLog.record(params.actor, 'completed repair for', 'item', item.id, `${params.quantity} bottles repaired and returned to stock`);
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}
