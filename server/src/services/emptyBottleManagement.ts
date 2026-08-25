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

export async function getEmptyBottleItem(): Promise<{ id: string; name: string; unit_cost: number }> {
  const item = await db.prepare('SELECT id, name, unit_cost FROM items WHERE name = ?').get(EMPTY_BOTTLE_ITEM_NAME) as { id: string; name: string; unit_cost: number } | undefined;
  if (!item) throw new Error(`No item named "${EMPTY_BOTTLE_ITEM_NAME}" exists`);
  return item;
}

async function getFilledItem(): Promise<{ id: string; name: string; unit_cost: number }> {
  const item = await db.prepare('SELECT id, name, unit_cost FROM items WHERE name = ?').get(FILLED_ITEM_NAME) as { id: string; name: string; unit_cost: number } | undefined;
  if (!item) throw new Error(`No item named "${FILLED_ITEM_NAME}" exists`);
  return item;
}

async function sumEvents(itemId: string, eventType: string, sourceState?: string): Promise<number> {
  const row = sourceState
    ? await db.prepare(`SELECT COALESCE(SUM(quantity), 0) AS q FROM empty_bottle_condition_events WHERE item_id = ? AND event_type = ? AND source_state = ?`).get(itemId, eventType, sourceState) as { q: number }
    : await db.prepare(`SELECT COALESCE(SUM(quantity), 0) AS q FROM empty_bottle_condition_events WHERE item_id = ? AND event_type = ?`).get(itemId, eventType) as { q: number };
  return row.q;
}

export async function conditionSummary(): Promise<ConditionSummary> {
  const item = await getEmptyBottleItem();
  const damagedEmpty = (await sumEvents(item.id, 'DAMAGED')) - (await sumEvents(item.id, 'TRIAGED_TO_REPAIRABLE', 'DAMAGED')) - (await sumEvents(item.id, 'TRIAGED_TO_SCRAPPED', 'DAMAGED'));
  const leakingEmpty = (await sumEvents(item.id, 'LEAKING')) - (await sumEvents(item.id, 'TRIAGED_TO_REPAIRABLE', 'LEAKING')) - (await sumEvents(item.id, 'TRIAGED_TO_SCRAPPED', 'LEAKING'));
  const repairableEmpty = (await sumEvents(item.id, 'TRIAGED_TO_REPAIRABLE')) - (await sumEvents(item.id, 'REPAIRED_TO_GOOD'));
  const scrappedEmpty = await sumEvents(item.id, 'TRIAGED_TO_SCRAPPED');
  return {
    goodEmpty: await inventory.getBalance(item.id), damagedEmpty, leakingEmpty, repairableEmpty, scrappedEmpty,
    warehouseFinishedGoods: await inventory.getBalance((await getFilledItem()).id),
  };
}

export async function listRuns(): Promise<EmptyBottleRun[]> {
  return await db.prepare('SELECT * FROM empty_bottle_runs ORDER BY id DESC').all() as unknown as EmptyBottleRun[];
}

export async function getRun(id: string): Promise<EmptyBottleRun | undefined> {
  return await db.prepare('SELECT * FROM empty_bottle_runs WHERE id = ?').get(id) as EmptyBottleRun | undefined;
}

/** "Production starts with Total Empty Bottles" — pulls a specific quantity
 *  out of the Empty Bottle Warehouse for this run, which can be less than
 *  everything on hand. Mirrors marketerStock.issueStock's OUT-at-issue shape. */
export async function startRun(params: { quantityIssued: number; issuedBy: string; actor?: string }): Promise<{ id: string }> {
  if (params.quantityIssued <= 0) throw new Error('quantityIssued must be positive');
  const item = await getEmptyBottleItem();
  const available = await inventory.getBalance(item.id);
  if (params.quantityIssued > available) {
    throw new Error(`Only ${available} ${item.name} available in the warehouse — cannot issue ${params.quantityIssued}`);
  }

  const actor = params.actor ?? params.issuedBy;
  const id = await nextBusinessId('empty_bottle_runs', 'EBR-', 4);
  await db.transaction(async () => {
    await inventory.postTransaction({
      itemId: item.id, direction: 'OUT', quantity: params.quantityIssued, unitCost: item.unit_cost,
      sourceType: 'MATERIAL_ISSUE', sourceId: id, actor,
      fromLocation: 'Finished Goods Warehouse', toLocation: 'Production Floor',
      note: `Issued to production run ${id}`,
    });
    await db.prepare('INSERT INTO empty_bottle_runs (id, quantity_issued, issued_by, actor) VALUES (?,?,?,?)').run(id, params.quantityIssued, params.issuedBy, actor);
    await activityLog.record(actor, 'started empty-bottle run', 'empty_bottle_run', id, `${params.quantityIssued} ${item.name} issued to production`);
  });
  return { id };
}

/** Reconciles a run in one call — damaged, leaking, and finished counts are
 *  always known together by the time anyone reconciles. "Must reconcile
 *  automatically": the leftover (issued − damaged − leaking − finished) is
 *  never asked for, it's computed and returned to the warehouse itself. */
export async function reconcileRun(runId: string, params: { damaged: number; leaking: number; finishedProduction: number; actor: string }): Promise<{ id: string; returned: number }> {
  const run = await getRun(runId);
  if (!run) throw new Error(`Unknown run ${runId}`);
  if (run.status !== 'OPEN') throw new Error(`${runId} is already ${run.status}`);
  if (params.damaged < 0 || params.leaking < 0 || params.finishedProduction < 0) throw new Error('Quantities cannot be negative');

  const explained = params.damaged + params.leaking + params.finishedProduction;
  if (explained > run.quantity_issued) {
    throw new Error(`Cannot account for ${explained} — only ${run.quantity_issued} was issued for ${runId}`);
  }
  const returned = run.quantity_issued - explained;

  const emptyItem = await getEmptyBottleItem();
  const filledItem = await getFilledItem();

  await db.transaction(async () => {
    if (params.damaged > 0) {
      await db.prepare(`INSERT INTO empty_bottle_condition_events (item_id, event_type, quantity, run_id, actor) VALUES (?,'DAMAGED',?,?,?)`)
        .run(emptyItem.id, params.damaged, runId, params.actor);
    }
    if (params.leaking > 0) {
      await db.prepare(`INSERT INTO empty_bottle_condition_events (item_id, event_type, quantity, run_id, actor) VALUES (?,'LEAKING',?,?,?)`)
        .run(emptyItem.id, params.leaking, runId, params.actor);
    }
    if (returned > 0) {
      await inventory.postTransaction({
        itemId: emptyItem.id, direction: 'IN', quantity: returned, unitCost: emptyItem.unit_cost,
        sourceType: 'PRODUCTION', sourceId: runId, actor: params.actor,
        fromLocation: 'Production Floor', toLocation: 'Finished Goods Warehouse',
        note: `Unused, returned from production run ${runId}`,
      });
    }
    if (params.finishedProduction > 0) {
      await inventory.postTransaction({
        itemId: filledItem.id, direction: 'IN', quantity: params.finishedProduction, unitCost: filledItem.unit_cost,
        sourceType: 'PRODUCTION', sourceId: runId, actor: params.actor,
        fromLocation: 'Production Floor', toLocation: 'Finished Goods Warehouse',
        note: `Finished production from empty-bottle run ${runId}`,
      });
    }
    await db.prepare(`
      UPDATE empty_bottle_runs SET status = 'RECONCILED', damaged_quantity = ?, leaking_quantity = ?, finished_quantity = ?, returned_quantity = ?, reconciled_at = now()
      WHERE id = ?
    `).run(params.damaged, params.leaking, params.finishedProduction, returned, runId);

    await activityLog.record(params.actor, 'reconciled empty-bottle run', 'empty_bottle_run', runId,
      `${params.damaged} damaged, ${params.leaking} leaking, ${params.finishedProduction} finished, ${returned} returned unused`);
  });
  return { id: runId, returned };
}

/** Damaged/leaking bottles are a deliberate later decision, not part of the
 *  reconciliation form itself — the worked example never gives repairable/
 *  scrapped counts up front. */
export async function triageDefective(params: { fromState: 'DAMAGED' | 'LEAKING'; repairable: number; scrapped: number; actor: string }): Promise<void> {
  if (params.repairable < 0 || params.scrapped < 0) throw new Error('Quantities cannot be negative');
  const total = params.repairable + params.scrapped;
  if (total <= 0) throw new Error('Nothing to triage');

  const item = await getEmptyBottleItem();
  const summary = await conditionSummary();
  const currentUntriaged = params.fromState === 'DAMAGED' ? summary.damagedEmpty : summary.leakingEmpty;
  if (total > currentUntriaged) {
    throw new Error(`Cannot triage ${total} — only ${currentUntriaged} ${params.fromState.toLowerCase()} bottles are untriaged`);
  }

  await db.transaction(async () => {
    if (params.repairable > 0) {
      await db.prepare(`INSERT INTO empty_bottle_condition_events (item_id, event_type, quantity, source_state, actor) VALUES (?,'TRIAGED_TO_REPAIRABLE',?,?,?)`)
        .run(item.id, params.repairable, params.fromState, params.actor);
    }
    if (params.scrapped > 0) {
      await db.prepare(`INSERT INTO empty_bottle_condition_events (item_id, event_type, quantity, source_state, actor) VALUES (?,'TRIAGED_TO_SCRAPPED',?,?,?)`)
        .run(item.id, params.scrapped, params.fromState, params.actor);
    }
    await activityLog.record(params.actor, 'triaged defective empty bottles', 'item', item.id,
      `${params.fromState}: ${params.repairable} to repairable, ${params.scrapped} scrapped`);
  });
}

/** The only point Repairable feeds back into Good — a repaired bottle
 *  physically re-enters the warehouse, so this posts a real inventory IN. */
export async function completeRepair(params: { quantity: number; actor: string }): Promise<void> {
  if (params.quantity <= 0) throw new Error('quantity must be positive');
  const item = await getEmptyBottleItem();
  const summary = await conditionSummary();
  if (params.quantity > summary.repairableEmpty) {
    throw new Error(`Cannot repair ${params.quantity} — only ${summary.repairableEmpty} are repairable`);
  }

  await db.transaction(async () => {
    await db.prepare(`INSERT INTO empty_bottle_condition_events (item_id, event_type, quantity, actor) VALUES (?,'REPAIRED_TO_GOOD',?,?)`)
      .run(item.id, params.quantity, params.actor);
    await inventory.postTransaction({
      itemId: item.id, direction: 'IN', quantity: params.quantity, unitCost: item.unit_cost,
      sourceType: 'ADJUSTMENT', actor: params.actor,
      fromLocation: 'Repair', toLocation: 'Finished Goods Warehouse',
      note: 'Repaired, returned to warehouse',
    });
    await activityLog.record(params.actor, 'completed repair for', 'item', item.id, `${params.quantity} bottles repaired and returned to stock`);
  });
}
