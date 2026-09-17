-- ============================================================================
-- REALTIME: add the remaining tables behind the new "pending attention"
-- counts (src/lib/pending-attention.ts) — sidebar badges, notification bell,
-- and Approval Center — so they update live like everything else this
-- session already wired up, instead of only refreshing on next mount.
-- ============================================================================

ALTER PUBLICATION supabase_realtime ADD TABLE
  public.costing_sheets,
  public.staff_deductions,
  public.staff_loans;
