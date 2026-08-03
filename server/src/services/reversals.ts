import { db } from '../db/client.js';
import { nextBusinessId } from '../db/ids.js';

export interface Reversal {
  id: string; entity_type: string; entity_id: string; reversed_by: string; reason: string;
  old_value: string | null; new_value: string | null; reversed_at: string;
}

/** Module 17: "no transaction may be edited — corrections must be made through
 *  reversing transactions." This table is the single source of truth for "has this
 *  entity been reversed" — the original row's status is never rewritten (see each
 *  entity's own reverse* function in finance.ts/sales.ts/receiving.ts/production.ts/
 *  packaging.ts/materialRequests.ts), so a reversal is a new event layered on top,
 *  not a rewrite of history. */
export function isReversed(entityType: string, entityId: string): boolean {
  return !!get(entityType, entityId);
}

export function assertNotReversed(entityType: string, entityId: string): void {
  if (isReversed(entityType, entityId)) {
    throw new Error(`${entityType} ${entityId} has already been reversed`);
  }
}

export function create(params: {
  entityType: string; entityId: string; reversedBy: string; reason: string;
  oldValue?: string | null; newValue?: string | null;
}): Reversal {
  if (!params.reason || params.reason.trim().length < 8) {
    throw new Error('A reason of at least 8 characters is required to reverse a transaction');
  }
  const id = nextBusinessId('reversals', 'REV-', 5);
  // UNIQUE(entity_type, entity_id) is a defense-in-depth backstop against a double
  // reversal race, even though every caller already checks assertNotReversed first.
  db.prepare(
    `INSERT INTO reversals (id, entity_type, entity_id, reversed_by, reason, old_value, new_value) VALUES (?,?,?,?,?,?,?)`,
  ).run(id, params.entityType, params.entityId, params.reversedBy, params.reason.trim(), params.oldValue ?? null, params.newValue ?? null);
  return get(params.entityType, params.entityId)!;
}

export function get(entityType: string, entityId: string): Reversal | undefined {
  return db.prepare('SELECT * FROM reversals WHERE entity_type = ? AND entity_id = ?').get(entityType, entityId) as Reversal | undefined;
}

export function list(entityType?: string): Reversal[] {
  if (entityType) return db.prepare('SELECT * FROM reversals WHERE entity_type = ? ORDER BY id DESC').all(entityType) as unknown as Reversal[];
  return db.prepare('SELECT * FROM reversals ORDER BY id DESC').all() as unknown as Reversal[];
}
