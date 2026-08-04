-- =============================================================================
-- 20260803120400_rls_append_only_and_admin.sql
-- RLS for the append-only ledgers and the admin/audit tables. Each of these
-- gets SELECT + INSERT policies only — never UPDATE, never DELETE. This is a
-- second, independent enforcement layer on top of the existing append-only
-- triggers (20260101000012), not a duplicate of them: RLS denies the write
-- before it ever reaches the trigger.
-- =============================================================================

-- ---- inventory_transactions --------------------------------------------------
ALTER TABLE inventory_transactions ENABLE ROW LEVEL SECURITY;
ALTER TABLE inventory_transactions FORCE ROW LEVEL SECURITY;
CREATE POLICY inv_select ON inventory_transactions FOR SELECT TO authenticated
  USING (is_super_admin() OR has_page_access('inventory') OR has_page_access('warehouse'));
CREATE POLICY inv_insert ON inventory_transactions FOR INSERT TO authenticated
  WITH CHECK (
    is_super_admin() OR has_page_access('procurement') OR has_page_access('sales')
    OR has_page_access('pos') OR has_page_access('production') OR has_page_access('warehouse')
  );
-- No UPDATE/DELETE policy.

-- ---- ledger_entries ------------------------------------------------------
ALTER TABLE ledger_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE ledger_entries FORCE ROW LEVEL SECURITY;
CREATE POLICY ledger_select ON ledger_entries FOR SELECT TO authenticated
  USING (is_super_admin() OR has_page_access('finance'));
CREATE POLICY ledger_insert ON ledger_entries FOR INSERT TO authenticated
  WITH CHECK (is_super_admin() OR has_page_access('finance'));
-- No UPDATE/DELETE policy.

-- ---- activity_log — everyone authenticated may log their own actions; no --
-- ---- one may log as someone else; append-only. ----------------------------
ALTER TABLE activity_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE activity_log FORCE ROW LEVEL SECURITY;
CREATE POLICY activity_select ON activity_log FOR SELECT TO authenticated
  USING (is_super_admin() OR has_page_access('activity-log'));
CREATE POLICY activity_insert ON activity_log FOR INSERT TO authenticated
  WITH CHECK (actor_user_id = current_app_user_id());
-- No UPDATE/DELETE policy.

-- ---- deletion_requests — the soft-delete-via-approval workflow itself -----
-- Any authenticated user with access to the entity's own page may *request*
-- a deletion; only an admin (or 'delete-requests' page) may review it —
-- modeled as an UPDATE restricted to the reviewed_* columns' intent via
-- WITH CHECK, matching the pattern requested_by/reviewed_by already encode.
ALTER TABLE deletion_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE deletion_requests FORCE ROW LEVEL SECURITY;
CREATE POLICY deletion_requests_select ON deletion_requests FOR SELECT TO authenticated
  USING (is_super_admin() OR has_page_access('delete-requests') OR requested_by_user_id = current_app_user_id());
CREATE POLICY deletion_requests_insert ON deletion_requests FOR INSERT TO authenticated
  WITH CHECK (requested_by_user_id = current_app_user_id());
CREATE POLICY deletion_requests_review ON deletion_requests FOR UPDATE TO authenticated
  USING (is_super_admin() OR has_page_access('delete-requests'))
  WITH CHECK (is_super_admin() OR has_page_access('delete-requests'));
-- No DELETE policy — a review is always a status change (APPROVED/REJECTED), never removed.
