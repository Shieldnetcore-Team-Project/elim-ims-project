-- ============================================================================
-- Maintenance page (replaces Logistics), copied from the bluesprint system
-- ----------------------------------------------------------------------------
-- The user asked (2026-10-28) for bluesprint's Maintenance page here, in
-- place of Logistics (Vehicles, Drivers & Deliveries): Parts Inventory,
-- Maintenance Log, Issue Approvals, Stock Movements, Requests and Vehicles.
-- This is bluesprint's three Maintenance migrations, one after the other:
--   1. 20261027090000_maintenance_module.sql       requests + purchases
--   2. 20261027100000_maintenance_inventory.sql    parts, stock moves, log
--   3. 20261028090000_maintenance_issue_approval.sql  taking stock out needs
--                                                     approval
-- without bluesprint's grants to named people (its Blessing / Aisha are not
-- this system's): access is set per account here. It keeps the 'logistics'
-- permission key, so existing grants carry over. The vehicles register stays;
-- drivers / delivery routes / deliveries are left in the database, untouched,
-- but no longer shown. Per-account page access set on the old page carries
-- over to the new one.
-- Idempotent.
-- ============================================================================

-- ======================= 1. requests + purchases ===========================
CREATE TABLE IF NOT EXISTS public.maintenance_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  factory_id uuid NOT NULL REFERENCES public.factories(id) ON DELETE CASCADE,
  request_number text NOT NULL,
  category text NOT NULL CHECK (category IN
    ('machine_purchase','machine_parts','vehicle_repair','factory_maintenance','other')),
  title text NOT NULL,
  description text,
  vehicle_id uuid REFERENCES public.vehicles(id) ON DELETE SET NULL,
  asset_name text,
  priority text NOT NULL DEFAULT 'normal' CHECK (priority IN ('low','normal','high','urgent')),
  estimated_cost numeric(14,2) CHECK (estimated_cost IS NULL OR estimated_cost >= 0),
  status text NOT NULL DEFAULT 'pending_approval' CHECK (status IN
    ('pending_approval','approved','rejected','completed','cancelled')),
  requested_by uuid REFERENCES auth.users(id),
  requested_by_name text,
  decided_by uuid REFERENCES auth.users(id),
  decided_by_name text,
  decided_at timestamptz,
  decision_note text,
  completed_by uuid REFERENCES auth.users(id),
  completed_by_name text,
  completed_at timestamptz,
  completion_notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(factory_id, request_number)
);
CREATE INDEX IF NOT EXISTS maintenance_requests_factory_idx
  ON public.maintenance_requests(factory_id, created_at DESC);
GRANT SELECT ON public.maintenance_requests TO authenticated;
GRANT ALL ON public.maintenance_requests TO service_role;
ALTER TABLE public.maintenance_requests ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "maintenance read requests" ON public.maintenance_requests;
CREATE POLICY "maintenance read requests" ON public.maintenance_requests FOR SELECT TO authenticated
  USING (public.has_permission(auth.uid(), 'logistics'::module_key, 'read'::action_key));

CREATE TABLE IF NOT EXISTS public.maintenance_purchases (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id uuid NOT NULL REFERENCES public.maintenance_requests(id) ON DELETE CASCADE,
  factory_id uuid NOT NULL REFERENCES public.factories(id) ON DELETE CASCADE,
  purchase_date date NOT NULL DEFAULT CURRENT_DATE,
  item_description text NOT NULL,
  quantity numeric(14,3) NOT NULL DEFAULT 1 CHECK (quantity > 0),
  unit_cost numeric(14,2) NOT NULL CHECK (unit_cost >= 0),
  amount numeric(14,2) GENERATED ALWAYS AS (round(quantity * unit_cost, 2)) STORED,
  vendor text,
  receipt_ref text,
  notes text,
  recorded_by uuid REFERENCES auth.users(id),
  recorded_by_name text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS maintenance_purchases_request_idx
  ON public.maintenance_purchases(request_id);
GRANT SELECT ON public.maintenance_purchases TO authenticated;
GRANT ALL ON public.maintenance_purchases TO service_role;
ALTER TABLE public.maintenance_purchases ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "maintenance read purchases" ON public.maintenance_purchases;
CREATE POLICY "maintenance read purchases" ON public.maintenance_purchases FOR SELECT TO authenticated
  USING (public.has_permission(auth.uid(), 'logistics'::module_key, 'read'::action_key));

-- ---------- create ----------
CREATE OR REPLACE FUNCTION public.create_maintenance_request(payload jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_factory uuid := (payload->>'factory_id')::uuid;
  v_vehicle uuid := NULLIF(payload->>'vehicle_id','')::uuid;
  v_title text := NULLIF(btrim(payload->>'title'),'');
  v_number text;
  v_id uuid;
BEGIN
  IF NOT public.has_permission(v_uid, 'logistics'::module_key, 'create'::action_key) THEN
    RAISE EXCEPTION 'Insufficient permissions';
  END IF;
  IF v_factory IS NULL THEN RAISE EXCEPTION 'factory_id required'; END IF;
  IF v_title IS NULL THEN RAISE EXCEPTION 'A title is required'; END IF;
  IF v_vehicle IS NOT NULL AND NOT EXISTS
     (SELECT 1 FROM vehicles WHERE id = v_vehicle AND factory_id = v_factory) THEN
    RAISE EXCEPTION 'Vehicle not found in this factory';
  END IF;

  v_number := 'MNT-' || to_char(now(),'YYYYMMDD') || '-' || lpad(((floor(random()*99999))::int)::text, 5, '0');

  INSERT INTO maintenance_requests(factory_id, request_number, category, title, description,
                                   vehicle_id, asset_name, priority, estimated_cost,
                                   requested_by, requested_by_name)
  VALUES (v_factory, v_number, payload->>'category', v_title,
          NULLIF(btrim(payload->>'description'),''), v_vehicle,
          NULLIF(btrim(payload->>'asset_name'),''),
          COALESCE(NULLIF(payload->>'priority',''), 'normal'),
          NULLIF(payload->>'estimated_cost','')::numeric,
          v_uid, (SELECT full_name FROM profiles WHERE id = v_uid))
  RETURNING id INTO v_id;

  RETURN jsonb_build_object('id', v_id, 'request_number', v_number);
END;
$$;
GRANT EXECUTE ON FUNCTION public.create_maintenance_request(jsonb) TO authenticated;

-- ---------- approve / reject ----------
CREATE OR REPLACE FUNCTION public.decide_maintenance_request(p_id uuid, p_approve boolean, p_note text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_row maintenance_requests%ROWTYPE;
  v_status text := CASE WHEN p_approve THEN 'approved' ELSE 'rejected' END;
BEGIN
  IF NOT public.has_permission(v_uid, 'logistics'::module_key,
       (CASE WHEN p_approve THEN 'approve' ELSE 'reject' END)::action_key) THEN
    RAISE EXCEPTION 'Only an approver can % maintenance requests', CASE WHEN p_approve THEN 'approve' ELSE 'reject' END;
  END IF;
  IF NOT p_approve AND NULLIF(btrim(p_note),'') IS NULL THEN
    RAISE EXCEPTION 'A reason is required to reject';
  END IF;

  SELECT * INTO v_row FROM maintenance_requests WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Request not found'; END IF;
  IF v_row.status <> 'pending_approval' THEN
    RAISE EXCEPTION 'Request is already %', replace(v_row.status, '_', ' ');
  END IF;
  -- Maker-checker: the requester can't approve their own request (super_admin excepted).
  IF v_row.requested_by = v_uid AND NOT public.has_role(v_uid, 'super_admin') THEN
    RAISE EXCEPTION 'You cannot decide on your own request';
  END IF;

  UPDATE maintenance_requests SET
    status = v_status,
    decided_by = v_uid,
    decided_by_name = (SELECT full_name FROM profiles WHERE id = v_uid),
    decided_at = now(),
    decision_note = NULLIF(btrim(p_note),''),
    updated_at = now()
  WHERE id = p_id;

  RETURN jsonb_build_object('id', p_id, 'status', v_status);
END;
$$;
GRANT EXECUTE ON FUNCTION public.decide_maintenance_request(uuid, boolean, text) TO authenticated;

-- ---------- log a purchase against an approved request ----------
CREATE OR REPLACE FUNCTION public.add_maintenance_purchase(payload jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_req maintenance_requests%ROWTYPE;
  v_item text := NULLIF(btrim(payload->>'item_description'),'');
  v_id uuid;
BEGIN
  IF NOT public.has_permission(v_uid, 'logistics'::module_key, 'create'::action_key) THEN
    RAISE EXCEPTION 'Insufficient permissions';
  END IF;
  IF v_item IS NULL THEN RAISE EXCEPTION 'Describe what was bought or paid for'; END IF;

  SELECT * INTO v_req FROM maintenance_requests WHERE id = (payload->>'request_id')::uuid FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Request not found'; END IF;
  IF v_req.status <> 'approved' THEN
    RAISE EXCEPTION 'Purchases can only be logged on an approved, open request';
  END IF;

  INSERT INTO maintenance_purchases(request_id, factory_id, purchase_date, item_description,
                                    quantity, unit_cost, vendor, receipt_ref, notes,
                                    recorded_by, recorded_by_name)
  VALUES (v_req.id, v_req.factory_id,
          COALESCE(NULLIF(payload->>'purchase_date','')::date, CURRENT_DATE),
          v_item,
          COALESCE(NULLIF(payload->>'quantity','')::numeric, 1),
          (payload->>'unit_cost')::numeric,
          NULLIF(btrim(payload->>'vendor'),''),
          NULLIF(btrim(payload->>'receipt_ref'),''),
          NULLIF(btrim(payload->>'notes'),''),
          v_uid, (SELECT full_name FROM profiles WHERE id = v_uid))
  RETURNING id INTO v_id;

  UPDATE maintenance_requests SET updated_at = now() WHERE id = v_req.id;
  RETURN jsonb_build_object('id', v_id);
END;
$$;
GRANT EXECUTE ON FUNCTION public.add_maintenance_purchase(jsonb) TO authenticated;

-- ---------- mark accomplished ----------
CREATE OR REPLACE FUNCTION public.complete_maintenance_request(p_id uuid, p_notes text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_row maintenance_requests%ROWTYPE;
BEGIN
  IF NOT public.has_permission(v_uid, 'logistics'::module_key, 'edit'::action_key) THEN
    RAISE EXCEPTION 'Insufficient permissions';
  END IF;

  SELECT * INTO v_row FROM maintenance_requests WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Request not found'; END IF;
  IF v_row.status <> 'approved' THEN
    RAISE EXCEPTION 'Only an approved request can be marked completed';
  END IF;

  UPDATE maintenance_requests SET
    status = 'completed',
    completed_by = v_uid,
    completed_by_name = (SELECT full_name FROM profiles WHERE id = v_uid),
    completed_at = now(),
    completion_notes = NULLIF(btrim(p_notes),''),
    updated_at = now()
  WHERE id = p_id;

  RETURN jsonb_build_object('id', p_id, 'status', 'completed');
END;
$$;
GRANT EXECUTE ON FUNCTION public.complete_maintenance_request(uuid, text) TO authenticated;

-- ---------- cancel (requester or anyone with cancel) ----------
CREATE OR REPLACE FUNCTION public.cancel_maintenance_request(p_id uuid, p_reason text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_row maintenance_requests%ROWTYPE;
BEGIN
  SELECT * INTO v_row FROM maintenance_requests WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Request not found'; END IF;
  IF NOT (public.has_permission(v_uid, 'logistics'::module_key, 'cancel'::action_key)
          OR (v_row.requested_by = v_uid
              AND public.has_permission(v_uid, 'logistics'::module_key, 'create'::action_key))) THEN
    RAISE EXCEPTION 'Insufficient permissions';
  END IF;
  IF NULLIF(btrim(p_reason),'') IS NULL THEN RAISE EXCEPTION 'A reason is required'; END IF;
  IF v_row.status NOT IN ('pending_approval','approved') THEN
    RAISE EXCEPTION 'Request is already %', replace(v_row.status, '_', ' ');
  END IF;
  IF EXISTS (SELECT 1 FROM maintenance_purchases WHERE request_id = p_id) THEN
    RAISE EXCEPTION 'Purchases are already logged on this request — mark it completed instead';
  END IF;

  UPDATE maintenance_requests SET
    status = 'cancelled',
    decision_note = btrim(p_reason),
    updated_at = now()
  WHERE id = p_id;

  RETURN jsonb_build_object('id', p_id, 'status', 'cancelled');
END;
$$;
GRANT EXECUTE ON FUNCTION public.cancel_maintenance_request(uuid, text) TO authenticated;


-- ======================= 2. parts inventory + log ===========================

CREATE TABLE IF NOT EXISTS public.maintenance_parts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  factory_id uuid NOT NULL REFERENCES public.factories(id) ON DELETE CASCADE,
  name text NOT NULL,
  part_number text,
  category text NOT NULL DEFAULT 'other' CHECK (category IN
    ('machine_part','vehicle_part','electrical','plumbing','tools','lubricants','consumables','other')),
  unit text NOT NULL DEFAULT 'pcs',
  location text,
  reorder_level numeric(14,3) NOT NULL DEFAULT 0 CHECK (reorder_level >= 0),
  quantity_on_hand numeric(14,3) NOT NULL DEFAULT 0 CHECK (quantity_on_hand >= 0),
  last_unit_cost numeric(14,2) CHECK (last_unit_cost IS NULL OR last_unit_cost >= 0),
  notes text,
  is_active boolean NOT NULL DEFAULT true,
  created_by uuid REFERENCES auth.users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS maintenance_parts_name_uq
  ON public.maintenance_parts(factory_id, lower(name), lower(COALESCE(part_number, '')));
GRANT SELECT ON public.maintenance_parts TO authenticated;
GRANT ALL ON public.maintenance_parts TO service_role;
ALTER TABLE public.maintenance_parts ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "maintenance read parts" ON public.maintenance_parts;
CREATE POLICY "maintenance read parts" ON public.maintenance_parts FOR SELECT TO authenticated
  USING (public.has_permission(auth.uid(), 'logistics'::module_key, 'read'::action_key));

CREATE TABLE IF NOT EXISTS public.maintenance_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  factory_id uuid NOT NULL REFERENCES public.factories(id) ON DELETE CASCADE,
  log_number text NOT NULL,
  log_type text NOT NULL CHECK (log_type IN
    ('vehicle_repair','vehicle_service','machine_repair','machine_service','part_repair',
     'part_replacement','factory_maintenance','other')),
  title text NOT NULL,
  description text,
  vehicle_id uuid REFERENCES public.vehicles(id) ON DELETE SET NULL,
  asset_name text,
  service_date date NOT NULL DEFAULT CURRENT_DATE,
  performed_by text,
  odometer numeric(12,1) CHECK (odometer IS NULL OR odometer >= 0),
  labour_cost numeric(14,2) NOT NULL DEFAULT 0 CHECK (labour_cost >= 0),
  other_cost numeric(14,2) NOT NULL DEFAULT 0 CHECK (other_cost >= 0),
  next_service_date date,
  request_id uuid REFERENCES public.maintenance_requests(id) ON DELETE SET NULL,
  recorded_by uuid REFERENCES auth.users(id),
  recorded_by_name text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(factory_id, log_number)
);
CREATE INDEX IF NOT EXISTS maintenance_logs_factory_idx
  ON public.maintenance_logs(factory_id, service_date DESC);
GRANT SELECT ON public.maintenance_logs TO authenticated;
GRANT ALL ON public.maintenance_logs TO service_role;
ALTER TABLE public.maintenance_logs ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "maintenance read logs" ON public.maintenance_logs;
CREATE POLICY "maintenance read logs" ON public.maintenance_logs FOR SELECT TO authenticated
  USING (public.has_permission(auth.uid(), 'logistics'::module_key, 'read'::action_key));

ALTER TABLE public.maintenance_purchases
  ADD COLUMN IF NOT EXISTS part_id uuid REFERENCES public.maintenance_parts(id) ON DELETE SET NULL;

CREATE TABLE IF NOT EXISTS public.maintenance_stock_movements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  factory_id uuid NOT NULL REFERENCES public.factories(id) ON DELETE CASCADE,
  part_id uuid NOT NULL REFERENCES public.maintenance_parts(id) ON DELETE CASCADE,
  movement_type text NOT NULL CHECK (movement_type IN
    ('opening','received','purchased','issued','returned','adjustment')),
  quantity numeric(14,3) NOT NULL CHECK (quantity <> 0),
  unit_cost numeric(14,2) CHECK (unit_cost IS NULL OR unit_cost >= 0),
  balance_after numeric(14,3) NOT NULL,
  movement_date date NOT NULL DEFAULT CURRENT_DATE,
  source text,
  reference text,
  notes text,
  request_id uuid REFERENCES public.maintenance_requests(id) ON DELETE SET NULL,
  purchase_id uuid REFERENCES public.maintenance_purchases(id) ON DELETE SET NULL,
  log_id uuid REFERENCES public.maintenance_logs(id) ON DELETE SET NULL,
  recorded_by uuid REFERENCES auth.users(id),
  recorded_by_name text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS maintenance_stock_movements_part_idx
  ON public.maintenance_stock_movements(part_id, created_at DESC);
CREATE INDEX IF NOT EXISTS maintenance_stock_movements_factory_idx
  ON public.maintenance_stock_movements(factory_id, created_at DESC);
GRANT SELECT ON public.maintenance_stock_movements TO authenticated;
GRANT ALL ON public.maintenance_stock_movements TO service_role;
ALTER TABLE public.maintenance_stock_movements ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "maintenance read stock movements" ON public.maintenance_stock_movements;
CREATE POLICY "maintenance read stock movements" ON public.maintenance_stock_movements FOR SELECT TO authenticated
  USING (public.has_permission(auth.uid(), 'logistics'::module_key, 'read'::action_key));

-- ---------- the one place stock changes ----------
-- Not granted to clients; called only from the RPCs below.
CREATE OR REPLACE FUNCTION public._maintenance_move(
  p_part uuid, p_type text, p_qty numeric, p_unit_cost numeric, p_date date,
  p_source text, p_reference text, p_notes text,
  p_request uuid DEFAULT NULL, p_purchase uuid DEFAULT NULL, p_log uuid DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_part maintenance_parts%ROWTYPE;
  v_balance numeric;
  v_id uuid;
BEGIN
  IF p_qty IS NULL OR p_qty = 0 THEN RAISE EXCEPTION 'Quantity must not be zero'; END IF;

  SELECT * INTO v_part FROM maintenance_parts WHERE id = p_part FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Part not found'; END IF;

  v_balance := v_part.quantity_on_hand + p_qty;
  IF v_balance < 0 THEN
    RAISE EXCEPTION 'Not enough % in stock: % % on hand, % needed',
      v_part.name, v_part.quantity_on_hand, v_part.unit, -p_qty;
  END IF;

  UPDATE maintenance_parts SET
    quantity_on_hand = v_balance,
    last_unit_cost = CASE WHEN p_qty > 0 AND p_unit_cost IS NOT NULL AND p_type IN ('opening','received','purchased')
                          THEN p_unit_cost ELSE last_unit_cost END,
    updated_at = now()
  WHERE id = p_part;

  INSERT INTO maintenance_stock_movements(factory_id, part_id, movement_type, quantity, unit_cost,
                                          balance_after, movement_date, source, reference, notes,
                                          request_id, purchase_id, log_id, recorded_by, recorded_by_name)
  VALUES (v_part.factory_id, p_part, p_type, p_qty,
          COALESCE(p_unit_cost, CASE WHEN p_qty < 0 THEN v_part.last_unit_cost END),
          v_balance, COALESCE(p_date, CURRENT_DATE),
          NULLIF(btrim(p_source),''), NULLIF(btrim(p_reference),''), NULLIF(btrim(p_notes),''),
          p_request, p_purchase, p_log, v_uid, (SELECT full_name FROM profiles WHERE id = v_uid))
  RETURNING id INTO v_id;

  RETURN v_id;
END;
$$;
REVOKE ALL ON FUNCTION public._maintenance_move(uuid, text, numeric, numeric, date, text, text, text, uuid, uuid, uuid) FROM PUBLIC, anon, authenticated;

-- ---------- add / edit a part ----------
CREATE OR REPLACE FUNCTION public.save_maintenance_part(payload jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_id uuid := NULLIF(payload->>'id','')::uuid;
  v_factory uuid := (payload->>'factory_id')::uuid;
  v_name text := NULLIF(btrim(payload->>'name'),'');
  v_opening numeric := COALESCE(NULLIF(payload->>'opening_quantity','')::numeric, 0);
BEGIN
  IF v_name IS NULL THEN RAISE EXCEPTION 'A part name is required'; END IF;

  IF v_id IS NULL THEN
    IF NOT public.has_permission(v_uid, 'logistics'::module_key, 'create'::action_key) THEN
      RAISE EXCEPTION 'Insufficient permissions';
    END IF;
    IF v_factory IS NULL THEN RAISE EXCEPTION 'factory_id required'; END IF;
    IF v_opening < 0 THEN RAISE EXCEPTION 'Opening quantity cannot be negative'; END IF;

    INSERT INTO maintenance_parts(factory_id, name, part_number, category, unit, location,
                                  reorder_level, notes, created_by)
    VALUES (v_factory, v_name, NULLIF(btrim(payload->>'part_number'),''),
            COALESCE(NULLIF(payload->>'category',''), 'other'),
            COALESCE(NULLIF(btrim(payload->>'unit'),''), 'pcs'),
            NULLIF(btrim(payload->>'location'),''),
            COALESCE(NULLIF(payload->>'reorder_level','')::numeric, 0),
            NULLIF(btrim(payload->>'notes'),''), v_uid)
    RETURNING id INTO v_id;

    IF v_opening > 0 THEN
      PERFORM public._maintenance_move(v_id, 'opening', v_opening,
        NULLIF(payload->>'unit_cost','')::numeric, CURRENT_DATE, NULL, NULL, 'Opening stock');
    END IF;
  ELSE
    IF NOT public.has_permission(v_uid, 'logistics'::module_key, 'edit'::action_key) THEN
      RAISE EXCEPTION 'Insufficient permissions';
    END IF;
    UPDATE maintenance_parts SET
      name = v_name,
      part_number = NULLIF(btrim(payload->>'part_number'),''),
      category = COALESCE(NULLIF(payload->>'category',''), category),
      unit = COALESCE(NULLIF(btrim(payload->>'unit'),''), unit),
      location = NULLIF(btrim(payload->>'location'),''),
      reorder_level = COALESCE(NULLIF(payload->>'reorder_level','')::numeric, reorder_level),
      notes = NULLIF(btrim(payload->>'notes'),''),
      is_active = COALESCE((payload->>'is_active')::boolean, is_active),
      updated_at = now()
    WHERE id = v_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'Part not found'; END IF;
  END IF;

  RETURN jsonb_build_object('id', v_id);
END;
$$;
GRANT EXECUTE ON FUNCTION public.save_maintenance_part(jsonb) TO authenticated;

-- ---------- receive / buy / issue / return / adjust ----------
CREATE OR REPLACE FUNCTION public.record_maintenance_stock(payload jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_type text := payload->>'movement_type';
  v_qty numeric := (payload->>'quantity')::numeric;
  v_id uuid;
BEGIN
  IF v_type NOT IN ('received','purchased','issued','returned','adjustment') THEN
    RAISE EXCEPTION 'Invalid movement type';
  END IF;
  IF NOT public.has_permission(v_uid, 'logistics'::module_key,
       (CASE WHEN v_type = 'adjustment' THEN 'edit' ELSE 'create' END)::action_key) THEN
    RAISE EXCEPTION 'Insufficient permissions';
  END IF;
  IF v_qty IS NULL OR v_qty = 0 THEN RAISE EXCEPTION 'Quantity must not be zero'; END IF;
  IF v_type <> 'adjustment' AND v_qty < 0 THEN RAISE EXCEPTION 'Quantity must be positive'; END IF;
  IF v_type = 'adjustment' AND NULLIF(btrim(payload->>'notes'),'') IS NULL THEN
    RAISE EXCEPTION 'Give a reason for the adjustment';
  END IF;
  IF v_type = 'purchased' AND NULLIF(payload->>'unit_cost','') IS NULL THEN
    RAISE EXCEPTION 'Enter the unit cost of the purchase';
  END IF;

  v_id := public._maintenance_move(
    (payload->>'part_id')::uuid, v_type,
    CASE WHEN v_type = 'issued' THEN -v_qty ELSE v_qty END,
    NULLIF(payload->>'unit_cost','')::numeric,
    NULLIF(payload->>'movement_date','')::date,
    payload->>'source', payload->>'reference', payload->>'notes');

  RETURN jsonb_build_object('id', v_id);
END;
$$;
GRANT EXECUTE ON FUNCTION public.record_maintenance_stock(jsonb) TO authenticated;

-- ---------- log maintenance work, issuing any parts used ----------
CREATE OR REPLACE FUNCTION public.create_maintenance_log(payload jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_factory uuid := (payload->>'factory_id')::uuid;
  v_vehicle uuid := NULLIF(payload->>'vehicle_id','')::uuid;
  v_request uuid := NULLIF(payload->>'request_id','')::uuid;
  v_title text := NULLIF(btrim(payload->>'title'),'');
  v_date date := COALESCE(NULLIF(payload->>'service_date','')::date, CURRENT_DATE);
  v_number text;
  v_id uuid;
  v_line jsonb;
BEGIN
  IF NOT public.has_permission(v_uid, 'logistics'::module_key, 'create'::action_key) THEN
    RAISE EXCEPTION 'Insufficient permissions';
  END IF;
  IF v_factory IS NULL THEN RAISE EXCEPTION 'factory_id required'; END IF;
  IF v_title IS NULL THEN RAISE EXCEPTION 'A title is required'; END IF;
  IF v_vehicle IS NOT NULL AND NOT EXISTS
     (SELECT 1 FROM vehicles WHERE id = v_vehicle AND factory_id = v_factory) THEN
    RAISE EXCEPTION 'Vehicle not found in this factory';
  END IF;
  IF v_request IS NOT NULL AND NOT EXISTS
     (SELECT 1 FROM maintenance_requests WHERE id = v_request AND factory_id = v_factory
        AND status IN ('approved','completed')) THEN
    RAISE EXCEPTION 'Linked request must be an approved request in this factory';
  END IF;

  v_number := 'MLG-' || to_char(now(),'YYYYMMDD') || '-' || lpad(((floor(random()*99999))::int)::text, 5, '0');

  INSERT INTO maintenance_logs(factory_id, log_number, log_type, title, description, vehicle_id,
                               asset_name, service_date, performed_by, odometer, labour_cost,
                               other_cost, next_service_date, request_id, recorded_by, recorded_by_name)
  VALUES (v_factory, v_number, payload->>'log_type', v_title,
          NULLIF(btrim(payload->>'description'),''), v_vehicle,
          NULLIF(btrim(payload->>'asset_name'),''), v_date,
          NULLIF(btrim(payload->>'performed_by'),''),
          NULLIF(payload->>'odometer','')::numeric,
          COALESCE(NULLIF(payload->>'labour_cost','')::numeric, 0),
          COALESCE(NULLIF(payload->>'other_cost','')::numeric, 0),
          NULLIF(payload->>'next_service_date','')::date,
          v_request, v_uid, (SELECT full_name FROM profiles WHERE id = v_uid))
  RETURNING id INTO v_id;

  FOR v_line IN SELECT * FROM jsonb_array_elements(COALESCE(payload->'parts', '[]'::jsonb)) LOOP
    IF NOT EXISTS (SELECT 1 FROM maintenance_parts
                   WHERE id = (v_line->>'part_id')::uuid AND factory_id = v_factory) THEN
      RAISE EXCEPTION 'Part not found in this factory';
    END IF;
    IF COALESCE((v_line->>'quantity')::numeric, 0) <= 0 THEN
      RAISE EXCEPTION 'Part quantities must be positive';
    END IF;
    PERFORM public._maintenance_move((v_line->>'part_id')::uuid, 'issued',
      -((v_line->>'quantity')::numeric), NULL, v_date, NULL, v_number,
      'Used for ' || v_title, v_request, NULL, v_id);
  END LOOP;

  RETURN jsonb_build_object('id', v_id, 'log_number', v_number);
END;
$$;
GRANT EXECUTE ON FUNCTION public.create_maintenance_log(jsonb) TO authenticated;

-- ---------- request purchases can now add the bought part to stock ----------
-- Same body as 20261027090000 plus the optional part_id.
CREATE OR REPLACE FUNCTION public.add_maintenance_purchase(payload jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_req maintenance_requests%ROWTYPE;
  v_item text := NULLIF(btrim(payload->>'item_description'),'');
  v_part uuid := NULLIF(payload->>'part_id','')::uuid;
  v_qty numeric := COALESCE(NULLIF(payload->>'quantity','')::numeric, 1);
  v_date date := COALESCE(NULLIF(payload->>'purchase_date','')::date, CURRENT_DATE);
  v_id uuid;
BEGIN
  IF NOT public.has_permission(v_uid, 'logistics'::module_key, 'create'::action_key) THEN
    RAISE EXCEPTION 'Insufficient permissions';
  END IF;

  SELECT * INTO v_req FROM maintenance_requests WHERE id = (payload->>'request_id')::uuid FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Request not found'; END IF;
  IF v_req.status <> 'approved' THEN
    RAISE EXCEPTION 'Purchases can only be logged on an approved, open request';
  END IF;
  IF v_part IS NOT NULL THEN
    IF NOT EXISTS (SELECT 1 FROM maintenance_parts WHERE id = v_part AND factory_id = v_req.factory_id) THEN
      RAISE EXCEPTION 'Part not found in this factory';
    END IF;
    v_item := COALESCE(v_item, (SELECT name FROM maintenance_parts WHERE id = v_part));
  END IF;
  IF v_item IS NULL THEN RAISE EXCEPTION 'Describe what was bought or paid for'; END IF;

  INSERT INTO maintenance_purchases(request_id, factory_id, purchase_date, item_description,
                                    quantity, unit_cost, vendor, receipt_ref, notes,
                                    recorded_by, recorded_by_name, part_id)
  VALUES (v_req.id, v_req.factory_id, v_date, v_item, v_qty,
          (payload->>'unit_cost')::numeric,
          NULLIF(btrim(payload->>'vendor'),''),
          NULLIF(btrim(payload->>'receipt_ref'),''),
          NULLIF(btrim(payload->>'notes'),''),
          v_uid, (SELECT full_name FROM profiles WHERE id = v_uid), v_part)
  RETURNING id INTO v_id;

  IF v_part IS NOT NULL THEN
    PERFORM public._maintenance_move(v_part, 'purchased', v_qty, (payload->>'unit_cost')::numeric,
      v_date, payload->>'vendor', COALESCE(NULLIF(btrim(payload->>'receipt_ref'),''), v_req.request_number),
      'Bought for ' || v_req.request_number, v_req.id, v_id, NULL);
  END IF;

  UPDATE maintenance_requests SET updated_at = now() WHERE id = v_req.id;
  RETURN jsonb_build_object('id', v_id);
END;
$$;
GRANT EXECUTE ON FUNCTION public.add_maintenance_purchase(jsonb) TO authenticated;

-- ======================= 3. issues need approval ============================

CREATE TABLE IF NOT EXISTS public.maintenance_issue_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  factory_id uuid NOT NULL REFERENCES public.factories(id) ON DELETE CASCADE,
  issue_number text NOT NULL,
  kind text NOT NULL DEFAULT 'issue' CHECK (kind IN ('issue','adjustment')),
  part_id uuid NOT NULL REFERENCES public.maintenance_parts(id) ON DELETE CASCADE,
  quantity numeric(14,3) NOT NULL CHECK (quantity > 0), -- always the amount taken OUT
  movement_date date NOT NULL DEFAULT CURRENT_DATE,
  issued_to text,
  reference text,
  notes text,
  log_id uuid REFERENCES public.maintenance_logs(id) ON DELETE SET NULL,
  request_id uuid REFERENCES public.maintenance_requests(id) ON DELETE SET NULL,
  status text NOT NULL DEFAULT 'pending_approval' CHECK (status IN
    ('pending_approval','approved','rejected','cancelled')),
  requested_by uuid REFERENCES auth.users(id),
  requested_by_name text,
  decided_by uuid REFERENCES auth.users(id),
  decided_by_name text,
  decided_at timestamptz,
  decision_note text,
  movement_id uuid REFERENCES public.maintenance_stock_movements(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(factory_id, issue_number)
);
CREATE INDEX IF NOT EXISTS maintenance_issue_requests_pending_idx
  ON public.maintenance_issue_requests(factory_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS maintenance_issue_requests_part_idx
  ON public.maintenance_issue_requests(part_id) WHERE status = 'pending_approval';
GRANT SELECT ON public.maintenance_issue_requests TO authenticated;
GRANT ALL ON public.maintenance_issue_requests TO service_role;
ALTER TABLE public.maintenance_issue_requests ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "maintenance read issue requests" ON public.maintenance_issue_requests;
CREATE POLICY "maintenance read issue requests" ON public.maintenance_issue_requests FOR SELECT TO authenticated
  USING (public.has_permission(auth.uid(), 'logistics'::module_key, 'read'::action_key));

-- ---------- queue a stock-out for approval ----------
-- Not granted to clients; called only from the RPCs below.
CREATE OR REPLACE FUNCTION public._maintenance_request_issue(
  p_part uuid, p_kind text, p_qty numeric, p_date date, p_issued_to text,
  p_reference text, p_notes text, p_log uuid DEFAULT NULL, p_request uuid DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_part maintenance_parts%ROWTYPE;
  v_pending numeric;
  v_id uuid;
BEGIN
  IF p_qty IS NULL OR p_qty <= 0 THEN RAISE EXCEPTION 'Quantity must be positive'; END IF;

  -- Lock the part so two requests can't both claim the same last units.
  SELECT * INTO v_part FROM maintenance_parts WHERE id = p_part FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Part not found'; END IF;

  SELECT COALESCE(sum(quantity), 0) INTO v_pending
  FROM maintenance_issue_requests WHERE part_id = p_part AND status = 'pending_approval';

  IF p_qty > v_part.quantity_on_hand - v_pending THEN
    RAISE EXCEPTION 'Not enough % available: % % on hand, % already awaiting approval, % requested',
      v_part.name, v_part.quantity_on_hand, v_part.unit, v_pending, p_qty;
  END IF;

  INSERT INTO maintenance_issue_requests(factory_id, issue_number, kind, part_id, quantity,
                                         movement_date, issued_to, reference, notes, log_id,
                                         request_id, requested_by, requested_by_name)
  VALUES (v_part.factory_id,
          'ISS-' || to_char(now(),'YYYYMMDD') || '-' || lpad(((floor(random()*99999))::int)::text, 5, '0'),
          p_kind, p_part, p_qty, COALESCE(p_date, CURRENT_DATE),
          NULLIF(btrim(p_issued_to),''), NULLIF(btrim(p_reference),''), NULLIF(btrim(p_notes),''),
          p_log, p_request, v_uid, (SELECT full_name FROM profiles WHERE id = v_uid))
  RETURNING id INTO v_id;

  RETURN v_id;
END;
$$;
REVOKE ALL ON FUNCTION public._maintenance_request_issue(uuid, text, numeric, date, text, text, text, uuid, uuid) FROM PUBLIC, anon, authenticated;

-- ---------- receive / buy / return go straight in; issue / adjust-down wait ----------
CREATE OR REPLACE FUNCTION public.record_maintenance_stock(payload jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_type text := payload->>'movement_type';
  v_qty numeric := (payload->>'quantity')::numeric;
  v_id uuid;
BEGIN
  IF v_type NOT IN ('received','purchased','issued','returned','adjustment') THEN
    RAISE EXCEPTION 'Invalid movement type';
  END IF;
  IF NOT public.has_permission(v_uid, 'logistics'::module_key,
       (CASE WHEN v_type = 'adjustment' THEN 'edit' ELSE 'create' END)::action_key) THEN
    RAISE EXCEPTION 'Insufficient permissions';
  END IF;
  IF v_qty IS NULL OR v_qty = 0 THEN RAISE EXCEPTION 'Quantity must not be zero'; END IF;
  IF v_type <> 'adjustment' AND v_qty < 0 THEN RAISE EXCEPTION 'Quantity must be positive'; END IF;
  IF v_type = 'adjustment' AND NULLIF(btrim(payload->>'notes'),'') IS NULL THEN
    RAISE EXCEPTION 'Give a reason for the adjustment';
  END IF;
  IF v_type = 'purchased' AND NULLIF(payload->>'unit_cost','') IS NULL THEN
    RAISE EXCEPTION 'Enter the unit cost of the purchase';
  END IF;

  IF v_type = 'issued' OR (v_type = 'adjustment' AND v_qty < 0) THEN
    v_id := public._maintenance_request_issue(
      (payload->>'part_id')::uuid,
      CASE WHEN v_type = 'issued' THEN 'issue' ELSE 'adjustment' END,
      abs(v_qty), NULLIF(payload->>'movement_date','')::date,
      payload->>'source', payload->>'reference', payload->>'notes');
    RETURN jsonb_build_object('id', v_id, 'pending_approval', true);
  END IF;

  v_id := public._maintenance_move(
    (payload->>'part_id')::uuid, v_type, v_qty,
    NULLIF(payload->>'unit_cost','')::numeric,
    NULLIF(payload->>'movement_date','')::date,
    payload->>'source', payload->>'reference', payload->>'notes');

  RETURN jsonb_build_object('id', v_id, 'pending_approval', false);
END;
$$;
GRANT EXECUTE ON FUNCTION public.record_maintenance_stock(jsonb) TO authenticated;

-- ---------- maintenance log: parts used wait for approval ----------
-- Same body as 20261027100000 except each part line is queued, not issued.
CREATE OR REPLACE FUNCTION public.create_maintenance_log(payload jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_factory uuid := (payload->>'factory_id')::uuid;
  v_vehicle uuid := NULLIF(payload->>'vehicle_id','')::uuid;
  v_request uuid := NULLIF(payload->>'request_id','')::uuid;
  v_title text := NULLIF(btrim(payload->>'title'),'');
  v_date date := COALESCE(NULLIF(payload->>'service_date','')::date, CURRENT_DATE);
  v_number text;
  v_id uuid;
  v_line jsonb;
  v_queued int := 0;
BEGIN
  IF NOT public.has_permission(v_uid, 'logistics'::module_key, 'create'::action_key) THEN
    RAISE EXCEPTION 'Insufficient permissions';
  END IF;
  IF v_factory IS NULL THEN RAISE EXCEPTION 'factory_id required'; END IF;
  IF v_title IS NULL THEN RAISE EXCEPTION 'A title is required'; END IF;
  IF v_vehicle IS NOT NULL AND NOT EXISTS
     (SELECT 1 FROM vehicles WHERE id = v_vehicle AND factory_id = v_factory) THEN
    RAISE EXCEPTION 'Vehicle not found in this factory';
  END IF;
  IF v_request IS NOT NULL AND NOT EXISTS
     (SELECT 1 FROM maintenance_requests WHERE id = v_request AND factory_id = v_factory
        AND status IN ('approved','completed')) THEN
    RAISE EXCEPTION 'Linked request must be an approved request in this factory';
  END IF;

  v_number := 'MLG-' || to_char(now(),'YYYYMMDD') || '-' || lpad(((floor(random()*99999))::int)::text, 5, '0');

  INSERT INTO maintenance_logs(factory_id, log_number, log_type, title, description, vehicle_id,
                               asset_name, service_date, performed_by, odometer, labour_cost,
                               other_cost, next_service_date, request_id, recorded_by, recorded_by_name)
  VALUES (v_factory, v_number, payload->>'log_type', v_title,
          NULLIF(btrim(payload->>'description'),''), v_vehicle,
          NULLIF(btrim(payload->>'asset_name'),''), v_date,
          NULLIF(btrim(payload->>'performed_by'),''),
          NULLIF(payload->>'odometer','')::numeric,
          COALESCE(NULLIF(payload->>'labour_cost','')::numeric, 0),
          COALESCE(NULLIF(payload->>'other_cost','')::numeric, 0),
          NULLIF(payload->>'next_service_date','')::date,
          v_request, v_uid, (SELECT full_name FROM profiles WHERE id = v_uid))
  RETURNING id INTO v_id;

  FOR v_line IN SELECT * FROM jsonb_array_elements(COALESCE(payload->'parts', '[]'::jsonb)) LOOP
    IF NOT EXISTS (SELECT 1 FROM maintenance_parts
                   WHERE id = (v_line->>'part_id')::uuid AND factory_id = v_factory) THEN
      RAISE EXCEPTION 'Part not found in this factory';
    END IF;
    PERFORM public._maintenance_request_issue((v_line->>'part_id')::uuid, 'issue',
      (v_line->>'quantity')::numeric, v_date, NULL, v_number,
      'Used for ' || v_title, v_id, v_request);
    v_queued := v_queued + 1;
  END LOOP;

  RETURN jsonb_build_object('id', v_id, 'log_number', v_number, 'parts_pending_approval', v_queued);
END;
$$;
GRANT EXECUTE ON FUNCTION public.create_maintenance_log(jsonb) TO authenticated;

-- ---------- approve / reject ----------
CREATE OR REPLACE FUNCTION public.decide_maintenance_issue(p_id uuid, p_approve boolean, p_note text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_row maintenance_issue_requests%ROWTYPE;
  v_movement uuid;
BEGIN
  IF NOT public.has_permission(v_uid, 'logistics'::module_key,
       (CASE WHEN p_approve THEN 'approve' ELSE 'reject' END)::action_key) THEN
    RAISE EXCEPTION 'Only an approver can % stock issues', CASE WHEN p_approve THEN 'approve' ELSE 'reject' END;
  END IF;
  IF NOT p_approve AND NULLIF(btrim(p_note),'') IS NULL THEN
    RAISE EXCEPTION 'A reason is required to reject';
  END IF;

  SELECT * INTO v_row FROM maintenance_issue_requests WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Issue request not found'; END IF;
  IF v_row.status <> 'pending_approval' THEN
    RAISE EXCEPTION 'Issue request is already %', replace(v_row.status, '_', ' ');
  END IF;
  -- Maker-checker: the requester can't approve their own issue (super_admin excepted).
  IF v_row.requested_by = v_uid AND NOT public.has_role(v_uid, 'super_admin') THEN
    RAISE EXCEPTION 'You cannot decide on your own request';
  END IF;

  IF p_approve THEN
    v_movement := public._maintenance_move(
      v_row.part_id,
      CASE WHEN v_row.kind = 'issue' THEN 'issued' ELSE 'adjustment' END,
      -v_row.quantity, NULL, v_row.movement_date, v_row.issued_to,
      COALESCE(v_row.reference, v_row.issue_number),
      concat_ws(' — ', v_row.notes, 'approved ' || v_row.issue_number),
      v_row.request_id, NULL, v_row.log_id);
  END IF;

  UPDATE maintenance_issue_requests SET
    status = CASE WHEN p_approve THEN 'approved' ELSE 'rejected' END,
    decided_by = v_uid,
    decided_by_name = (SELECT full_name FROM profiles WHERE id = v_uid),
    decided_at = now(),
    decision_note = NULLIF(btrim(p_note),''),
    movement_id = v_movement
  WHERE id = p_id;

  RETURN jsonb_build_object('id', p_id, 'status', CASE WHEN p_approve THEN 'approved' ELSE 'rejected' END);
END;
$$;
GRANT EXECUTE ON FUNCTION public.decide_maintenance_issue(uuid, boolean, text) TO authenticated;

-- ---------- withdraw (requester, or anyone with cancel) ----------
CREATE OR REPLACE FUNCTION public.cancel_maintenance_issue(p_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_row maintenance_issue_requests%ROWTYPE;
BEGIN
  SELECT * INTO v_row FROM maintenance_issue_requests WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Issue request not found'; END IF;
  IF NOT (public.has_permission(v_uid, 'logistics'::module_key, 'cancel'::action_key)
          OR (v_row.requested_by = v_uid
              AND public.has_permission(v_uid, 'logistics'::module_key, 'create'::action_key))) THEN
    RAISE EXCEPTION 'Insufficient permissions';
  END IF;
  IF v_row.status <> 'pending_approval' THEN
    RAISE EXCEPTION 'Issue request is already %', replace(v_row.status, '_', ' ');
  END IF;

  UPDATE maintenance_issue_requests SET
    status = 'cancelled', decided_by = v_uid,
    decided_by_name = (SELECT full_name FROM profiles WHERE id = v_uid), decided_at = now()
  WHERE id = p_id;

  RETURN jsonb_build_object('id', p_id, 'status', 'cancelled');
END;
$$;
GRANT EXECUTE ON FUNCTION public.cancel_maintenance_issue(uuid) TO authenticated;

-- ======================= live updates ======================================
-- The page, the Approval Center and the bell refresh as soon as a part is
-- received, issued or approved.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['maintenance_parts', 'maintenance_stock_movements',
                           'maintenance_issue_requests', 'maintenance_logs',
                           'maintenance_requests', 'maintenance_purchases', 'vehicles'] LOOP
    IF to_regclass('public.' || t) IS NOT NULL AND NOT EXISTS (
         SELECT 1 FROM pg_publication_tables
          WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = t) THEN
      EXECUTE format('ALTER PUBLICATION supabase_realtime ADD TABLE public.%I', t);
    END IF;
  END LOOP;
END;
$$;

-- ======================= page access carries over ===========================
-- The page's id is its sidebar title: "Vehicles, Drivers & Deliveries" is now
-- "Maintenance". Whoever was allowed or blocked keeps that.
INSERT INTO public.user_page_access (user_id, page_id, granted, granted_by, granted_at)
SELECT user_id, 'Maintenance', granted, granted_by, granted_at
  FROM public.user_page_access
 WHERE page_id = 'Vehicles, Drivers & Deliveries'
ON CONFLICT (user_id, page_id) DO NOTHING;
DELETE FROM public.user_page_access WHERE page_id = 'Vehicles, Drivers & Deliveries';

NOTIFY pgrst, 'reload schema';
