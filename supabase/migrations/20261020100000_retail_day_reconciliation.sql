-- ============================================================================
-- Retail outlet: end-of-day reconciliation between the shop and Accounts
-- ----------------------------------------------------------------------------
-- Every evening the retail outlet and the accounting department agree three
-- things for the day: the cash in hand, the products sold, and the products
-- left on the shelf.
--
--   1. Retail counts the shelf and the cash and submits the day
--      (submit_outlet_day). The system figures for the day are snapshotted
--      with the count: opening stock, received from the Warehouse, sold,
--      returned, closing stock, sales value, and the money taken at the till
--      split by method.
--   2. Accounts (Accountant page → Retail cash-up) sees the snapshot next to
--      retail's count, enters what was actually handed over, and either
--        confirms it (confirm_outlet_day): the money handed over is recorded
--          as the outlet's remittance(s) for that date, or
--        queries it (query_outlet_day): back to retail with a note; retail
--          corrects and submits again.
--
-- Accounts can open any day for an outlet, submitted or not, and see the
-- live figures (outlet_day_figures), including what the Warehouse posted to
-- the shop that day.
--
-- While a day is submitted or confirmed, the outlet's sales for that date are
-- locked (no new sale, no edit, no delete) so the agreed figures cannot move
-- underneath it. A queried day is open again. Confirming also refuses if the
-- live figures no longer match what retail submitted.
--
-- Stock dates follow rep_stock_movements.created_at in Lagos time, money
-- follows sales.sale_date -- the same conventions as _marketer_figures.
-- The count never changes stock; a shelf shortage or surplus is a recorded
-- variance for management to act on through the usual return/adjustment
-- flows.
-- ============================================================================

-- ============ 1. Table ============
CREATE TABLE IF NOT EXISTS public.outlet_day_reconciliations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  factory_id uuid NOT NULL REFERENCES public.factories(id) ON DELETE CASCADE,
  sales_rep_id uuid NOT NULL REFERENCES public.sales_reps(id) ON DELETE CASCADE,
  close_date date NOT NULL,
  status text NOT NULL DEFAULT 'submitted' CHECK (status IN ('submitted', 'queried', 'confirmed')),
  -- System figures at submission (see _outlet_day_figures)
  figures jsonb NOT NULL,
  -- Retail's count: [{product_id, name, unit, system, counted}]
  counted_stock jsonb NOT NULL DEFAULT '[]'::jsonb,
  declared_cash numeric(14,2) NOT NULL DEFAULT 0 CHECK (declared_cash >= 0),
  declared_other numeric(14,2) NOT NULL DEFAULT 0 CHECK (declared_other >= 0),
  retail_notes text,
  submitted_by uuid REFERENCES auth.users(id),
  submitted_at timestamptz NOT NULL DEFAULT now(),
  -- Accounts' side
  received_cash numeric(14,2) CHECK (received_cash IS NULL OR received_cash >= 0),
  received_other numeric(14,2) CHECK (received_other IS NULL OR received_other >= 0),
  accounts_notes text,
  reviewed_by uuid REFERENCES auth.users(id),
  reviewed_at timestamptz,
  remittance_ids uuid[] NOT NULL DEFAULT '{}',
  UNIQUE (sales_rep_id, close_date)
);
CREATE INDEX IF NOT EXISTS idx_outlet_day_recon_factory ON public.outlet_day_reconciliations (factory_id, close_date DESC);

GRANT SELECT ON public.outlet_day_reconciliations TO authenticated;
GRANT ALL ON public.outlet_day_reconciliations TO service_role;
ALTER TABLE public.outlet_day_reconciliations ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "outlet day reconciliations read" ON public.outlet_day_reconciliations;
CREATE POLICY "outlet day reconciliations read" ON public.outlet_day_reconciliations FOR SELECT TO authenticated
  USING (public.has_permission(auth.uid(), 'sales'::module_key, 'view'::action_key)
      OR public.has_permission(auth.uid(), 'finance'::module_key, 'view'::action_key));

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_publication_tables WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'outlet_day_reconciliations') THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.outlet_day_reconciliations;
  END IF;
END $$;

-- ============ 2. Who may do what ============
CREATE OR REPLACE FUNCTION public._outlet_recon_can_view()
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT public.has_permission(auth.uid(), 'sales'::module_key, 'view'::action_key)
      OR public.has_permission(auth.uid(), 'finance'::module_key, 'view'::action_key);
$$;
REVOKE ALL ON FUNCTION public._outlet_recon_can_view() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public._outlet_recon_can_view() TO authenticated;

-- Accounts: finance view plus a money-handling right (as assess_posting).
CREATE OR REPLACE FUNCTION public._outlet_recon_is_accounts()
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT public.has_permission(auth.uid(), 'finance'::module_key, 'view'::action_key)
     AND (public.has_permission(auth.uid(), 'payments'::module_key, 'write'::action_key)
       OR public.has_permission(auth.uid(), 'finance'::module_key, 'post'::action_key)
       OR public.has_permission(auth.uid(), 'distribution'::module_key, 'post'::action_key));
$$;
REVOKE ALL ON FUNCTION public._outlet_recon_is_accounts() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public._outlet_recon_is_accounts() TO authenticated;

-- ============ 3. A day's figures ============
CREATE OR REPLACE FUNCTION public._outlet_day_figures(p_outlet uuid, p_date date)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_products jsonb;
  v_stock jsonb;
  v_money jsonb;
  v_held_before numeric;
  v_remit_before numeric;
  v_remit_day numeric;
  v_pending int;
BEGIN
  WITH mv AS (
    SELECT m.product_id, m.movement_type, m.quantity AS delta,
           (m.created_at AT TIME ZONE 'Africa/Lagos')::date AS d
      FROM rep_stock_movements m
     WHERE m.sales_rep_id = p_outlet AND (m.created_at AT TIME ZONE 'Africa/Lagos')::date <= p_date
  ), st AS (
    SELECT product_id,
      COALESCE(SUM(delta) FILTER (WHERE d < p_date), 0) AS opening,
      COALESCE(SUM(delta) FILTER (WHERE d = p_date AND movement_type = 'dispatch_in'), 0) AS received,
      COALESCE(-SUM(delta) FILTER (WHERE d = p_date AND movement_type = 'sold'), 0) AS sold,
      COALESCE(-SUM(delta) FILTER (WHERE d = p_date AND movement_type = 'returned_out'), 0) AS returned,
      COALESCE(-SUM(delta) FILTER (WHERE d = p_date AND movement_type = 'damaged_out'), 0) AS damaged,
      COALESCE(SUM(delta) FILTER (WHERE d = p_date AND movement_type IN ('reversal', 'adjustment')), 0) AS corrections,
      COALESCE(SUM(delta), 0) AS closing
    FROM mv GROUP BY product_id
  ), sv AS (
    SELECT si.product_id, SUM(si.line_total) AS value
      FROM sale_items si JOIN sales s ON s.id = si.sale_id
     WHERE s.sales_rep_id = p_outlet AND s.sale_date = p_date AND s.status = 'posted'
       AND s.deleted_at IS NULL AND NOT COALESCE(s.is_pr, false)
     GROUP BY si.product_id
  )
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'product_id', p.id, 'name', p.name, 'unit', p.unit, 'unit_price', p.unit_price,
           'opening', st.opening, 'received', st.received, 'sold', st.sold,
           'returned', st.returned, 'damaged', st.damaged, 'corrections', st.corrections,
           'closing', st.closing, 'sold_value', COALESCE(sv.value, 0)
         ) ORDER BY p.name), '[]'::jsonb)
    INTO v_products
    FROM st JOIN products p ON p.id = st.product_id
    LEFT JOIN sv ON sv.product_id = st.product_id
   WHERE st.opening <> 0 OR st.received <> 0 OR st.sold <> 0 OR st.returned <> 0
      OR st.damaged <> 0 OR st.corrections <> 0 OR st.closing <> 0;

  SELECT jsonb_build_object(
    'opening', COALESCE(SUM((x->>'opening')::numeric), 0),
    'received', COALESCE(SUM((x->>'received')::numeric), 0),
    'sold', COALESCE(SUM((x->>'sold')::numeric), 0),
    'returned', COALESCE(SUM((x->>'returned')::numeric), 0),
    'damaged', COALESCE(SUM((x->>'damaged')::numeric), 0),
    'corrections', COALESCE(SUM((x->>'corrections')::numeric), 0),
    'closing', COALESCE(SUM((x->>'closing')::numeric), 0),
    'closing_value', COALESCE(SUM((x->>'closing')::numeric * (x->>'unit_price')::numeric), 0))
    INTO v_stock FROM jsonb_array_elements(v_products) x;

  -- Money taken at the till with the day's sales, by method.
  WITH s AS (
    SELECT s.id, s.grand_total, s.credit_applied
      FROM sales s
     WHERE s.sales_rep_id = p_outlet AND s.sale_date = p_date AND s.status = 'posted'
       AND s.deleted_at IS NULL AND NOT COALESCE(s.is_pr, false)
  ), p AS (
    SELECT p.payment_method, p.amount
      FROM payments_received p JOIN s ON s.id = p.sale_id
     WHERE p.at_point_of_sale AND p.status NOT IN ('reversed', 'rejected')
  )
  SELECT jsonb_build_object(
    'sales_count', (SELECT COUNT(*) FROM s),
    'sales_value', (SELECT COALESCE(SUM(grand_total), 0) FROM s),
    'advance_applied', (SELECT COALESCE(SUM(credit_applied), 0) FROM s),
    'cash_expected', (SELECT COALESCE(SUM(amount), 0) FROM p WHERE payment_method = 'cash'),
    'other_expected', (SELECT COALESCE(SUM(amount), 0) FROM p WHERE payment_method <> 'cash'),
    'by_method', (SELECT COALESCE(jsonb_object_agg(m, amt), '{}'::jsonb)
                    FROM (SELECT payment_method::text AS m, SUM(amount) AS amt FROM p GROUP BY payment_method) q))
    INTO v_money;
  v_money := v_money || jsonb_build_object(
    'credit_sales', GREATEST((v_money->>'sales_value')::numeric - (v_money->>'advance_applied')::numeric
                             - (v_money->>'cash_expected')::numeric - (v_money->>'other_expected')::numeric, 0));

  -- Earlier money the outlet took but has not yet handed over (information
  -- only: the day's expected figures are the day's own takings).
  SELECT COALESCE(SUM(p.amount), 0) INTO v_held_before
    FROM payments_received p JOIN sales s ON s.id = p.sale_id
   WHERE s.sales_rep_id = p_outlet AND p.at_point_of_sale AND s.deleted_at IS NULL
     AND p.status NOT IN ('reversed', 'rejected') AND s.sale_date < p_date;
  SELECT COALESCE(SUM(amount), 0) INTO v_remit_before FROM rep_remittances
   WHERE sales_rep_id = p_outlet AND remittance_date < p_date;
  SELECT COALESCE(SUM(amount), 0) INTO v_remit_day FROM rep_remittances
   WHERE sales_rep_id = p_outlet AND remittance_date = p_date;

  SELECT COUNT(*) INTO v_pending FROM sales
   WHERE sales_rep_id = p_outlet AND sale_date = p_date AND status = 'pending_approval' AND deleted_at IS NULL;

  RETURN jsonb_build_object(
    'date', p_date, 'products', v_products, 'stock', v_stock, 'money', v_money,
    'unremitted_before', v_held_before - v_remit_before,
    'remitted_on_day', v_remit_day,
    'pending_sales', v_pending);
END;
$$;
REVOKE ALL ON FUNCTION public._outlet_day_figures(uuid, date) FROM PUBLIC, anon, authenticated;

-- Live figures for one outlet-day, plus its reconciliation if there is one.
CREATE OR REPLACE FUNCTION public.outlet_day_figures(p_outlet uuid, p_date date)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_rep sales_reps%ROWTYPE;
  v_rec jsonb;
BEGIN
  IF NOT public._outlet_recon_can_view() THEN RAISE EXCEPTION 'Insufficient permissions'; END IF;
  SELECT * INTO v_rep FROM sales_reps WHERE id = p_outlet;
  IF NOT FOUND OR v_rep.kind <> 'outlet' THEN RAISE EXCEPTION 'Retail outlet not found'; END IF;
  IF p_date IS NULL THEN RAISE EXCEPTION 'Pick a day'; END IF;
  SELECT to_jsonb(r) INTO v_rec FROM outlet_day_reconciliations r
   WHERE r.sales_rep_id = p_outlet AND r.close_date = p_date;
  RETURN jsonb_build_object(
    'outlet', jsonb_build_object('id', v_rep.id, 'name', v_rep.full_name),
    'live', public._outlet_day_figures(p_outlet, p_date),
    'reconciliation', v_rec);
END;
$$;
REVOKE ALL ON FUNCTION public.outlet_day_figures(uuid, date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.outlet_day_figures(uuid, date) TO authenticated;

-- ============ 4. Retail submits the day ============
-- p_counts: [{product_id, counted}] -- every product the day shows must be
-- counted. Resubmitting is allowed while the day is queried.
CREATE OR REPLACE FUNCTION public.submit_outlet_day(
  p_outlet uuid, p_date date, p_declared_cash numeric, p_declared_other numeric,
  p_counts jsonb, p_notes text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_rep sales_reps%ROWTYPE;
  v_existing outlet_day_reconciliations%ROWTYPE;
  v_fig jsonb;
  v_counted jsonb;
  v_missing text;
  v_stock_off boolean;
  v_cash_off boolean;
  v_notes text := NULLIF(btrim(COALESCE(p_notes, '')), '');
  v_id uuid;
BEGIN
  IF NOT public.has_permission(v_uid, 'sales'::module_key, 'write'::action_key) THEN
    RAISE EXCEPTION 'Insufficient permissions';
  END IF;
  SELECT * INTO v_rep FROM sales_reps WHERE id = p_outlet;
  IF NOT FOUND OR v_rep.kind <> 'outlet' THEN RAISE EXCEPTION 'Retail outlet not found'; END IF;
  IF p_date IS NULL OR p_date > (now() AT TIME ZONE 'Africa/Lagos')::date THEN
    RAISE EXCEPTION 'A day in the future cannot be closed';
  END IF;
  IF COALESCE(p_declared_cash, -1) < 0 OR COALESCE(p_declared_other, -1) < 0 THEN
    RAISE EXCEPTION 'Enter the cash and transfer/POS amounts (0 if none)';
  END IF;

  SELECT * INTO v_existing FROM outlet_day_reconciliations
   WHERE sales_rep_id = p_outlet AND close_date = p_date FOR UPDATE;
  IF FOUND AND v_existing.status = 'confirmed' THEN
    RAISE EXCEPTION '% is already confirmed by Accounts', to_char(p_date, 'DD Mon YYYY');
  ELSIF FOUND AND v_existing.status = 'submitted' THEN
    RAISE EXCEPTION '% has already been submitted and is waiting for Accounts', to_char(p_date, 'DD Mon YYYY');
  END IF;

  v_fig := public._outlet_day_figures(p_outlet, p_date);
  IF (v_fig->>'pending_sales')::int > 0 THEN
    RAISE EXCEPTION 'This day still has % sale(s) awaiting approval. Approve or cancel them first.', v_fig->>'pending_sales';
  END IF;

  -- One counted figure per product the day shows.
  SELECT string_agg(x->>'name', ', ') INTO v_missing
    FROM jsonb_array_elements(v_fig->'products') x
   WHERE NOT EXISTS (SELECT 1 FROM jsonb_array_elements(COALESCE(p_counts, '[]'::jsonb)) c
                      WHERE c->>'product_id' = x->>'product_id'
                        AND (c->>'counted') IS NOT NULL AND (c->>'counted')::numeric >= 0);
  IF v_missing IS NOT NULL THEN RAISE EXCEPTION 'Enter the counted quantity for: %', v_missing; END IF;

  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'product_id', x->>'product_id', 'name', x->>'name', 'unit', x->>'unit',
           'system', (x->>'closing')::numeric,
           'counted', (SELECT (c->>'counted')::numeric FROM jsonb_array_elements(p_counts) c
                        WHERE c->>'product_id' = x->>'product_id' LIMIT 1))
         ORDER BY x->>'name'), '[]'::jsonb)
    INTO v_counted FROM jsonb_array_elements(v_fig->'products') x;

  SELECT bool_or((c->>'counted')::numeric <> (c->>'system')::numeric) INTO v_stock_off
    FROM jsonb_array_elements(v_counted) c;
  v_cash_off := abs(round(p_declared_cash, 2) - (v_fig->'money'->>'cash_expected')::numeric) > 0.005
             OR abs(round(p_declared_other, 2) - (v_fig->'money'->>'other_expected')::numeric) > 0.005;
  IF (COALESCE(v_stock_off, false) OR v_cash_off) AND v_notes IS NULL THEN
    RAISE EXCEPTION 'Your count differs from the system figures. Add a note explaining the difference before submitting.';
  END IF;

  IF v_existing.id IS NOT NULL THEN
    UPDATE outlet_day_reconciliations SET
      status = 'submitted', figures = v_fig, counted_stock = v_counted,
      declared_cash = round(p_declared_cash, 2), declared_other = round(p_declared_other, 2),
      retail_notes = v_notes, submitted_by = v_uid, submitted_at = now()
     WHERE id = v_existing.id
    RETURNING id INTO v_id;
  ELSE
    INSERT INTO outlet_day_reconciliations(factory_id, sales_rep_id, close_date, status, figures, counted_stock,
                                           declared_cash, declared_other, retail_notes, submitted_by)
    VALUES (v_rep.factory_id, p_outlet, p_date, 'submitted', v_fig, v_counted,
            round(p_declared_cash, 2), round(p_declared_other, 2), v_notes, v_uid)
    RETURNING id INTO v_id;
  END IF;

  INSERT INTO audit_logs(user_id, factory_id, action, entity, entity_id, new_value)
  VALUES (v_uid, v_rep.factory_id, 'submit_outlet_day', 'outlet_day_reconciliations', v_id::text,
          jsonb_build_object('outlet', p_outlet, 'close_date', p_date,
                             'declared_cash', p_declared_cash, 'declared_other', p_declared_other));
  RETURN jsonb_build_object('id', v_id, 'status', 'submitted');
END;
$$;
REVOKE ALL ON FUNCTION public.submit_outlet_day(uuid, date, numeric, numeric, jsonb, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.submit_outlet_day(uuid, date, numeric, numeric, jsonb, text) TO authenticated;

-- ============ 5. Accounts confirms ============
-- Records what was actually handed over as the outlet's remittance(s) dated
-- the close date (cash and transfer/POS separately), and closes the day.
CREATE OR REPLACE FUNCTION public.confirm_outlet_day(
  p_id uuid, p_received_cash numeric, p_received_other numeric, p_notes text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_row outlet_day_reconciliations%ROWTYPE;
  v_live jsonb;
  v_notes text := NULLIF(btrim(COALESCE(p_notes, '')), '');
  v_ids uuid[] := '{}';
  v_rid uuid;
  v_label text;
BEGIN
  IF NOT public._outlet_recon_is_accounts() THEN RAISE EXCEPTION 'Insufficient permissions'; END IF;
  SELECT * INTO v_row FROM outlet_day_reconciliations WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Reconciliation not found'; END IF;
  IF v_row.status <> 'submitted' THEN RAISE EXCEPTION 'Only a submitted day can be confirmed'; END IF;
  IF COALESCE(p_received_cash, -1) < 0 OR COALESCE(p_received_other, -1) < 0 THEN
    RAISE EXCEPTION 'Enter the cash and transfer/POS received (0 if none)';
  END IF;

  -- The figures retail submitted must still be the figures now.
  v_live := public._outlet_day_figures(v_row.sales_rep_id, v_row.close_date);
  IF v_live->'money'->>'sales_value' IS DISTINCT FROM v_row.figures->'money'->>'sales_value'
     OR v_live->'money'->>'cash_expected' IS DISTINCT FROM v_row.figures->'money'->>'cash_expected'
     OR v_live->'money'->>'other_expected' IS DISTINCT FROM v_row.figures->'money'->>'other_expected'
     OR v_live->'stock' IS DISTINCT FROM v_row.figures->'stock' THEN
    RAISE EXCEPTION 'The day''s figures have changed since retail submitted it. Query it back so retail can recount and resubmit.';
  END IF;

  IF (abs(round(p_received_cash, 2) - v_row.declared_cash) > 0.005
      OR abs(round(p_received_other, 2) - v_row.declared_other) > 0.005
      OR abs(round(p_received_cash, 2) - (v_row.figures->'money'->>'cash_expected')::numeric) > 0.005
      OR abs(round(p_received_other, 2) - (v_row.figures->'money'->>'other_expected')::numeric) > 0.005)
     AND v_notes IS NULL THEN
    RAISE EXCEPTION 'What was received differs from the expected or declared amount. Add a note before confirming.';
  END IF;

  v_label := 'Retail day close ' || to_char(v_row.close_date, 'DD Mon YYYY');
  IF p_received_cash > 0 THEN
    INSERT INTO rep_remittances(factory_id, remittance_number, sales_rep_id, amount, payment_method, remittance_date, received_by, remarks)
    VALUES (v_row.factory_id, 'RMT-' || to_char(now(), 'YYYYMMDD') || '-' || lpad(((floor(random()*99999))::int)::text, 5, '0'),
            v_row.sales_rep_id, round(p_received_cash, 2), 'cash', v_row.close_date, v_uid, v_label)
    RETURNING id INTO v_rid;
    v_ids := v_ids || v_rid;
  END IF;
  IF p_received_other > 0 THEN
    INSERT INTO rep_remittances(factory_id, remittance_number, sales_rep_id, amount, payment_method, remittance_date, received_by, remarks)
    VALUES (v_row.factory_id, 'RMT-' || to_char(now(), 'YYYYMMDD') || '-' || lpad(((floor(random()*99999))::int)::text, 5, '0'),
            v_row.sales_rep_id, round(p_received_other, 2), 'transfer', v_row.close_date, v_uid, v_label || ' (transfer/POS)')
    RETURNING id INTO v_rid;
    v_ids := v_ids || v_rid;
  END IF;

  UPDATE outlet_day_reconciliations SET
    status = 'confirmed', received_cash = round(p_received_cash, 2), received_other = round(p_received_other, 2),
    accounts_notes = v_notes, reviewed_by = v_uid, reviewed_at = now(), remittance_ids = v_ids
   WHERE id = p_id;

  INSERT INTO audit_logs(user_id, factory_id, action, entity, entity_id, new_value)
  VALUES (v_uid, v_row.factory_id, 'confirm_outlet_day', 'outlet_day_reconciliations', p_id::text,
          jsonb_build_object('close_date', v_row.close_date, 'received_cash', p_received_cash,
                             'received_other', p_received_other, 'remittances', v_ids));
  RETURN jsonb_build_object('id', p_id, 'status', 'confirmed', 'remittance_ids', v_ids);
END;
$$;
REVOKE ALL ON FUNCTION public.confirm_outlet_day(uuid, numeric, numeric, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.confirm_outlet_day(uuid, numeric, numeric, text) TO authenticated;

-- ============ 6. Accounts queries it back ============
CREATE OR REPLACE FUNCTION public.query_outlet_day(p_id uuid, p_notes text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_row outlet_day_reconciliations%ROWTYPE;
BEGIN
  IF NOT public._outlet_recon_is_accounts() THEN RAISE EXCEPTION 'Insufficient permissions'; END IF;
  IF NULLIF(btrim(COALESCE(p_notes, '')), '') IS NULL THEN RAISE EXCEPTION 'Say what retail needs to check'; END IF;
  SELECT * INTO v_row FROM outlet_day_reconciliations WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Reconciliation not found'; END IF;
  IF v_row.status <> 'submitted' THEN RAISE EXCEPTION 'Only a submitted day can be queried'; END IF;

  UPDATE outlet_day_reconciliations SET
    status = 'queried', accounts_notes = btrim(p_notes), reviewed_by = v_uid, reviewed_at = now()
   WHERE id = p_id;

  INSERT INTO audit_logs(user_id, factory_id, action, entity, entity_id, new_value)
  VALUES (v_uid, v_row.factory_id, 'query_outlet_day', 'outlet_day_reconciliations', p_id::text,
          jsonb_build_object('close_date', v_row.close_date, 'notes', p_notes));
  RETURN jsonb_build_object('id', p_id, 'status', 'queried');
END;
$$;
REVOKE ALL ON FUNCTION public.query_outlet_day(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.query_outlet_day(uuid, text) TO authenticated;

-- ============ 7. Lock the outlet's sales on a submitted/confirmed day ============
-- Watches only what changes the day's figures: a new sale, approval /
-- rejection / cancellation, delete / restore, and a change of date. Later
-- payments against a credit sale (amount_paid / balance) are not the day's
-- takings and stay allowed.
CREATE OR REPLACE FUNCTION public._sales_outlet_day_lock()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_status text;
BEGIN
  IF TG_OP = 'UPDATE' AND OLD.sales_rep_id IS NOT NULL THEN
    SELECT r.status INTO v_status FROM outlet_day_reconciliations r
     WHERE r.sales_rep_id = OLD.sales_rep_id AND r.close_date = OLD.sale_date AND r.status IN ('submitted', 'confirmed');
    IF v_status IS NOT NULL THEN
      RAISE EXCEPTION 'The retail outlet''s day % is % -- its sales cannot change. Accounts can query the day back if a correction is needed.',
        to_char(OLD.sale_date, 'DD Mon YYYY'), v_status;
    END IF;
  END IF;
  IF NEW.sales_rep_id IS NOT NULL THEN
    SELECT r.status INTO v_status FROM outlet_day_reconciliations r
     WHERE r.sales_rep_id = NEW.sales_rep_id AND r.close_date = NEW.sale_date AND r.status IN ('submitted', 'confirmed');
    IF v_status IS NOT NULL THEN
      RAISE EXCEPTION 'The retail outlet''s day % is already % -- record this sale on another day, or ask Accounts to query the day back.',
        to_char(NEW.sale_date, 'DD Mon YYYY'), v_status;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_sales_outlet_day_lock ON public.sales;
CREATE TRIGGER trg_sales_outlet_day_lock
  BEFORE INSERT OR UPDATE OF status, deleted_at, sale_date ON public.sales
  FOR EACH ROW EXECUTE FUNCTION public._sales_outlet_day_lock();
