-- ============================================================================
-- QC posts empty jugs to the PM or to the Warehouse
-- ----------------------------------------------------------------------------
-- User (2026-11-17): "qc should be able to send empty jugs to warehouse ...
-- qc should be able to send to either PM or Warehouse." The Warehouse accepts
-- the posting first; only then do the jugs join Empty Jug stock (ready to sell
-- or post, N3,000), as it accepts Production releases.
--
--   qc_jug_batches.posted_to   'pm' (default, every posting so far) or
--                              'warehouse'
--   qc_post_jugs_to_pm(..., p_dest)  p_dest 'pm' | 'warehouse'; a Warehouse
--                              posting is numbered QWH-..., the PM's QPM-...
--   receive_qc_jug_posting     the PM confirms PM postings only
--   receive_qc_jugs_at_warehouse(factory, posting, note)
--                              the Warehouse (dispenser officer) accepts a
--                              QWH posting: Empty Jug stock + good jugs
--                              (inventory_movements 'received'), jug ledger
--                              QC -> Warehouse
--   qc_pm_jug_postings         gains "destination"
-- Damaged jugs are written off at QC as before. Safe to run again.
-- ============================================================================

ALTER TABLE public.qc_jug_batches ADD COLUMN IF NOT EXISTS posted_to text NOT NULL DEFAULT 'pm';
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'qc_jug_batches_posted_to_check') THEN
    ALTER TABLE public.qc_jug_batches ADD CONSTRAINT qc_jug_batches_posted_to_check
      CHECK (posted_to IN ('pm', 'warehouse'));
  END IF;
END $$;

-- ---------------------------------------------------------------- jug ledger
-- The latest list (20261104120000) plus 'qc_to_warehouse'.
ALTER TABLE public.container_movements DROP CONSTRAINT IF EXISTS container_movements_source_check;
ALTER TABLE public.container_movements ADD CONSTRAINT container_movements_source_check CHECK (source IN (
  'dispatch','dispatch_reversal','sale','sale_reversal','rep_return','rep_return_cancelled',
  'sales_return','sales_return_cancelled','return','issue','lost','purchase','damaged','merge',
  'jar_sold','jar_sold_reversal','customer_return',
  'qc_accept','qc_damaged','qc_to_production','store_to_production',
  'production_release','production_release_reversal','count','qc_to_warehouse'));

-- As 20261110140000; jugs the Warehouse accepted go QC -> Warehouse.
CREATE OR REPLACE FUNCTION public._containers_on_qc_jug_batch()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_type uuid := public._jug_type_for_kind(NEW.factory_id, NEW.jug_kind);
  v_old text := CASE WHEN TG_OP = 'INSERT' THEN 'sent' ELSE OLD.status END;
BEGIN
  IF v_type IS NULL OR NEW.status = v_old THEN RETURN NEW; END IF;
  IF v_old = 'sent' AND NEW.status IN ('accepted', 'verified', 'received') AND NOT NEW.collected THEN
    PERFORM public._jug_move(NEW.factory_id, v_type,
      CASE WHEN NEW.jug_return_id IS NOT NULL THEN 'warehouse' ELSE 'store' END, 'qc',
      NEW.quantity_accepted, 'qc_accept', NEW.reference);
  END IF;
  IF v_old IN ('sent', 'accepted') AND NEW.status IN ('verified', 'received') THEN
    PERFORM public._jug_move(NEW.factory_id, v_type, 'qc', 'external', NEW.quantity_damaged, 'qc_damaged',
      NEW.reference, NEW.damage_reason);
  END IF;
  IF NEW.status = 'received' THEN
    IF NEW.posted_to = 'warehouse' THEN
      PERFORM public._jug_move(NEW.factory_id, v_type, 'qc', 'warehouse', NEW.quantity_good, 'qc_to_warehouse',
        NEW.reference);
    ELSE
      PERFORM public._jug_move(NEW.factory_id, v_type, 'qc', 'production', NEW.quantity_good, 'qc_to_production',
        NEW.reference);
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

-- The dispenser-production check applies to the PM's confirmation only; the
-- Warehouse's acceptance checks its own officer (Empty Jug) below.
CREATE OR REPLACE FUNCTION public._qc_jugs_dispenser_production()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NEW.status = 'received' AND OLD.status IS DISTINCT FROM 'received'
     AND NEW.posted_to = 'pm'
     AND NOT public._user_handles_dispensers(auth.uid()) THEN
    RAISE EXCEPTION 'Empty jugs from QC go to dispenser production -- the dispenser production person confirms them';
  END IF;
  RETURN NEW;
END;
$$;

-- ---------------------------------------------------------------- QC posts
-- As 20261110260000, with p_dest.
DROP FUNCTION IF EXISTS public.qc_post_jugs_to_pm(uuid, numeric, text, numeric, date, date);
CREATE OR REPLACE FUNCTION public.qc_post_jugs_to_pm(p_factory uuid, p_damaged numeric DEFAULT 0,
                                                    p_damage_reason text DEFAULT NULL,
                                                    p_good numeric DEFAULT NULL,
                                                    p_day date DEFAULT NULL,
                                                    p_to date DEFAULT NULL,
                                                    p_dest text DEFAULT 'pm')
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_dest text := COALESCE(NULLIF(btrim(p_dest), ''), 'pm');
  v_where text;
  v_reason text := NULLIF(btrim(COALESCE(p_damage_reason, '')), '');
  v_damaged numeric := COALESCE(p_damaged, 0);
  v_good numeric;
  v_total numeric;
  v_take_all numeric;
  v_take numeric;
  v_dmg numeric;
  v_left_dmg numeric;
  v_rest numeric;
  v_ref text;
  v_rest_ref text;
  v_n int := 0;
  v_i int;
  b record;
BEGIN
  IF v_dest NOT IN ('pm', 'warehouse') THEN RAISE EXCEPTION 'Post the jugs to the PM or to the Warehouse'; END IF;
  v_where := CASE v_dest WHEN 'pm' THEN 'the PM' ELSE 'the Warehouse' END;
  IF NOT public.has_permission(v_uid, 'goods-receiving'::module_key, 'submit'::action_key) THEN
    RAISE EXCEPTION 'Only Quality Control posts jugs to %', v_where;
  END IF;
  IF p_factory IS NULL OR NOT public._works_in_factory(v_uid, p_factory) THEN RAISE EXCEPTION 'Insufficient permissions'; END IF;
  IF v_damaged < 0 OR v_damaged <> trunc(v_damaged) THEN RAISE EXCEPTION 'Enter the whole number of damaged jugs'; END IF;
  IF v_damaged > 0 AND v_reason IS NULL THEN RAISE EXCEPTION 'Record what is wrong with the damaged jugs'; END IF;
  IF p_to < p_day THEN RAISE EXCEPTION 'The To date is before the From date'; END IF;

  PERFORM 1 FROM qc_jug_batches WHERE factory_id = p_factory AND status = 'accepted' FOR UPDATE;
  SELECT COALESCE(SUM(quantity_accepted), 0) INTO v_total
    FROM qc_jug_batches WHERE factory_id = p_factory AND status = 'accepted'
     AND (p_day IS NULL OR public._jug_day(accepted_at) BETWEEN p_day AND COALESCE(p_to, p_day));
  IF v_total <= 0 THEN
    RAISE EXCEPTION 'There are no jugs with QC to post%',
      CASE WHEN p_day IS NULL THEN '' WHEN COALESCE(p_to, p_day) = p_day THEN ' for ' || to_char(p_day, 'DD Mon YYYY')
           ELSE ' from ' || to_char(p_day, 'DD Mon YYYY') || ' to ' || to_char(p_to, 'DD Mon YYYY') END;
  END IF;

  v_good := COALESCE(p_good, v_total - v_damaged);
  IF v_good < 0 OR v_good <> trunc(v_good) THEN RAISE EXCEPTION 'Enter the whole number of good jugs to send'; END IF;
  IF v_good + v_damaged <= 0 THEN RAISE EXCEPTION 'Enter the good jugs to send to %', v_where; END IF;
  IF v_good + v_damaged > v_total THEN
    RAISE EXCEPTION 'Good (%) + damaged (%) is more than the % jugs with QC',
      trim_scale(v_good), trim_scale(v_damaged), trim_scale(v_total);
  END IF;

  v_ref := CASE v_dest WHEN 'pm' THEN 'QPM-' ELSE 'QWH-' END
           || to_char(now() AT TIME ZONE 'Africa/Lagos', 'YYYYMMDD') || '-'
           || lpad((floor(random() * 99999))::int::text, 5, '0');
  v_take_all := v_good + v_damaged;
  v_left_dmg := v_damaged;
  FOR b IN SELECT * FROM qc_jug_batches
            WHERE factory_id = p_factory AND status = 'accepted'
              AND (p_day IS NULL OR public._jug_day(accepted_at) BETWEEN p_day AND COALESCE(p_to, p_day))
            ORDER BY accepted_at, reference LOOP
    EXIT WHEN v_take_all <= 0;
    v_take := LEAST(v_take_all, b.quantity_accepted);
    v_rest := b.quantity_accepted - v_take;
    v_take_all := v_take_all - v_take;
    v_dmg := LEAST(v_left_dmg, v_take);
    v_left_dmg := v_left_dmg - v_dmg;

    IF v_rest > 0 THEN
      v_i := 1;
      LOOP
        v_rest_ref := b.reference || '-R' || v_i;
        EXIT WHEN NOT EXISTS (SELECT 1 FROM qc_jug_batches WHERE reference = v_rest_ref);
        v_i := v_i + 1;
      END LOOP;
      INSERT INTO qc_jug_batches (factory_id, reference, jug_kind, quantity_sent, send_notes, sent_by, sent_at,
                                  status, quantity_accepted, accept_note, accepted_by, accepted_at,
                                  collected, from_type, from_id)
      VALUES (b.factory_id, v_rest_ref, b.jug_kind, v_rest, b.send_notes, b.sent_by, b.sent_at,
              'accepted', v_rest, concat_ws(' · ', b.accept_note, 'Not yet posted from ' || b.reference),
              b.accepted_by, b.accepted_at,
              true, b.from_type, b.from_id);
      UPDATE qc_jug_batches SET quantity_accepted = v_take WHERE id = b.id;
    END IF;

    UPDATE qc_jug_batches
       SET status = 'verified', quantity_good = v_take - v_dmg, quantity_damaged = v_dmg,
           damage_reason = CASE WHEN v_dmg > 0 THEN v_reason END,
           verified_by = v_uid, verified_at = now(), pm_posting = v_ref, posted_to = v_dest
     WHERE id = b.id;
    v_n := v_n + 1;
  END LOOP;

  INSERT INTO audit_logs(user_id, factory_id, action, entity, entity_id, new_value)
  VALUES (v_uid, p_factory, CASE v_dest WHEN 'pm' THEN 'qc_post_jugs_to_pm' ELSE 'qc_post_jugs_to_warehouse' END,
          'qc_jug_batches', v_ref,
          jsonb_build_object('destination', v_dest, 'day', p_day, 'to', p_to, 'with_qc', v_total, 'good', v_good,
                             'damaged', v_damaged, 'kept_at_qc', v_total - v_good - v_damaged,
                             'reason', v_reason, 'consignments', v_n));
  RETURN jsonb_build_object('reference', v_ref, 'destination', v_dest, 'total', v_good + v_damaged,
                            'good', v_good, 'damaged', v_damaged, 'kept', v_total - v_good - v_damaged,
                            'consignments', v_n);
END;
$$;
REVOKE ALL ON FUNCTION public.qc_post_jugs_to_pm(uuid, numeric, text, numeric, date, date, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.qc_post_jugs_to_pm(uuid, numeric, text, numeric, date, date, text) TO authenticated;

-- ---------------------------------------------------------------- PM confirms (PM postings only)
CREATE OR REPLACE FUNCTION public.receive_qc_jug_posting(p_factory uuid, p_posting text, p_note text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_good numeric := 0;
  v_n int := 0;
  b record;
BEGIN
  IF NOT (public.has_permission(v_uid, 'production'::module_key, 'submit'::action_key)
          OR public.has_permission(v_uid, 'production'::module_key, 'create'::action_key)) THEN
    RAISE EXCEPTION 'Insufficient permissions';
  END IF;
  IF p_factory IS NULL OR NOT public._works_in_factory(v_uid, p_factory) THEN RAISE EXCEPTION 'Insufficient permissions'; END IF;
  FOR b IN SELECT id, quantity_good, status FROM qc_jug_batches
            WHERE factory_id = p_factory AND COALESCE(pm_posting, reference) = p_posting
              AND posted_to = 'pm'
            FOR UPDATE LOOP
    IF b.status = 'verified' THEN
      IF b.quantity_good > 0 THEN
        UPDATE qc_jug_batches SET status = 'received', received_by = v_uid, received_at = now(),
               receive_note = NULLIF(btrim(COALESCE(p_note, '')), '')
         WHERE id = b.id;
        v_good := v_good + b.quantity_good;
      END IF;
      v_n := v_n + 1;
    END IF;
  END LOOP;
  IF v_n = 0 THEN RAISE EXCEPTION '% is not waiting for the Production Manager', p_posting; END IF;
  INSERT INTO audit_logs(user_id, factory_id, action, entity, entity_id, new_value)
  VALUES (v_uid, p_factory, 'receive_qc_jug_posting', 'qc_jug_batches', p_posting,
          jsonb_build_object('good', v_good, 'note', p_note));
  RETURN jsonb_build_object('reference', p_posting, 'good', v_good);
END;
$$;
REVOKE ALL ON FUNCTION public.receive_qc_jug_posting(uuid, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.receive_qc_jug_posting(uuid, text, text) TO authenticated;

-- ---------------------------------------------------------------- Warehouse accepts
CREATE OR REPLACE FUNCTION public.receive_qc_jugs_at_warehouse(p_factory uuid, p_posting text, p_note text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_note text := NULLIF(btrim(COALESCE(p_note, '')), '');
  v_product products%ROWTYPE;
  v_good numeric := 0;
  v_n int := 0;
  b record;
BEGIN
  IF NOT public.has_permission(v_uid, 'finished-goods'::module_key, 'create'::action_key) THEN
    RAISE EXCEPTION 'Only the Warehouse accepts empty jugs from QC';
  END IF;
  IF p_factory IS NULL OR NOT public._works_in_factory(v_uid, p_factory) THEN RAISE EXCEPTION 'Insufficient permissions'; END IF;
  IF (SELECT count(*) FROM products WHERE factory_id = p_factory AND product_type = 'finished'
         AND lower(btrim(name)) = 'empty jug') <> 1 THEN
    RAISE EXCEPTION 'The Warehouse needs exactly one finished product named "Empty Jug" -- ask the Admin';
  END IF;
  SELECT * INTO v_product FROM products
   WHERE factory_id = p_factory AND product_type = 'finished' AND lower(btrim(name)) = 'empty jug' FOR UPDATE;
  IF NOT public._user_may_handle_product(v_uid, v_product.id) THEN
    RAISE EXCEPTION 'Empty Jug is not one of your products -- it is handled by another Warehouse officer';
  END IF;

  FOR b IN SELECT id, quantity_good, status FROM qc_jug_batches
            WHERE factory_id = p_factory AND pm_posting = p_posting AND posted_to = 'warehouse'
            FOR UPDATE LOOP
    IF b.status = 'verified' THEN
      IF b.quantity_good > 0 THEN
        UPDATE qc_jug_batches SET status = 'received', received_by = v_uid, received_at = now(),
               receive_note = v_note
         WHERE id = b.id;
        v_good := v_good + b.quantity_good;
      END IF;
      v_n := v_n + 1;
    END IF;
  END LOOP;
  IF v_n = 0 THEN RAISE EXCEPTION '% is not waiting for the Warehouse', p_posting; END IF;

  IF v_good > 0 THEN
    UPDATE products SET current_stock = current_stock + v_good, updated_at = now() WHERE id = v_product.id;
    INSERT INTO inventory_movements(factory_id, product_id, movement_type, quantity, reference, reason, user_id,
                                    quantity_before, quantity_after)
    VALUES (p_factory, v_product.id, 'received', v_good, p_posting,
            'Empty jugs from QC' || COALESCE(': ' || v_note, ''), v_uid,
            v_product.current_stock, v_product.current_stock + v_good);
  END IF;
  INSERT INTO audit_logs(user_id, factory_id, action, entity, entity_id, old_value, new_value)
  VALUES (v_uid, p_factory, 'receive_qc_jugs_at_warehouse', 'qc_jug_batches', p_posting,
          jsonb_build_object('empty_jug_stock', v_product.current_stock),
          jsonb_build_object('good', v_good, 'empty_jug_stock', v_product.current_stock + v_good, 'note', v_note));
  RETURN jsonb_build_object('reference', p_posting, 'good', v_good, 'stock', v_product.current_stock + v_good);
END;
$$;
REVOKE ALL ON FUNCTION public.receive_qc_jugs_at_warehouse(uuid, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.receive_qc_jugs_at_warehouse(uuid, text, text) TO authenticated;

-- ---------------------------------------------------------------- every posting (+ destination)
DROP FUNCTION IF EXISTS public.qc_pm_jug_postings(uuid, date, date);
CREATE OR REPLACE FUNCTION public.qc_pm_jug_postings(p_factory uuid, p_from date, p_to date)
RETURNS TABLE(posting text, posted_at timestamptz, posted_by text, total numeric, good numeric, damaged numeric,
              damage_reason text, consignments int, sources text, status text, received_at timestamptz,
              received_by text, destination text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
#variable_conflict use_column
BEGIN
  IF NOT public._qc_jug_can_view() OR NOT public._works_in_factory(auth.uid(), p_factory) THEN
    RAISE EXCEPTION 'Insufficient permissions';
  END IF;
  IF p_from IS NULL OR p_to IS NULL OR p_from > p_to THEN RAISE EXCEPTION 'Choose a valid date range'; END IF;
  RETURN QUERY
  WITH b AS (
    SELECT COALESCE(x.pm_posting, x.reference) AS pst, x.*,
           CASE x.from_type WHEN 'walk_in' THEN 'Walk-in'
                ELSE COALESCE(sr.full_name, c.name, CASE WHEN x.from_type IS NULL THEN 'Store / Warehouse' END) END AS who
      FROM qc_jug_batches x
      LEFT JOIN sales_reps sr ON x.from_type = 'sales_rep' AND sr.id = x.from_id
      LEFT JOIN customers c ON x.from_type = 'customer' AND c.id = x.from_id
     WHERE x.factory_id = p_factory AND x.status IN ('verified', 'received')
  ), g AS (
    SELECT pst, MIN(verified_at) AS vat, (array_agg(verified_by ORDER BY verified_at))[1] AS vby,
           SUM(quantity_accepted) AS tot, SUM(quantity_good) AS gd, SUM(quantity_damaged) AS dmg,
           string_agg(DISTINCT damage_reason, '; ') AS why, count(*)::int AS n,
           string_agg(DISTINCT who, ', ') AS src,
           bool_and(status = 'received' OR quantity_good = 0) AS done,
           MAX(received_at) AS rat, (array_agg(received_by ORDER BY received_at DESC NULLS LAST))[1] AS rby,
           MAX(posted_to) AS dest
      FROM b GROUP BY pst
  )
  SELECT g.pst, g.vat, COALESCE(NULLIF(pv.full_name, ''), pv.email)::text, g.tot, g.gd, g.dmg, g.why, g.n, g.src,
         CASE WHEN g.done THEN 'received' ELSE 'verified' END,
         CASE WHEN g.done THEN g.rat END, CASE WHEN g.done THEN COALESCE(NULLIF(pr.full_name, ''), pr.email)::text END,
         g.dest
    FROM g
    LEFT JOIN profiles pv ON pv.id = g.vby
    LEFT JOIN profiles pr ON pr.id = g.rby
   WHERE NOT g.done OR public._jug_day(g.vat) BETWEEN p_from AND p_to
   ORDER BY g.vat DESC;
END;
$$;
REVOKE ALL ON FUNCTION public.qc_pm_jug_postings(uuid, date, date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.qc_pm_jug_postings(uuid, date, date) TO authenticated;

NOTIFY pgrst, 'reload schema';
