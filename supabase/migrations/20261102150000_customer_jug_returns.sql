-- ============================================================================
-- Empty jugs back from Distributor/Office Delivery customers
-- ----------------------------------------------------------------------------
-- User (2026-11-02): Warehouse → Dispenser & jugs → Return empty jugs lists
-- every marketer AND every Distributor/Office Delivery customer.
--
--   jug_returns.customer_id   the customer who brought them (registered, no
--                             marketer); sales_rep_id is now optional --
--                             exactly one of the two is set
--   _jug_customer_balance     jugs a customer holds: what reached them on the
--                             jug ledger less what came back
--   record_jug_return         payload.customer_id instead of sales_rep_id;
--                             at most what they hold less returns still
--                             waiting for QC
--   verify_jug_return         QC's count moves the jugs customer -> Warehouse
--                             and becomes QC's consignment, as for a
--                             marketer. No money: a distributor's sale is at
--                             the product price, the jug not charged (a
--                             marketer is credited because his postings
--                             carry the jug price).
--   qc_pending_jug_returns    names the customer
-- Marketers' and the shop's returns are unchanged.
-- ============================================================================

ALTER TABLE public.jug_returns ADD COLUMN IF NOT EXISTS customer_id uuid REFERENCES public.customers(id);
ALTER TABLE public.jug_returns ALTER COLUMN sales_rep_id DROP NOT NULL;
ALTER TABLE public.jug_returns DROP CONSTRAINT IF EXISTS jug_returns_one_holder;
ALTER TABLE public.jug_returns ADD CONSTRAINT jug_returns_one_holder
  CHECK (num_nonnulls(sales_rep_id, customer_id) = 1);
CREATE INDEX IF NOT EXISTS jug_returns_customer_idx ON public.jug_returns (customer_id, recorded_at)
  WHERE customer_id IS NOT NULL;

CREATE OR REPLACE FUNCTION public._jug_customer_balance(p_customer uuid, p_type uuid)
RETURNS numeric LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT COALESCE(SUM(CASE WHEN to_type = 'customer' AND to_id = p_customer THEN quantity ELSE 0 END), 0)
       - COALESCE(SUM(CASE WHEN from_type = 'customer' AND from_id = p_customer THEN quantity ELSE 0 END), 0)
    FROM container_movements
   WHERE container_type_id = p_type
     AND ((to_type = 'customer' AND to_id = p_customer) OR (from_type = 'customer' AND from_id = p_customer));
$$;
REVOKE ALL ON FUNCTION public._jug_customer_balance(uuid, uuid) FROM PUBLIC, anon, authenticated;

-- As 20261020200000, plus payload.customer_id.
CREATE OR REPLACE FUNCTION public.record_jug_return(payload jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_rep uuid := NULLIF(payload->>'sales_rep_id', '')::uuid;
  v_customer uuid := NULLIF(payload->>'customer_id', '')::uuid;
  v_type uuid := NULLIF(payload->>'container_type_id', '')::uuid;
  v_qty numeric := NULLIF(payload->>'quantity', '')::numeric;
  v_notes text := NULLIF(btrim(COALESCE(payload->>'notes', '')), '');
  v_client uuid := NULLIF(payload->>'client_ref', '')::uuid;
  v_r sales_reps%ROWTYPE;
  v_c customers%ROWTYPE;
  v_factory uuid;
  v_name text;
  v_existing jug_returns%ROWTYPE;
  v_returnable numeric;
  v_ref text;
  v_id uuid;
BEGIN
  IF NOT (public.has_permission(v_uid, 'distribution'::module_key, 'create'::action_key)
          OR public.has_permission(v_uid, 'sales'::module_key, 'create'::action_key)) THEN
    RAISE EXCEPTION 'Insufficient permissions';
  END IF;
  IF v_client IS NOT NULL THEN
    SELECT * INTO v_existing FROM jug_returns WHERE client_ref = v_client;
    IF FOUND THEN RETURN jsonb_build_object('id', v_existing.id, 'reference', v_existing.reference, 'duplicate', true); END IF;
  END IF;
  IF (v_rep IS NULL) = (v_customer IS NULL) THEN
    RAISE EXCEPTION 'Choose who brought the jugs back';
  END IF;
  IF v_qty IS NULL OR v_qty <= 0 OR v_qty <> trunc(v_qty) THEN
    RAISE EXCEPTION 'Enter a whole number of jugs above 0';
  END IF;

  IF v_rep IS NOT NULL THEN
    -- Serialise claims per marketer so two at once cannot both pass the check.
    SELECT * INTO v_r FROM sales_reps WHERE id = v_rep FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Marketer not found'; END IF;
    v_factory := v_r.factory_id;
    v_name := v_r.full_name;
  ELSE
    SELECT * INTO v_c FROM customers WHERE id = v_customer FOR UPDATE;
    IF NOT FOUND OR v_c.removed_at IS NOT NULL THEN RAISE EXCEPTION 'Customer not found'; END IF;
    v_factory := v_c.factory_id;
    v_name := v_c.name;
  END IF;
  IF NOT public._works_in_factory(v_uid, v_factory) THEN RAISE EXCEPTION 'Insufficient permissions'; END IF;
  IF NOT EXISTS (SELECT 1 FROM container_types WHERE id = v_type AND factory_id = v_factory) THEN
    RAISE EXCEPTION 'Jug type not found for this factory';
  END IF;

  IF v_rep IS NOT NULL THEN
    v_returnable := public._jug_rep_balance(v_rep, v_type) - public._jug_rep_full(v_rep, v_type)
                  - COALESCE((SELECT SUM(quantity_claimed) FROM jug_returns
                               WHERE sales_rep_id = v_rep AND container_type_id = v_type AND status = 'pending'), 0);
  ELSE
    v_returnable := public._jug_customer_balance(v_customer, v_type)
                  - COALESCE((SELECT SUM(quantity_claimed) FROM jug_returns
                               WHERE customer_id = v_customer AND container_type_id = v_type AND status = 'pending'), 0);
  END IF;
  IF v_qty > GREATEST(v_returnable, 0) THEN
    RAISE EXCEPTION '% can return at most % empty jugs (the rest are full on their stock, already claimed, or not owed). Record a write-off or opening balance first if the figures are wrong.',
      v_name, trim_scale(GREATEST(v_returnable, 0));
  END IF;

  v_ref := 'JR-' || to_char(now() AT TIME ZONE 'Africa/Lagos', 'YYYYMMDD') || '-' || lpad(nextval('public.jug_return_seq')::text, 5, '0');
  INSERT INTO jug_returns(factory_id, reference, client_ref, sales_rep_id, customer_id, container_type_id,
                          quantity_claimed, notes, recorded_by)
  VALUES (v_factory, v_ref, v_client, v_rep, v_customer, v_type, v_qty, v_notes, v_uid)
  RETURNING id INTO v_id;
  INSERT INTO audit_logs(user_id, factory_id, action, entity, entity_id, new_value)
  VALUES (v_uid, v_factory, 'record_jug_return', 'jug_returns', v_id::text,
          jsonb_build_object('reference', v_ref, 'sales_rep_id', v_rep, 'customer_id', v_customer, 'quantity', v_qty));
  RETURN jsonb_build_object('id', v_id, 'reference', v_ref);
END;
$$;
REVOKE ALL ON FUNCTION public.record_jug_return(jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.record_jug_return(jsonb) TO authenticated;

-- As 20261101100000, plus a customer's return (no money credited).
CREATE OR REPLACE FUNCTION public.verify_jug_return(p_id uuid, p_received numeric, p_note text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_j jug_returns%ROWTYPE;
  v_rep sales_reps%ROWTYPE;
  v_cust customers%ROWTYPE;
  v_name text;
  v_can_hold numeric;
  v_note text := NULLIF(btrim(COALESCE(p_note, '')), '');
  v_type container_types%ROWTYPE;
  v_credit numeric;
BEGIN
  -- QC counts the empties the Warehouse recorded (user, 2026-11-01).
  IF NOT (public.has_permission(v_uid, 'goods-receiving'::module_key, 'submit'::action_key)
          OR public.has_role(v_uid, 'super_admin') OR public.has_role(v_uid, 'chairman')) THEN
    RAISE EXCEPTION 'Only Quality Control counts returned jugs';
  END IF;
  SELECT * INTO v_j FROM jug_returns WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Return not found'; END IF;
  IF v_j.status <> 'pending' THEN RAISE EXCEPTION 'Return % is already %', v_j.reference, v_j.status; END IF;
  IF v_j.recorded_by = v_uid AND NOT (public.has_role(v_uid, 'super_admin') OR public.has_role(v_uid, 'chairman')) THEN
    RAISE EXCEPTION 'Someone other than the person who recorded % must count and confirm it', v_j.reference;
  END IF;
  IF p_received IS NULL OR p_received < 0 OR p_received <> trunc(p_received) THEN
    RAISE EXCEPTION 'Enter the whole number of jugs counted (0 if none arrived)';
  END IF;
  IF p_received > v_j.quantity_claimed THEN
    RAISE EXCEPTION 'Counted % but the Warehouse recorded % -- the Warehouse records the extra jugs as a new return',
      trim_scale(p_received), trim_scale(v_j.quantity_claimed);
  END IF;
  IF p_received <> v_j.quantity_claimed AND v_note IS NULL THEN
    RAISE EXCEPTION 'The count differs from the % claimed -- say why', trim_scale(v_j.quantity_claimed);
  END IF;

  IF v_j.sales_rep_id IS NOT NULL THEN
    SELECT * INTO v_rep FROM sales_reps WHERE id = v_j.sales_rep_id FOR UPDATE;
    v_name := v_rep.full_name;
    v_can_hold := public._jug_rep_balance(v_j.sales_rep_id, v_j.container_type_id)
                - public._jug_rep_full(v_j.sales_rep_id, v_j.container_type_id);
  ELSE
    SELECT * INTO v_cust FROM customers WHERE id = v_j.customer_id FOR UPDATE;
    v_name := v_cust.name;
    v_can_hold := public._jug_customer_balance(v_j.customer_id, v_j.container_type_id);
  END IF;
  IF p_received > GREATEST(v_can_hold, 0) THEN
    RAISE EXCEPTION '% owes only % empty jugs -- more than that cannot be received from them. Record an opening balance first if they really held more.',
      v_name, trim_scale(GREATEST(v_can_hold, 0));
  END IF;

  IF p_received > 0 THEN
    INSERT INTO container_movements(factory_id, container_type_id, from_type, from_id, to_type, to_id, quantity,
                                    source, reference, notes, created_by)
    VALUES (v_j.factory_id, v_j.container_type_id,
            CASE WHEN v_j.sales_rep_id IS NOT NULL THEN 'sales_rep' ELSE 'customer' END,
            COALESCE(v_j.sales_rep_id, v_j.customer_id), 'warehouse', NULL, p_received,
            'return', v_j.reference, COALESCE(v_note, v_j.notes), v_uid);
  END IF;
  -- A marketer is credited the jug price for each jug counted back; the
  -- shop and a customer are not.
  SELECT * INTO v_type FROM container_types WHERE id = v_j.container_type_id;
  v_credit := CASE WHEN v_rep.kind = 'rep' THEN v_type.jar_price END;
  UPDATE jug_returns SET status = 'verified', quantity_received = p_received, verified_by = v_uid,
         verified_at = now(), verify_note = v_note, credit_price = v_credit
   WHERE id = p_id;

  -- The counted jugs are QC's from here: an accepted consignment, which QC
  -- verifies (good / damaged) and posts to the PM as usual.
  IF p_received > 0 THEN
    INSERT INTO qc_jug_batches (factory_id, reference, jug_kind, quantity_sent, send_notes, sent_by, sent_at,
                                status, quantity_accepted, accept_note, accepted_by, accepted_at, jug_return_id)
    VALUES (v_j.factory_id, v_j.reference, CASE WHEN v_type.name ~* 'old' THEN 'old' ELSE 'new' END,
            v_j.quantity_claimed, 'From ' || v_name || COALESCE(' -- ' || v_j.notes, ''),
            v_j.recorded_by, v_j.recorded_at, 'accepted', p_received, v_note, v_uid, now(), v_j.id)
    ON CONFLICT (reference) DO NOTHING;
  END IF;
  INSERT INTO audit_logs(user_id, factory_id, action, entity, entity_id, old_value, new_value)
  VALUES (v_uid, v_j.factory_id, 'verify_jug_return', 'jug_returns', p_id::text,
          jsonb_build_object('claimed', v_j.quantity_claimed),
          jsonb_build_object('received', p_received, 'note', v_note));
  RETURN jsonb_build_object('reference', v_j.reference, 'received', p_received,
                            'short', v_j.quantity_claimed - p_received);
END;
$$;
REVOKE ALL ON FUNCTION public.verify_jug_return(uuid, numeric, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.verify_jug_return(uuid, numeric, text) TO authenticated;

-- What QC has to count, now naming a customer too.
CREATE OR REPLACE FUNCTION public.qc_pending_jug_returns(p_factory uuid)
RETURNS TABLE(id uuid, reference text, holder text, holder_kind text, jug text, quantity_claimed numeric,
              notes text, recorded_by uuid, recorded_by_name text, recorded_at timestamptz)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
#variable_conflict use_column
BEGIN
  IF NOT (public._qc_jug_can_view() OR public.has_permission(auth.uid(), 'goods-receiving'::module_key, 'submit'::action_key)) THEN
    RAISE EXCEPTION 'Insufficient permissions';
  END IF;
  RETURN QUERY
  SELECT j.id, j.reference, COALESCE(r.full_name, c.name)::text,
         COALESCE(r.kind, 'customer')::text, ct.name::text, j.quantity_claimed, j.notes,
         j.recorded_by, COALESCE(NULLIF(p.full_name, ''), p.email)::text, j.recorded_at
    FROM jug_returns j
    LEFT JOIN sales_reps r ON r.id = j.sales_rep_id
    LEFT JOIN customers c ON c.id = j.customer_id
    JOIN container_types ct ON ct.id = j.container_type_id
    LEFT JOIN profiles p ON p.id = j.recorded_by
   WHERE j.factory_id = p_factory AND j.status = 'pending'
   ORDER BY j.recorded_at;
END;
$$;
