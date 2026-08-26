-- ============================================================================
-- FIX: restore cost_price protection, close raw_materials approval-column gap
-- ----------------------------------------------------------------------------
-- 1. 20260816107000_close_direct_write_gaps.sql deliberately protected
--    products.cost_price ("only ever set via an approved Costing sheet from
--    this point on, never a direct edit" -- see apply_costing_sheet() in
--    20260816105000, which is the only legitimate writer). Today's
--    20260826090000 migration re-opened it by mistake: it granted UPDATE on
--    every products column except current_stock, not checking for this
--    earlier, narrower protection first. Restoring it now.
--
-- 2. While auditing spec section 53 (delete/direct-write restrictions),
--    found (not caused by anything above) that raw_materials.approval_status
--    could be set directly by anyone holding raw-materials:write, bypassing
--    approve_new_material()/reject_new_material() entirely -- a pending
--    material could be flipped straight to approved+active with no second
--    approver. opening_stock and created_by have the same exposure and no
--    legitimate direct-edit path either (opening_stock per spec section 31,
--    "do not overwrite the original historical value"; created_by is
--    set once by the creation trigger and never meant to change).
-- ============================================================================

REVOKE UPDATE (cost_price) ON public.products FROM authenticated;
REVOKE UPDATE (approval_status, opening_stock, created_by) ON public.raw_materials FROM authenticated;
