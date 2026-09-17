-- ============================================================================
-- FIX: current_value backfill from 20260922180000 was wrong for materials
-- that already had transaction history.
-- ----------------------------------------------------------------------------
-- That migration seeded current_value as `current_stock * unit_cost` for
-- every existing row. unit_cost is just the LAST received cost (confirm_
-- goods_receipt overwrites it on every receipt), so applying it to the
-- material's ENTIRE stock overstated the value of any stock actually
-- received at an earlier, different cost -- e.g. PREFORM: 2,590 units on
-- hand, last cost ₦10 → wrongly seeded as ₦25,900, when the movement ledger
-- (opening balance @₦8 + three receipts @₦8/₦10/₦20) actually totals ₦24,900.
--
-- Every raw_material_movements row already stores the cost that was
-- genuinely in effect for that specific transaction, and quantity_before/
-- quantity_after give its exact signed effect on stock -- so the correct
-- current_value is just the sum of (quantity_after - quantity_before) *
-- that row's own unit_cost across a material's full history. This replaces
-- the flawed backfill with that reconstruction. Materials with no movement
-- rows at all keep the original current_stock * unit_cost fallback (nothing
-- to reconstruct from).
-- ============================================================================

UPDATE public.raw_materials rm
SET current_value = COALESCE(
  (SELECT SUM((m.quantity_after - m.quantity_before) * COALESCE(m.unit_cost, 0))
   FROM public.raw_material_movements m
   WHERE m.material_id = rm.id),
  rm.current_stock * rm.unit_cost
);
