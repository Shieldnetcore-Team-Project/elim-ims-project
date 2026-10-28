-- ============================================================================
-- Warehouse postings are confirmed by Accounts, and notifications clear live
-- ----------------------------------------------------------------------------
-- The user's rules (2026-10-28):
--   * a sale posted from the Warehouse to a distributor no longer waits on
--     the Sales (Retail) approval queue: it goes to Accounts (Accountant →
--     Postings to assess), which confirms it -- posting it: stock out,
--     receipts, debt, ledger -- and prints the receipt;
--   * a notification clears, on every open page, as soon as what it asks for
--     has been attended to -- nobody should have to refresh.
--
-- A Warehouse posting to a distributor is what accounting_postings() already
-- lists as one: a sale to a registered customer, not from a marketer's or the
-- shop's stock, not a PR.
--
--   is_warehouse_posting(sales)       computed column (select / filter on it)
--   confirm_warehouse_posting(id, c)  Accounts confirms: posts the sale and
--                                     marks the posting assessed
--   reject_warehouse_posting(id, r)   Accounts rejects it, with a reason
--   warehouse_postings_to_confirm()   how many wait on the caller (the bell)
--   Both decisions need finance view + payments or debts write, and -- as
--   with approve_sale -- someone other than whoever recorded the sale
--   (admins excepted).
--
-- Notifications: my_open_notifications() also treats "Deletion requested" as
-- attended once that request is no longer pending; and the tables the bell
-- and the Postings tab listen to are added to the realtime publication
-- (notifications and production_releases weren't, so nothing arrived live).
-- Needs 20261028270000_notifications_clear_when_attended.sql first.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.is_warehouse_posting(s public.sales)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $fn$
  SELECT s.sales_rep_id IS NULL
     AND NOT COALESCE(s.is_pr, false)
     AND EXISTS (SELECT 1 FROM customers c WHERE c.id = s.customer_id AND c.registered);
$fn$;
REVOKE ALL ON FUNCTION public.is_warehouse_posting(public.sales) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.is_warehouse_posting(public.sales) TO authenticated;

CREATE OR REPLACE FUNCTION public._can_confirm_postings(p_uid uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $fn$
  SELECT public.has_permission(p_uid, 'finance'::module_key, 'view'::action_key)
     AND (public.has_permission(p_uid, 'payments'::module_key, 'write'::action_key)
       OR public.has_permission(p_uid, 'debts'::module_key, 'write'::action_key));
$fn$;
REVOKE ALL ON FUNCTION public._can_confirm_postings(uuid) FROM PUBLIC, anon;

CREATE OR REPLACE FUNCTION public.confirm_warehouse_posting(p_id uuid, p_comment text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $fn$
DECLARE
  v_uid uuid := auth.uid();
  v_row sales%ROWTYPE;
  v_res jsonb;
BEGIN
  IF NOT public._can_confirm_postings(v_uid) THEN RAISE EXCEPTION 'Insufficient permissions'; END IF;
  SELECT * INTO v_row FROM sales WHERE id = p_id AND deleted_at IS NULL FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Sale not found'; END IF;
  IF NOT public.is_warehouse_posting(v_row) THEN
    RAISE EXCEPTION '% isn''t a Warehouse posting to a distributor', v_row.invoice_number;
  END IF;
  IF v_row.status <> 'pending_approval' THEN
    RAISE EXCEPTION '% is already %', v_row.invoice_number, replace(v_row.status::text, '_', ' ');
  END IF;
  IF v_row.created_by = v_uid AND NOT (public.has_role(v_uid, 'super_admin') OR public.has_role(v_uid, 'chairman')) THEN
    RAISE EXCEPTION 'Confirmation must be done by someone other than who recorded the sale';
  END IF;

  v_res := public._post_sale(p_id, COALESCE(NULLIF(btrim(p_comment), ''), 'Confirmed by Accounts'));

  INSERT INTO posting_assessments (factory_id, posting_kind, posting_id, remarks, assessed_by, assessed_at)
  VALUES (v_row.factory_id, 'sale', p_id, NULLIF(btrim(COALESCE(p_comment, '')), ''), v_uid, now())
  ON CONFLICT (posting_kind, posting_id) DO UPDATE
     SET remarks = COALESCE(EXCLUDED.remarks, posting_assessments.remarks),
         assessed_by = EXCLUDED.assessed_by, assessed_at = EXCLUDED.assessed_at;
  RETURN v_res;
END;
$fn$;
REVOKE ALL ON FUNCTION public.confirm_warehouse_posting(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.confirm_warehouse_posting(uuid, text) TO authenticated;

CREATE OR REPLACE FUNCTION public.reject_warehouse_posting(p_id uuid, p_reason text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $fn$
DECLARE
  v_uid uuid := auth.uid();
  v_row sales%ROWTYPE;
BEGIN
  IF NOT public._can_confirm_postings(v_uid) THEN RAISE EXCEPTION 'Insufficient permissions'; END IF;
  IF p_reason IS NULL OR btrim(p_reason) = '' THEN RAISE EXCEPTION 'A rejection reason is required'; END IF;
  SELECT * INTO v_row FROM sales WHERE id = p_id AND deleted_at IS NULL FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Sale not found'; END IF;
  IF NOT public.is_warehouse_posting(v_row) THEN
    RAISE EXCEPTION '% isn''t a Warehouse posting to a distributor', v_row.invoice_number;
  END IF;
  IF v_row.created_by = v_uid AND NOT (public.has_role(v_uid, 'super_admin') OR public.has_role(v_uid, 'chairman')) THEN
    RAISE EXCEPTION 'Rejection must be done by someone other than who recorded the sale';
  END IF;
  PERFORM public.assert_valid_transition(v_row.status, 'rejected');

  UPDATE sales SET status = 'rejected', rejected_reason = p_reason WHERE id = p_id;
  PERFORM public.record_workflow_action('sales', p_id, 'reject', v_row.status, 'rejected', p_reason);
  RETURN jsonb_build_object('sale_id', p_id, 'status', 'rejected');
END;
$fn$;
REVOKE ALL ON FUNCTION public.reject_warehouse_posting(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.reject_warehouse_posting(uuid, text) TO authenticated;

-- What waits on the caller: distributor sales pending confirmation that
-- someone else recorded, and postings to marketers not yet confirmed
-- (assessed). Postings to the Company Retail Shop are settled on Retail
-- cash-up instead (confirm_outlet_day), so they aren't counted here.
CREATE OR REPLACE FUNCTION public.warehouse_postings_to_confirm()
RETURNS int LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $fn$
  SELECT CASE WHEN NOT public._can_confirm_postings(auth.uid()) THEN 0 ELSE (
    SELECT count(*)::int FROM sales s
     WHERE s.status = 'pending_approval' AND s.deleted_at IS NULL
       AND public.is_warehouse_posting(s)
       AND (s.created_by IS DISTINCT FROM auth.uid()
            OR public.has_role(auth.uid(), 'super_admin') OR public.has_role(auth.uid(), 'chairman'))
  ) + (
    SELECT count(*)::int FROM stock_dispatches d
      JOIN sales_reps sr ON sr.id = d.sales_rep_id AND sr.kind <> 'outlet'
     WHERE d.status = 'posted'
       AND NOT EXISTS (SELECT 1 FROM posting_assessments pa
                        WHERE pa.posting_kind = 'dispatch' AND pa.posting_id = d.id)
  ) END;
$fn$;
REVOKE ALL ON FUNCTION public.warehouse_postings_to_confirm() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.warehouse_postings_to_confirm() TO authenticated;

-- The bell: as 20261028270000, plus "Deletion requested" clears once the
-- request (named in quotes in its text) has been approved or rejected.
CREATE OR REPLACE FUNCTION public.my_open_notifications(p_factory uuid, p_limit int DEFAULT 30)
RETURNS TABLE(id uuid, title text, body text, created_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $fn$
  SELECT n.id, n.title, n.body, n.created_at
    FROM public.notifications n
   WHERE auth.uid() IS NOT NULL
     AND (n.factory_id = p_factory OR n.factory_id IS NULL)
     AND (
           (n.user_id = auth.uid() AND NOT n.read)
        OR (n.user_id IS NULL AND NOT EXISTS (
              SELECT 1 FROM public.notification_reads r
               WHERE r.notification_id = n.id AND r.user_id = auth.uid()))
         )
     AND NOT (
           n.title = 'Stock adjustment awaiting approval'
       AND NOT EXISTS (
             SELECT 1 FROM public.stock_adjustment_requests a
              WHERE a.reference_number = split_part(n.body, ' ', 1)
                AND a.status = 'pending_approval')
         )
     AND NOT (
           n.title = 'Deletion requested'
       AND NOT EXISTS (
             SELECT 1 FROM public.delete_requests d
              WHERE d.review_status = 'pending'
                AND d.factory_id IS NOT DISTINCT FROM n.factory_id
                AND strpos(n.body, '"' || d.entity_label || '"') > 0)
         )
   ORDER BY n.created_at DESC
   LIMIT LEAST(GREATEST(COALESCE(p_limit, 30), 1), 100);
$fn$;
REVOKE ALL ON FUNCTION public.my_open_notifications(uuid, int) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.my_open_notifications(uuid, int) TO authenticated;

-- Live updates for the bell, the sidebar badges and the Postings tab.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['notifications', 'notification_reads', 'production_releases',
                           'delete_requests', 'posting_assessments', 'stock_dispatches',
                           'rep_remittances', 'chairmans_gifts'] LOOP
    IF to_regclass('public.' || t) IS NOT NULL AND NOT EXISTS (
         SELECT 1 FROM pg_publication_tables
          WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = t) THEN
      EXECUTE format('ALTER PUBLICATION supabase_realtime ADD TABLE public.%I', t);
    END IF;
  END LOOP;
END;
$$;

NOTIFY pgrst, 'reload schema';
