-- ============================================================================
-- Jugs follow the factory's real route: Store, QC, Production, Warehouse
-- ----------------------------------------------------------------------------
-- User (2026-11-04), after Bottle tracking showed New Jug -167 "In
-- warehouse": "empties returned should go to qc then qc post to pm. new jugs
-- goes to store and issued to qc or production".
--
-- The jug ledger (container_movements) only knew the Warehouse, customers,
-- marketers, walk-in sales and outside. Filled dispensers coming from
-- Production were never recorded as jugs coming in, while every dispenser
-- posted out was recorded as a jug going out -- so the Warehouse went below
-- zero. The ledger now has three more places and every step writes its move:
--
--   supplier  --receive_new_jugs-->  Store                 (was: Warehouse)
--   Store     --QC accepts a consignment-->  QC            (qc_accept)
--   Store     --send_jugs_to_production-->  Production     (store_to_production, new)
--   marketer / shop / customer --empties counted by QC--> QC
--             (verify_jug_return still books them into the Warehouse; the
--             QC consignment it opens moves them on to QC at once)
--   QC        --verified damaged-->  outside               (qc_damaged)
--   QC        --PM confirms the good ones-->  Production   (qc_to_production)
--   Production --Warehouse accepts a dispenser release--> Warehouse
--             (production_release; a reversed release moves them back)
--   Warehouse --postings, sales--> marketers, shop, customers (as before)
--
-- Everything is done by triggers on the existing records (qc_jug_batches,
-- production_releases), so the QC, PM and Warehouse screens work as before.
-- Past records are not replayed: set_jug_count(...) books a physical count
-- for the Warehouse, Store, QC or Production once, so today's figures start
-- right (the difference goes to / from "outside", source 'count').
-- ============================================================================

-- ---------------------------------------------------------------- places
ALTER TABLE public.container_movements DROP CONSTRAINT IF EXISTS container_movements_from_type_check;
ALTER TABLE public.container_movements DROP CONSTRAINT IF EXISTS container_movements_to_type_check;
ALTER TABLE public.container_movements ADD CONSTRAINT container_movements_from_type_check
  CHECK (from_type IN ('warehouse','customer','sales_rep','walk_in','external','store','qc','production'));
ALTER TABLE public.container_movements ADD CONSTRAINT container_movements_to_type_check
  CHECK (to_type IN ('warehouse','customer','sales_rep','walk_in','external','store','qc','production'));

ALTER TABLE public.container_movements DROP CONSTRAINT IF EXISTS container_movements_source_check;
ALTER TABLE public.container_movements ADD CONSTRAINT container_movements_source_check CHECK (source IN (
  'dispatch','dispatch_reversal','sale','sale_reversal','rep_return','rep_return_cancelled',
  'sales_return','sales_return_cancelled','return','issue','lost','purchase','damaged','merge',
  'jar_sold','jar_sold_reversal','customer_return',
  'qc_accept','qc_damaged','qc_to_production','store_to_production',
  'production_release','production_release_reversal','count'));

-- Old / New Jug (qc_jug_batches.jug_kind) -> its jug type.
CREATE OR REPLACE FUNCTION public._jug_type_for_kind(p_factory uuid, p_kind text)
RETURNS uuid LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT ct.id FROM container_types ct
   WHERE ct.factory_id = p_factory AND ct.active AND ct.name ~* 'jug'
     AND CASE WHEN p_kind = 'old' THEN ct.name ~* 'old' ELSE ct.name !~* 'old' END
   ORDER BY ct.created_at LIMIT 1;
$$;
REVOKE ALL ON FUNCTION public._jug_type_for_kind(uuid, text) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public._jug_move(p_factory uuid, p_type uuid, p_from text, p_to text, p_qty numeric,
                                            p_source text, p_reference text, p_notes text DEFAULT NULL)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF p_type IS NULL OR COALESCE(p_qty, 0) <= 0 THEN RETURN; END IF;
  INSERT INTO container_movements(factory_id, container_type_id, from_type, to_type, quantity, source, reference,
                                  notes, created_by)
  VALUES (p_factory, p_type, p_from, p_to, p_qty, p_source, p_reference, p_notes, auth.uid());
END;
$$;
REVOKE ALL ON FUNCTION public._jug_move(uuid, uuid, text, text, numeric, text, text, text) FROM PUBLIC, anon, authenticated;

-- ---------------------------------------------------------------- QC consignments
CREATE OR REPLACE FUNCTION public._containers_on_qc_jug_batch()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_type uuid := public._jug_type_for_kind(NEW.factory_id, NEW.jug_kind);
  v_old text := CASE WHEN TG_OP = 'INSERT' THEN 'sent' ELSE OLD.status END;
BEGIN
  IF v_type IS NULL OR NEW.status = v_old THEN RETURN NEW; END IF;
  -- QC took them in: new jugs from the Store, or empties a marketer / the
  -- shop / a customer brought back (booked in by verify_jug_return).
  IF v_old = 'sent' AND NEW.status IN ('accepted', 'verified', 'received') THEN
    PERFORM public._jug_move(NEW.factory_id, v_type,
      CASE WHEN NEW.jug_return_id IS NOT NULL THEN 'warehouse' ELSE 'store' END, 'qc',
      NEW.quantity_accepted, 'qc_accept', NEW.reference);
  END IF;
  -- QC verified them: the damaged ones are written off.
  IF v_old IN ('sent', 'accepted') AND NEW.status IN ('verified', 'received') THEN
    PERFORM public._jug_move(NEW.factory_id, v_type, 'qc', 'external', NEW.quantity_damaged, 'qc_damaged',
      NEW.reference, NEW.damage_reason);
  END IF;
  -- The PM confirmed the good ones.
  IF NEW.status = 'received' THEN
    PERFORM public._jug_move(NEW.factory_id, v_type, 'qc', 'production', NEW.quantity_good, 'qc_to_production',
      NEW.reference);
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_containers_qc_jug_batch ON public.qc_jug_batches;
CREATE TRIGGER trg_containers_qc_jug_batch AFTER INSERT OR UPDATE OF status ON public.qc_jug_batches
  FOR EACH ROW EXECUTE FUNCTION public._containers_on_qc_jug_batch();

-- ---------------------------------------------------------------- releases
-- A dispenser accepted by the Warehouse brings its jug from Production.
CREATE OR REPLACE FUNCTION public._containers_on_release()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE r record;
BEGIN
  IF NEW.status = 'accepted' AND OLD.status IS DISTINCT FROM 'accepted' THEN
    FOR r IN SELECT pc.container_type_id, pc.quantity_per_unit FROM product_containers pc
              JOIN container_types ct ON ct.id = pc.container_type_id AND ct.active
             WHERE pc.product_id = NEW.product_id AND pc.jug_role IS DISTINCT FROM 'empty' LOOP
      PERFORM public._jug_move(NEW.factory_id, r.container_type_id, 'production', 'warehouse',
        COALESCE(NEW.accepted_quantity, 0) * r.quantity_per_unit, 'production_release', NEW.release_number);
    END LOOP;
  ELSIF OLD.status = 'accepted' AND NEW.status IS DISTINCT FROM 'accepted' THEN
    FOR r IN SELECT pc.container_type_id, pc.quantity_per_unit FROM product_containers pc
              JOIN container_types ct ON ct.id = pc.container_type_id AND ct.active
             WHERE pc.product_id = NEW.product_id AND pc.jug_role IS DISTINCT FROM 'empty' LOOP
      PERFORM public._jug_move(NEW.factory_id, r.container_type_id, 'warehouse', 'production',
        COALESCE(OLD.accepted_quantity, 0) * r.quantity_per_unit, 'production_release_reversal', NEW.release_number);
    END LOOP;
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_containers_release ON public.production_releases;
CREATE TRIGGER trg_containers_release AFTER UPDATE OF status ON public.production_releases
  FOR EACH ROW EXECUTE FUNCTION public._containers_on_release();

-- ---------------------------------------------------------------- Store
-- New jugs bought in are the Store's (body as 20261101090000, place changed).
CREATE OR REPLACE FUNCTION public.receive_new_jugs(
  p_factory uuid, p_container_type uuid, p_quantity numeric,
  p_reference text DEFAULT NULL, p_notes text DEFAULT NULL)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_ref text := NULLIF(btrim(COALESCE(p_reference, '')), '');
  v_notes text := NULLIF(btrim(COALESCE(p_notes, '')), '');
  v_id uuid;
BEGIN
  IF NOT (public.has_permission(v_uid, 'distribution'::module_key, 'confirm'::action_key)
          OR public.has_permission(v_uid, 'distribution'::module_key, 'approve'::action_key)
          OR public.has_permission(auth.uid(), 'raw-materials'::module_key, 'create'::action_key)
          OR public.has_permission(auth.uid(), 'raw-materials'::module_key, 'submit'::action_key)) THEN
    RAISE EXCEPTION 'Insufficient permissions';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM container_types WHERE id = p_container_type AND factory_id = p_factory) THEN
    RAISE EXCEPTION 'Jug type not found for this factory';
  END IF;
  IF p_quantity IS NULL OR p_quantity <= 0 OR p_quantity <> trunc(p_quantity) THEN
    RAISE EXCEPTION 'Enter a whole number of jugs above 0';
  END IF;
  IF v_ref IS NULL THEN RAISE EXCEPTION 'Enter the delivery note or invoice number'; END IF;

  INSERT INTO container_movements(factory_id, container_type_id, from_type, from_id, to_type, to_id, quantity,
                                  source, reference, notes, created_by)
  VALUES (p_factory, p_container_type, 'external', NULL, 'store', NULL, p_quantity,
          'purchase', v_ref, v_notes, v_uid)
  RETURNING id INTO v_id;

  INSERT INTO audit_logs(user_id, factory_id, action, entity, entity_id, new_value)
  VALUES (v_uid, p_factory, 'receive_new_jugs', 'container_movements', v_id::text,
          jsonb_build_object('container_type_id', p_container_type, 'quantity', p_quantity,
                             'reference', v_ref, 'notes', v_notes, 'into', 'store'));
  RETURN v_id;
END;
$$;
REVOKE ALL ON FUNCTION public.receive_new_jugs(uuid, uuid, numeric, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.receive_new_jugs(uuid, uuid, numeric, text, text) TO authenticated;

-- The Store issues jugs straight to Production (no QC check).
CREATE OR REPLACE FUNCTION public.send_jugs_to_production(payload jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_factory uuid := NULLIF(payload->>'factory_id', '')::uuid;
  v_kind text := NULLIF(payload->>'jug_kind', '');
  v_qty numeric := NULLIF(payload->>'quantity', '')::numeric;
  v_notes text := NULLIF(btrim(COALESCE(payload->>'notes', '')), '');
  v_client text := NULLIF(payload->>'client_ref', '');
  v_type uuid;
  v_ref text;
BEGIN
  IF NOT (public.has_permission(v_uid, 'raw-materials'::module_key, 'create'::action_key)
          OR public.has_permission(v_uid, 'raw-materials'::module_key, 'submit'::action_key)) THEN
    RAISE EXCEPTION 'Insufficient permissions';
  END IF;
  IF v_factory IS NULL OR NOT public._works_in_factory(v_uid, v_factory) THEN RAISE EXCEPTION 'factory_id required'; END IF;
  IF v_kind IS NULL OR v_kind NOT IN ('old', 'new') THEN RAISE EXCEPTION 'Choose Old Jug or New Jug'; END IF;
  IF v_qty IS NULL OR v_qty <= 0 OR v_qty <> trunc(v_qty) THEN RAISE EXCEPTION 'Enter a whole number of jugs above 0'; END IF;
  v_type := public._jug_type_for_kind(v_factory, v_kind);
  IF v_type IS NULL THEN RAISE EXCEPTION 'No % jug type is set up', CASE v_kind WHEN 'old' THEN 'Old' ELSE 'New' END; END IF;
  -- A double click sends once: the client reference is kept in the notes key.
  IF v_client IS NOT NULL AND EXISTS (SELECT 1 FROM container_movements
                                       WHERE source = 'store_to_production' AND notes LIKE '%[' || v_client || ']') THEN
    RETURN jsonb_build_object('duplicate', true);
  END IF;
  v_ref := 'JPM-' || to_char(now() AT TIME ZONE 'Africa/Lagos', 'YYYYMMDD') || '-' || lpad((floor(random() * 99999))::int::text, 5, '0');
  PERFORM public._jug_move(v_factory, v_type, 'store', 'production', v_qty, 'store_to_production', v_ref,
    btrim(COALESCE(v_notes, '') || CASE WHEN v_client IS NOT NULL THEN ' [' || v_client || ']' ELSE '' END));
  INSERT INTO audit_logs(user_id, factory_id, action, entity, entity_id, new_value)
  VALUES (v_uid, v_factory, 'send_jugs_to_production', 'container_movements', v_ref,
          jsonb_build_object('jug_kind', v_kind, 'quantity', v_qty, 'notes', v_notes));
  RETURN jsonb_build_object('reference', v_ref);
END;
$$;
REVOKE ALL ON FUNCTION public.send_jugs_to_production(jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.send_jugs_to_production(jsonb) TO authenticated;

-- ---------------------------------------------------------------- count
-- A physical count for one place: the difference goes to / from outside.
-- Admin / Chairman, or whoever approves distribution. Returns the change.
CREATE OR REPLACE FUNCTION public.set_jug_count(p_factory uuid, p_type uuid, p_place text, p_counted numeric,
                                                p_note text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_now numeric;
  v_diff numeric;
BEGIN
  IF v_uid IS NOT NULL AND NOT (public.has_role(v_uid, 'super_admin') OR public.has_role(v_uid, 'chairman')
                                OR public.has_permission(v_uid, 'distribution'::module_key, 'approve'::action_key)) THEN
    RAISE EXCEPTION 'Insufficient permissions';
  END IF;
  IF p_place NOT IN ('warehouse', 'store', 'qc', 'production') THEN
    RAISE EXCEPTION 'Count the Warehouse, Store, QC or Production';
  END IF;
  IF p_counted IS NULL OR p_counted < 0 OR p_counted <> trunc(p_counted) THEN
    RAISE EXCEPTION 'Enter the whole number of jugs counted';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM container_types WHERE id = p_type AND factory_id = p_factory) THEN
    RAISE EXCEPTION 'Jug type not found for this factory';
  END IF;
  v_now := COALESCE((SELECT SUM(CASE WHEN to_type = p_place THEN quantity ELSE -quantity END)
                       FROM container_movements
                      WHERE factory_id = p_factory AND container_type_id = p_type
                        AND (to_type = p_place OR from_type = p_place)), 0);
  v_diff := p_counted - v_now;
  IF v_diff > 0 THEN
    PERFORM public._jug_move(p_factory, p_type, 'external', p_place, v_diff, 'count', 'COUNT', p_note);
  ELSIF v_diff < 0 THEN
    PERFORM public._jug_move(p_factory, p_type, p_place, 'external', -v_diff, 'count', 'COUNT', p_note);
  END IF;
  INSERT INTO audit_logs(user_id, factory_id, action, entity, entity_id, old_value, new_value)
  VALUES (v_uid, p_factory, 'set_jug_count', 'container_movements', p_type::text,
          jsonb_build_object('place', p_place, 'ledger', v_now),
          jsonb_build_object('counted', p_counted, 'note', p_note));
  RETURN jsonb_build_object('place', p_place, 'was', v_now, 'counted', p_counted, 'change', v_diff);
END;
$$;
REVOKE ALL ON FUNCTION public.set_jug_count(uuid, uuid, text, numeric, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.set_jug_count(uuid, uuid, text, numeric, text) TO authenticated;

-- ---------------------------------------------------------------- report
-- Where every jug is at the end of a day (QC -> Reports, "Where the jugs
-- are", user 2026-11-04): per jug type, the Store, QC, Production, the
-- Warehouse, marketers and the shop, customers, walk-in sales.
CREATE OR REPLACE FUNCTION public.jug_locations(p_factory uuid, p_at date)
RETURNS TABLE(container_type_id uuid, container_name text, store numeric, qc numeric, production numeric,
              warehouse numeric, marketers numeric, customers numeric, walk_in numeric, total numeric)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
#variable_conflict use_column
BEGIN
  IF NOT (public._jug_can_view()
          OR public.has_permission(auth.uid(), 'goods-receiving'::module_key, 'view'::action_key)) THEN
    RAISE EXCEPTION 'Insufficient permissions';
  END IF;
  IF NOT public._works_in_factory(auth.uid(), p_factory) THEN RAISE EXCEPTION 'Insufficient permissions'; END IF;
  RETURN QUERY
  WITH d AS (
    SELECT m.container_type_id AS t, m.to_type AS h, m.quantity AS q FROM container_movements m
     WHERE m.factory_id = p_factory AND public._jug_day(m.created_at) <= p_at
    UNION ALL
    SELECT m.container_type_id, m.from_type, -m.quantity FROM container_movements m
     WHERE m.factory_id = p_factory AND public._jug_day(m.created_at) <= p_at
  ), s AS (
    SELECT t, SUM(q) FILTER (WHERE h = 'store') AS st, SUM(q) FILTER (WHERE h = 'qc') AS qc,
           SUM(q) FILTER (WHERE h = 'production') AS pr, SUM(q) FILTER (WHERE h = 'warehouse') AS wh,
           SUM(q) FILTER (WHERE h = 'sales_rep') AS mk, SUM(q) FILTER (WHERE h = 'customer') AS cu,
           SUM(q) FILTER (WHERE h = 'walk_in') AS wi
      FROM d GROUP BY t
  )
  SELECT ct.id, ct.name::text, COALESCE(s.st, 0), COALESCE(s.qc, 0), COALESCE(s.pr, 0), COALESCE(s.wh, 0),
         COALESCE(s.mk, 0), COALESCE(s.cu, 0), COALESCE(s.wi, 0),
         COALESCE(s.st, 0) + COALESCE(s.qc, 0) + COALESCE(s.pr, 0) + COALESCE(s.wh, 0)
           + COALESCE(s.mk, 0) + COALESCE(s.cu, 0) + COALESCE(s.wi, 0)
    FROM container_types ct LEFT JOIN s ON s.t = ct.id
   WHERE ct.factory_id = p_factory AND ct.active
   ORDER BY ct.name;
END;
$$;
REVOKE ALL ON FUNCTION public.jug_locations(uuid, date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.jug_locations(uuid, date) TO authenticated;

NOTIFY pgrst, 'reload schema';
