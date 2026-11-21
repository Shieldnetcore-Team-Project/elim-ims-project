-- ============================================================================
-- Maintenance › Requests → Cash Requisition
-- ----------------------------------------------------------------------------
-- The user asked (2026-11-21):
--   * a request lists items: item name, description, qty, amount; each line
--     totals qty x amount and the request shows the total cost of all items;
--   * it prints as the ELIM TABLE WATER "CASH REQUISITION FORM" (letterhead,
--     requested by, date, title);
--   * it goes to Accounts to accept or reject (reason required), and to the
--     Chairman.
--
-- Flow: pending_approval (waiting for Accounts)
--         → Accounts accepts → accounts_approved (waiting for the Chairman)
--         → Chairman approves → approved (then purchases / completed as before)
--       Either can reject with a reason → rejected.
-- Accounts = an Accountant (role), anyone granted Finance 'approve', or the
-- Admin (super_admin); Chairman = chairman or super_admin. The Chairman is
-- not Accounts, so one person can't pass both stages (Admin excepted). The requester never decides their own
-- (super_admin excepted, as before).
-- Needs 20261028290000_maintenance_page.sql first. Idempotent.
-- ============================================================================

-- ---------- items ----------
CREATE TABLE IF NOT EXISTS public.maintenance_request_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id uuid NOT NULL REFERENCES public.maintenance_requests(id) ON DELETE CASCADE,
  factory_id uuid NOT NULL REFERENCES public.factories(id) ON DELETE CASCADE,
  line_no int NOT NULL DEFAULT 1,
  item_name text NOT NULL CHECK (btrim(item_name) <> ''),
  description text,
  quantity numeric(14,3) NOT NULL CHECK (quantity > 0),
  unit_amount numeric(14,2) NOT NULL CHECK (unit_amount >= 0),
  amount numeric(14,2) GENERATED ALWAYS AS (round(quantity * unit_amount, 2)) STORED,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS maintenance_request_items_request_idx
  ON public.maintenance_request_items(request_id, line_no);
GRANT SELECT ON public.maintenance_request_items TO authenticated;
GRANT ALL ON public.maintenance_request_items TO service_role;
ALTER TABLE public.maintenance_request_items ENABLE ROW LEVEL SECURITY;

-- ---------- two-stage decision columns ----------
ALTER TABLE public.maintenance_requests
  ADD COLUMN IF NOT EXISTS accounts_by uuid REFERENCES auth.users(id),
  ADD COLUMN IF NOT EXISTS accounts_by_name text,
  ADD COLUMN IF NOT EXISTS accounts_at timestamptz,
  ADD COLUMN IF NOT EXISTS accounts_note text,
  ADD COLUMN IF NOT EXISTS chairman_by uuid REFERENCES auth.users(id),
  ADD COLUMN IF NOT EXISTS chairman_by_name text,
  ADD COLUMN IF NOT EXISTS chairman_at timestamptz,
  ADD COLUMN IF NOT EXISTS chairman_note text;

ALTER TABLE public.maintenance_requests DROP CONSTRAINT IF EXISTS maintenance_requests_status_check;
ALTER TABLE public.maintenance_requests ADD CONSTRAINT maintenance_requests_status_check
  CHECK (status IN ('pending_approval','accounts_approved','approved','rejected','completed','cancelled'));

-- ---------- who decides ----------
CREATE OR REPLACE FUNCTION public.is_requisition_accounts(p_uid uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT p_uid IS NOT NULL AND (
    public.has_role(p_uid, 'accountant')
    OR public.has_role(p_uid, 'super_admin')
    OR EXISTS (SELECT 1 FROM permission_overrides
                WHERE user_id = p_uid AND module = 'finance'::module_key
                  AND action = 'approve'::action_key AND granted)
  );
$$;
GRANT EXECUTE ON FUNCTION public.is_requisition_accounts(uuid) TO authenticated;

CREATE OR REPLACE FUNCTION public.is_requisition_chairman(p_uid uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT p_uid IS NOT NULL
     AND (public.has_role(p_uid, 'chairman') OR public.has_role(p_uid, 'super_admin'));
$$;
GRANT EXECUTE ON FUNCTION public.is_requisition_chairman(uuid) TO authenticated;

-- ---------- who reads ----------
-- Maintenance users as before, plus Accounts (their Accountant page lists
-- the requisitions).
DROP POLICY IF EXISTS "maintenance read requests" ON public.maintenance_requests;
CREATE POLICY "maintenance read requests" ON public.maintenance_requests FOR SELECT TO authenticated
  USING (public.has_permission(auth.uid(), 'logistics'::module_key, 'read'::action_key)
         OR public.is_requisition_accounts(auth.uid()));

DROP POLICY IF EXISTS "maintenance read request items" ON public.maintenance_request_items;
CREATE POLICY "maintenance read request items" ON public.maintenance_request_items FOR SELECT TO authenticated
  USING (public.has_permission(auth.uid(), 'logistics'::module_key, 'read'::action_key)
         OR public.is_requisition_accounts(auth.uid()));

-- Accounts see the vehicle plate on a requisition.
DROP POLICY IF EXISTS "requisition accounts read vehicles" ON public.vehicles;
CREATE POLICY "requisition accounts read vehicles" ON public.vehicles FOR SELECT TO authenticated
  USING (public.is_requisition_accounts(auth.uid()));

-- ---------- create (with items) ----------
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
  v_items jsonb := COALESCE(payload->'items', '[]'::jsonb);
  v_item jsonb;
  v_line int := 0;
  v_qty numeric;
  v_unit numeric;
  v_total numeric := 0;
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
  IF jsonb_typeof(v_items) <> 'array' THEN RAISE EXCEPTION 'items must be a list'; END IF;

  LOOP
    v_number := 'MNT-' || to_char(now(),'YYYYMMDD') || '-' || lpad(((floor(random()*99999))::int)::text, 5, '0');
    EXIT WHEN NOT EXISTS (SELECT 1 FROM maintenance_requests
                           WHERE factory_id = v_factory AND request_number = v_number);
  END LOOP;

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

  FOR v_item IN SELECT * FROM jsonb_array_elements(v_items) LOOP
    v_line := v_line + 1;
    IF NULLIF(btrim(v_item->>'item_name'),'') IS NULL THEN
      RAISE EXCEPTION 'Item % needs a name', v_line;
    END IF;
    v_qty := NULLIF(v_item->>'quantity','')::numeric;
    v_unit := NULLIF(v_item->>'unit_amount','')::numeric;
    IF v_qty IS NULL OR v_qty <= 0 THEN RAISE EXCEPTION 'Item % needs a quantity above 0', v_line; END IF;
    IF v_unit IS NULL OR v_unit < 0 THEN RAISE EXCEPTION 'Item % needs an amount', v_line; END IF;
    INSERT INTO maintenance_request_items(request_id, factory_id, line_no, item_name,
                                          description, quantity, unit_amount)
    VALUES (v_id, v_factory, v_line, btrim(v_item->>'item_name'),
            NULLIF(btrim(v_item->>'description'),''), v_qty, v_unit);
    v_total := v_total + round(v_qty * v_unit, 2);
  END LOOP;

  -- With items, the request's cost is their total.
  IF v_line > 0 THEN
    UPDATE maintenance_requests SET estimated_cost = v_total WHERE id = v_id;
  END IF;

  RETURN jsonb_build_object('id', v_id, 'request_number', v_number, 'total', v_total);
END;
$$;
GRANT EXECUTE ON FUNCTION public.create_maintenance_request(jsonb) TO authenticated;

-- ---------- approve / reject: Accounts, then the Chairman ----------
CREATE OR REPLACE FUNCTION public.decide_maintenance_request(p_id uuid, p_approve boolean, p_note text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_name text := (SELECT full_name FROM profiles WHERE id = v_uid);
  v_row maintenance_requests%ROWTYPE;
  v_note text := NULLIF(btrim(p_note),'');
  v_status text;
BEGIN
  IF NOT p_approve AND v_note IS NULL THEN
    RAISE EXCEPTION 'A reason is required to reject';
  END IF;

  SELECT * INTO v_row FROM maintenance_requests WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Request not found'; END IF;
  IF v_row.requested_by = v_uid AND NOT public.has_role(v_uid, 'super_admin') THEN
    RAISE EXCEPTION 'You cannot decide on your own request';
  END IF;

  IF v_row.status = 'pending_approval' THEN
    IF NOT public.is_requisition_accounts(v_uid) THEN
      RAISE EXCEPTION 'This request is waiting for Accounts';
    END IF;
    v_status := CASE WHEN p_approve THEN 'accounts_approved' ELSE 'rejected' END;
    UPDATE maintenance_requests SET
      status = v_status,
      accounts_by = v_uid, accounts_by_name = v_name, accounts_at = now(), accounts_note = v_note,
      decided_by = CASE WHEN p_approve THEN decided_by ELSE v_uid END,
      decided_by_name = CASE WHEN p_approve THEN decided_by_name ELSE v_name END,
      decided_at = CASE WHEN p_approve THEN decided_at ELSE now() END,
      decision_note = CASE WHEN p_approve THEN decision_note ELSE v_note END,
      updated_at = now()
    WHERE id = p_id;
  ELSIF v_row.status = 'accounts_approved' THEN
    IF NOT public.is_requisition_chairman(v_uid) THEN
      RAISE EXCEPTION 'Accounts have accepted it; it is waiting for the Chairman';
    END IF;
    v_status := CASE WHEN p_approve THEN 'approved' ELSE 'rejected' END;
    UPDATE maintenance_requests SET
      status = v_status,
      chairman_by = v_uid, chairman_by_name = v_name, chairman_at = now(), chairman_note = v_note,
      decided_by = v_uid, decided_by_name = v_name, decided_at = now(), decision_note = v_note,
      updated_at = now()
    WHERE id = p_id;
  ELSE
    RAISE EXCEPTION 'Request is already %', replace(v_row.status, '_', ' ');
  END IF;

  RETURN jsonb_build_object('id', p_id, 'status', v_status);
END;
$$;
GRANT EXECUTE ON FUNCTION public.decide_maintenance_request(uuid, boolean, text) TO authenticated;

-- ---------- cancel: also while waiting for the Chairman ----------
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
  IF v_row.status NOT IN ('pending_approval','accounts_approved','approved') THEN
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

-- Live updates for the items too.
DO $$
BEGIN
  IF NOT EXISTS (
       SELECT 1 FROM pg_publication_tables
        WHERE pubname = 'supabase_realtime' AND schemaname = 'public'
          AND tablename = 'maintenance_request_items') THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.maintenance_request_items;
  END IF;
END;
$$;

NOTIFY pgrst, 'reload schema';
