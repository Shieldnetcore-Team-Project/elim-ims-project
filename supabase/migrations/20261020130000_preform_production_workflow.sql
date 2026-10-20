-- ============================================================================
-- Preform production: store issue -> shift production -> QC -> good bottle
-- stocking -> transfer to PM, with reconciliation, exceptions and reports
-- ----------------------------------------------------------------------------
-- Factory rules (confirmed 2026-10-20):
--   * good blown bottles go into Warehouse stock as a semi-finished product
--     (e.g. "Empty Bottle (75cl)"), then the Warehouse transfers them to PM
--     (the filling / packing line), which confirms receipt;
--   * QC must approve good bottles before they can be stocked;
--   * the Warehouse confirms the physical count -- stock rises only when it
--     accepts a stocking;
--   * shifts are Day and Night (as production.shift).
--
-- Reused: raw_materials (store stock of preforms, in pieces, moving-average
-- value) + raw_material_movements; products (the empty-bottle product,
-- product_type 'semi_finished') + inventory_movements; audit_logs; the
-- permission system (new module 'preform-production'); realtime.
--
-- New:
--   raw_materials.pieces_per_bag, raw_materials.output_product_id
--   preform_holdings          what each operator holds, per preform (pieces)
--   preform_movements         the operator-holding ledger -- the only way a
--                             holding changes; dated by effective_date (the
--                             issue date / production date) for daily reports
--   preform_issues            store -> operator; the operator accepts it
--   preform_shift_records     one per operator / preform / date / shift
--   preform_qc_inspections    QC's verdict on a submitted shift record
--   preform_stockings         good bottles sent to and accepted by the Warehouse
--   bottle_transfers          Warehouse -> department (PM), received there
--   department_stock (+ _movements)   what a department (PM) has received
--   preform_exceptions        every unexplained difference, until resolved
--
-- Quantities are stored in pieces. Bags are for entry and display only:
-- pieces = bags x pieces_per_bag + loose pieces, and each issue keeps the
-- pieces_per_bag it was issued with, so changing the factor later never
-- changes history.
--
-- ---------------------------------------------------------------- calculations
--   available        = opening holding + accepted issues not yet used by a shift
--   usage            = good bottles + damaged preforms + damaged bottles
--                      + other losses               (each counted once)
--   expected remaining = available - usage           (submission is refused
--                                                     if this would be < 0)
--   QC                 classifies every good bottle the operator reported:
--                      qc_good + qc_rejected = good_bottles. qc_rejected are
--                      QC-rejected bottles (already inside usage -- never
--                      subtracted twice).
--   expected to stock  = qc_good
--   remaining to stock = qc_good - accepted - pending sent - exception qty
--   variance           = qc_good - accepted; never forced to zero -- a
--                        difference becomes a preform_exceptions row that a
--                        manager resolves (written off) with a note.
--
-- ------------------------------------------------------------------ statuses
--   issue      issued -> accepted | rejected | cancelled ; accepted -> reversed
--   shift      draft -> awaiting_inspection -> awaiting_stocking -> completed
--              awaiting_inspection -> draft (QC returned it; usage undone)
--              awaiting_inspection | awaiting_stocking -> reversed (manager)
--   stocking   sent -> accepted | rejected | cancelled ; accepted -> reversed
--   transfer   dispatched -> received | discrepancy | cancelled ;
--              received | discrepancy -> reversed
--   exception  open -> resolved
--
-- ------------------------------------------------------------- permissions
-- Module 'preform-production':
--   view            dashboards, records, reports
--   create / edit   operator: shift record drafts
--   submit          operator: accept/reject issues, submit shifts, send good
--                   bottles for stocking, report a shortfall; PM: receive
--   post            Store/Warehouse: issue preforms, dispatch transfers
--   cancel          withdraw an issue / transfer before it is received
--   approve/reject  QC: approve or return a shift record
--   confirm/reject  Warehouse: accept or refuse a stocking
--   reverse         managers: setup, reversals, resolving exceptions
--   print / export  reports
-- The maker of a step may not also be its checker (QC vs operator, Warehouse
-- vs sender, PM receiver vs dispatcher, exception resolver vs raiser) unless
-- super_admin / chairman.
-- ============================================================================

-- ============ 1. Module key ============
ALTER DOMAIN public.module_key DROP CONSTRAINT IF EXISTS module_key_check;
ALTER DOMAIN public.module_key ADD CONSTRAINT module_key_check CHECK (VALUE IN (
  'dashboard','sales','production','production-requests','purchase-orders','raw-materials','finished-goods',
  'finance','inventory','expenses','payroll','payments','receipts-payments','cash-flow','debts',
  'customers','suppliers','employees','reports','users','account-approvals','audit-logs',
  'settings','costing','logistics','approvals','goods-receiving','distribution','sales-returns',
  'delete-requests','deleted-sales','permissions','auth-users',
  'marketer-accounts','distributor-accounts','preform-production'
));

CREATE OR REPLACE FUNCTION public.get_my_permissions()
 RETURNS TABLE(module module_key, action action_key)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  v_module public.module_key;
  v_action public.action_key;
  v_modules public.module_key[] := ARRAY[
    'dashboard','sales','production','production-requests','purchase-orders','raw-materials','finished-goods',
    'finance','expenses','payroll','payments','receipts-payments','cash-flow','debts',
    'customers','suppliers','employees','reports','users','account-approvals','audit-logs',
    'settings','costing','logistics','approvals','goods-receiving','distribution','sales-returns',
    'delete-requests','deleted-sales','permissions','auth-users',
    'marketer-accounts','distributor-accounts','preform-production'
  ]::public.module_key[];
  v_concrete_actions public.action_key[] := ARRAY[
    'view','create','edit','submit','approve','reject','confirm','post','reverse','cancel','export','print','delete'
  ]::public.action_key[];
BEGIN
  IF v_uid IS NULL THEN RETURN; END IF;
  IF public.has_role(v_uid, 'super_admin') OR public.has_role(v_uid, 'chairman') THEN
    FOREACH v_module IN ARRAY v_modules LOOP
      FOREACH v_action IN ARRAY v_concrete_actions LOOP
        module := v_module; action := v_action; RETURN NEXT;
      END LOOP;
    END LOOP;
    RETURN;
  END IF;
  FOREACH v_module IN ARRAY v_modules LOOP
    FOREACH v_action IN ARRAY v_concrete_actions LOOP
      IF public.has_permission(v_uid, v_module, v_action) THEN
        module := v_module; action := v_action; RETURN NEXT;
      END IF;
    END LOOP;
  END LOOP;
  RETURN;
END;
$function$;

-- ============ 2. Role defaults (adjustable in the Permission Matrix) ============
INSERT INTO public.role_permissions (role, module, action)
SELECT r.slug, 'preform-production'::module_key, g.action::action_key
FROM public.roles r
CROSS JOIN (VALUES ('view'), ('create'), ('edit'), ('submit'), ('print'), ('export')) AS g(action)
WHERE r.slug = 'production' OR r.slug ILIKE '%production%manager%' OR r.label ILIKE '%production%manager%'
ON CONFLICT (role, module, action) DO NOTHING;

-- Production managers also handle setup, reversals and exceptions.
INSERT INTO public.role_permissions (role, module, action)
SELECT r.slug, 'preform-production'::module_key, 'reverse'::action_key
FROM public.roles r
WHERE r.slug ILIKE '%production%manager%' OR r.label ILIKE '%production%manager%'
ON CONFLICT (role, module, action) DO NOTHING;

-- Store / Warehouse: issue preforms, accept good bottles, dispatch to PM.
INSERT INTO public.role_permissions (role, module, action)
SELECT r.slug, 'preform-production'::module_key, g.action::action_key
FROM public.roles r
CROSS JOIN (VALUES ('view'), ('post'), ('confirm'), ('reject'), ('cancel'), ('print'), ('export')) AS g(action)
WHERE r.slug IN ('store_officer', 'store_keeper', 'inventory_officer')
ON CONFLICT (role, module, action) DO NOTHING;

-- QC: approve or return shift records.
INSERT INTO public.role_permissions (role, module, action)
SELECT r.slug, 'preform-production'::module_key, g.action::action_key
FROM public.roles r
CROSS JOIN (VALUES ('view'), ('approve'), ('reject'), ('print')) AS g(action)
WHERE r.slug = 'qc_officer'
ON CONFLICT (role, module, action) DO NOTHING;

-- Read-only: auditor and accountant.
INSERT INTO public.role_permissions (role, module, action)
SELECT r.slug, 'preform-production'::module_key, g.action::action_key
FROM public.roles r
CROSS JOIN (VALUES ('view'), ('print'), ('export')) AS g(action)
WHERE r.slug IN ('auditor', 'accountant')
ON CONFLICT (role, module, action) DO NOTHING;

-- ============ 3. Helpers ============
CREATE OR REPLACE FUNCTION public._pf_can(p_action text)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT public.has_permission(auth.uid(), 'preform-production'::module_key, p_action::action_key);
$$;
REVOKE ALL ON FUNCTION public._pf_can(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public._pf_can(text) TO authenticated;

CREATE OR REPLACE FUNCTION public._pf_is_admin()
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT public.has_role(auth.uid(), 'super_admin') OR public.has_role(auth.uid(), 'chairman');
$$;
REVOKE ALL ON FUNCTION public._pf_is_admin() FROM PUBLIC, anon, authenticated;

CREATE SEQUENCE IF NOT EXISTS public.preform_ref_seq;
CREATE OR REPLACE FUNCTION public._pf_ref(p_prefix text)
RETURNS text LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = public AS $$
  SELECT p_prefix || '-' || to_char(now() AT TIME ZONE 'Africa/Lagos', 'YYYYMMDD') || '-'
         || lpad(nextval('public.preform_ref_seq')::text, 5, '0');
$$;
REVOKE ALL ON FUNCTION public._pf_ref(text) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public._pf_today()
RETURNS date LANGUAGE sql STABLE AS $$ SELECT (now() AT TIME ZONE 'Africa/Lagos')::date; $$;

CREATE OR REPLACE FUNCTION public._pf_audit(p_factory uuid, p_action text, p_entity text, p_id uuid, p_old jsonb, p_new jsonb)
RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  INSERT INTO audit_logs(user_id, factory_id, action, entity, entity_id, old_value, new_value)
  VALUES (auth.uid(), p_factory, p_action, p_entity, p_id::text, p_old, p_new);
$$;
REVOKE ALL ON FUNCTION public._pf_audit(uuid, text, text, uuid, jsonb, jsonb) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public._pf_name(p_user uuid)
RETURNS text LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT COALESCE(NULLIF(full_name, ''), email, 'Unknown') FROM profiles WHERE id = p_user;
$$;
REVOKE ALL ON FUNCTION public._pf_name(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public._pf_name(uuid) TO authenticated;

-- ============ 4. Material setup ============
ALTER TABLE public.raw_materials
  ADD COLUMN IF NOT EXISTS pieces_per_bag numeric CHECK (pieces_per_bag IS NULL OR pieces_per_bag > 0),
  ADD COLUMN IF NOT EXISTS output_product_id uuid REFERENCES public.products(id);

-- An empty-bottle product for each standard preform size, linked to it.
DO $$
DECLARE
  r record;
  v_product uuid;
  v_name text;
BEGIN
  FOR r IN
    SELECT m.id, m.factory_id, substring(m.name FROM '\(([^)]+)\)') AS size
      FROM raw_materials m
     WHERE m.name ILIKE 'PET Preform (%)' AND m.output_product_id IS NULL
  LOOP
    v_name := 'Empty Bottle (' || r.size || ')';
    SELECT id INTO v_product FROM products WHERE factory_id = r.factory_id AND lower(name) = lower(v_name);
    IF v_product IS NULL THEN
      INSERT INTO products(factory_id, name, unit, unit_price, cost_price, current_stock, product_type, active)
      VALUES (r.factory_id, v_name, 'Piece', 0, 0, 0, 'semi_finished', true)
      RETURNING id INTO v_product;
    END IF;
    UPDATE raw_materials SET output_product_id = v_product WHERE id = r.id;
  END LOOP;
END $$;

-- Managers set pieces per bag and the bottle a preform blows into. Old
-- issues keep the factor they were issued with.
CREATE OR REPLACE FUNCTION public.preform_setup_material(
  p_material uuid, p_pieces_per_bag numeric, p_output_product uuid, p_reason text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_m raw_materials%ROWTYPE;
  v_p products%ROWTYPE;
BEGIN
  IF NOT (public._pf_can('reverse') OR public.has_permission(auth.uid(), 'settings'::module_key, 'edit'::action_key)) THEN
    RAISE EXCEPTION 'Insufficient permissions';
  END IF;
  SELECT * INTO v_m FROM raw_materials WHERE id = p_material FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Preform material not found'; END IF;
  IF p_pieces_per_bag IS NULL OR p_pieces_per_bag <= 0 OR p_pieces_per_bag <> trunc(p_pieces_per_bag) THEN
    RAISE EXCEPTION 'Pieces per bag must be a whole number above 0';
  END IF;
  IF p_output_product IS NOT NULL THEN
    SELECT * INTO v_p FROM products WHERE id = p_output_product;
    IF NOT FOUND OR v_p.factory_id <> v_m.factory_id THEN RAISE EXCEPTION 'Bottle product not found in this factory'; END IF;
  END IF;
  IF v_m.pieces_per_bag IS NOT NULL AND v_m.pieces_per_bag <> p_pieces_per_bag
     AND NULLIF(btrim(COALESCE(p_reason, '')), '') IS NULL THEN
    RAISE EXCEPTION 'Give a reason for changing pieces per bag';
  END IF;

  UPDATE raw_materials SET pieces_per_bag = p_pieces_per_bag, output_product_id = p_output_product, updated_at = now()
   WHERE id = p_material;
  PERFORM public._pf_audit(v_m.factory_id, 'preform_setup_material', 'raw_materials', p_material,
    jsonb_build_object('pieces_per_bag', v_m.pieces_per_bag, 'output_product_id', v_m.output_product_id),
    jsonb_build_object('pieces_per_bag', p_pieces_per_bag, 'output_product_id', p_output_product, 'reason', p_reason));
  RETURN jsonb_build_object('material_id', p_material, 'pieces_per_bag', p_pieces_per_bag);
END;
$$;
REVOKE ALL ON FUNCTION public.preform_setup_material(uuid, numeric, uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.preform_setup_material(uuid, numeric, uuid, text) TO authenticated;

-- ============ 5. Tables ============
CREATE TABLE IF NOT EXISTS public.preform_holdings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  factory_id uuid NOT NULL REFERENCES public.factories(id) ON DELETE CASCADE,
  operator_id uuid NOT NULL REFERENCES auth.users(id),
  material_id uuid NOT NULL REFERENCES public.raw_materials(id),
  quantity numeric NOT NULL DEFAULT 0 CHECK (quantity >= 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (operator_id, material_id)
);

CREATE TABLE IF NOT EXISTS public.preform_shift_records (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  factory_id uuid NOT NULL REFERENCES public.factories(id) ON DELETE CASCADE,
  reference text NOT NULL UNIQUE,
  operator_id uuid NOT NULL REFERENCES auth.users(id),
  material_id uuid NOT NULL REFERENCES public.raw_materials(id),
  output_product_id uuid REFERENCES public.products(id),
  production_date date NOT NULL,
  shift text NOT NULL CHECK (shift IN ('day', 'night')),
  machine text,
  status text NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft', 'awaiting_inspection', 'awaiting_stocking', 'completed', 'reversed')),
  good_bottles numeric NOT NULL DEFAULT 0 CHECK (good_bottles >= 0),
  damaged_preforms numeric NOT NULL DEFAULT 0 CHECK (damaged_preforms >= 0),
  damaged_bottles numeric NOT NULL DEFAULT 0 CHECK (damaged_bottles >= 0),
  other_losses numeric NOT NULL DEFAULT 0 CHECK (other_losses >= 0),
  other_loss_reason text,
  notes text,
  -- Snapshot at submission
  opening_qty numeric,
  issued_qty numeric,
  available_qty numeric,
  usage_qty numeric,
  expected_remaining numeric,
  -- From the approving QC inspection
  qc_good numeric,
  qc_rejected numeric,
  created_by uuid REFERENCES auth.users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  submitted_by uuid REFERENCES auth.users(id),
  submitted_at timestamptz,
  completed_at timestamptz,
  reversed_by uuid REFERENCES auth.users(id),
  reversed_at timestamptz,
  reversal_reason text
);
CREATE UNIQUE INDEX IF NOT EXISTS preform_shift_one_per_shift
  ON public.preform_shift_records (operator_id, material_id, production_date, shift) WHERE status <> 'reversed';
CREATE INDEX IF NOT EXISTS idx_preform_shift_factory_date ON public.preform_shift_records (factory_id, production_date DESC);
CREATE INDEX IF NOT EXISTS idx_preform_shift_status ON public.preform_shift_records (factory_id, status);

CREATE TABLE IF NOT EXISTS public.preform_issues (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  factory_id uuid NOT NULL REFERENCES public.factories(id) ON DELETE CASCADE,
  reference text NOT NULL UNIQUE,
  client_ref uuid UNIQUE,
  material_id uuid NOT NULL REFERENCES public.raw_materials(id),
  operator_id uuid NOT NULL REFERENCES auth.users(id),
  source text NOT NULL DEFAULT 'Store',
  destination text NOT NULL DEFAULT 'Preform Blowing',
  bags numeric NOT NULL DEFAULT 0 CHECK (bags >= 0),
  pieces_per_bag numeric NOT NULL CHECK (pieces_per_bag > 0),
  loose_pieces numeric NOT NULL DEFAULT 0 CHECK (loose_pieces >= 0),
  pieces numeric NOT NULL CHECK (pieces > 0),
  unit_cost numeric NOT NULL DEFAULT 0,
  issue_date date NOT NULL,
  notes text,
  status text NOT NULL DEFAULT 'issued' CHECK (status IN ('issued', 'accepted', 'rejected', 'cancelled', 'reversed')),
  issued_by uuid REFERENCES auth.users(id),
  issued_at timestamptz NOT NULL DEFAULT now(),
  responded_by uuid REFERENCES auth.users(id),
  responded_at timestamptz,
  response_note text,
  shift_record_id uuid REFERENCES public.preform_shift_records(id),
  reversed_by uuid REFERENCES auth.users(id),
  reversed_at timestamptz,
  reversal_reason text
);
CREATE INDEX IF NOT EXISTS idx_preform_issues_operator ON public.preform_issues (operator_id, material_id, status);
CREATE INDEX IF NOT EXISTS idx_preform_issues_factory_date ON public.preform_issues (factory_id, issue_date DESC);

CREATE TABLE IF NOT EXISTS public.preform_movements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  factory_id uuid NOT NULL REFERENCES public.factories(id) ON DELETE CASCADE,
  operator_id uuid NOT NULL REFERENCES auth.users(id),
  material_id uuid NOT NULL REFERENCES public.raw_materials(id),
  movement_type text NOT NULL CHECK (movement_type IN (
    'issue_in', 'issue_reversed', 'good_bottles', 'damaged_preforms', 'damaged_bottles', 'other_losses',
    'usage_reversed')),
  quantity numeric NOT NULL,          -- signed: + into the holding, - out of it
  quantity_before numeric NOT NULL,
  quantity_after numeric NOT NULL,
  effective_date date NOT NULL,
  reference text,
  issue_id uuid REFERENCES public.preform_issues(id),
  shift_record_id uuid REFERENCES public.preform_shift_records(id),
  reason text,
  user_id uuid REFERENCES auth.users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_preform_movements_holding ON public.preform_movements (operator_id, material_id, effective_date);
CREATE INDEX IF NOT EXISTS idx_preform_movements_factory ON public.preform_movements (factory_id, effective_date);

CREATE TABLE IF NOT EXISTS public.preform_qc_inspections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  factory_id uuid NOT NULL REFERENCES public.factories(id) ON DELETE CASCADE,
  shift_record_id uuid NOT NULL REFERENCES public.preform_shift_records(id),
  decision text NOT NULL CHECK (decision IN ('approved', 'returned')),
  inspected_qty numeric NOT NULL CHECK (inspected_qty >= 0),
  good_qty numeric NOT NULL CHECK (good_qty >= 0),
  rejected_qty numeric NOT NULL CHECK (rejected_qty >= 0),
  reason text,
  disposition text,
  notes text,
  inspector_id uuid REFERENCES auth.users(id),
  inspected_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_preform_qc_record ON public.preform_qc_inspections (shift_record_id);

CREATE TABLE IF NOT EXISTS public.preform_stockings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  factory_id uuid NOT NULL REFERENCES public.factories(id) ON DELETE CASCADE,
  reference text NOT NULL UNIQUE,
  shift_record_id uuid NOT NULL REFERENCES public.preform_shift_records(id),
  product_id uuid NOT NULL REFERENCES public.products(id),
  destination text NOT NULL DEFAULT 'Warehouse',
  expected_qty numeric NOT NULL,      -- remaining to stock when sent
  counted_qty numeric NOT NULL CHECK (counted_qty > 0),
  received_qty numeric CHECK (received_qty IS NULL OR received_qty >= 0),
  accepted_qty numeric CHECK (accepted_qty IS NULL OR accepted_qty >= 0),
  status text NOT NULL DEFAULT 'sent' CHECK (status IN ('sent', 'accepted', 'rejected', 'cancelled', 'reversed')),
  sent_by uuid REFERENCES auth.users(id),
  sent_at timestamptz NOT NULL DEFAULT now(),
  send_note text,
  received_by uuid REFERENCES auth.users(id),
  received_at timestamptz,
  receive_note text,
  reversed_by uuid REFERENCES auth.users(id),
  reversed_at timestamptz,
  reversal_reason text
);
CREATE INDEX IF NOT EXISTS idx_preform_stockings_record ON public.preform_stockings (shift_record_id);
CREATE INDEX IF NOT EXISTS idx_preform_stockings_factory ON public.preform_stockings (factory_id, status, sent_at DESC);

CREATE TABLE IF NOT EXISTS public.bottle_transfers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  factory_id uuid NOT NULL REFERENCES public.factories(id) ON DELETE CASCADE,
  reference text NOT NULL UNIQUE,
  client_ref uuid UNIQUE,
  product_id uuid NOT NULL REFERENCES public.products(id),
  from_location text NOT NULL DEFAULT 'Warehouse',
  to_department text NOT NULL,
  quantity_sent numeric NOT NULL CHECK (quantity_sent > 0),
  quantity_received numeric CHECK (quantity_received IS NULL OR quantity_received >= 0),
  status text NOT NULL DEFAULT 'dispatched'
    CHECK (status IN ('dispatched', 'received', 'discrepancy', 'cancelled', 'reversed')),
  notes text,
  sent_by uuid REFERENCES auth.users(id),
  sent_at timestamptz NOT NULL DEFAULT now(),
  received_by uuid REFERENCES auth.users(id),
  received_at timestamptz,
  receive_note text,
  reversed_by uuid REFERENCES auth.users(id),
  reversed_at timestamptz,
  reversal_reason text
);
CREATE INDEX IF NOT EXISTS idx_bottle_transfers_factory ON public.bottle_transfers (factory_id, status, sent_at DESC);

CREATE TABLE IF NOT EXISTS public.department_stock (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  factory_id uuid NOT NULL REFERENCES public.factories(id) ON DELETE CASCADE,
  department text NOT NULL,
  product_id uuid NOT NULL REFERENCES public.products(id),
  quantity numeric NOT NULL DEFAULT 0 CHECK (quantity >= 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (factory_id, department, product_id)
);

CREATE TABLE IF NOT EXISTS public.department_stock_movements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  factory_id uuid NOT NULL REFERENCES public.factories(id) ON DELETE CASCADE,
  department text NOT NULL,
  product_id uuid NOT NULL REFERENCES public.products(id),
  movement_type text NOT NULL CHECK (movement_type IN ('transfer_in', 'transfer_reversed')),
  quantity numeric NOT NULL,
  quantity_before numeric NOT NULL,
  quantity_after numeric NOT NULL,
  reference text,
  transfer_id uuid REFERENCES public.bottle_transfers(id),
  user_id uuid REFERENCES auth.users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.preform_exceptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  factory_id uuid NOT NULL REFERENCES public.factories(id) ON DELETE CASCADE,
  reference text NOT NULL UNIQUE,
  kind text NOT NULL CHECK (kind IN ('stock_shortfall', 'count_mismatch', 'transfer_shortfall')),
  shift_record_id uuid REFERENCES public.preform_shift_records(id),
  stocking_id uuid REFERENCES public.preform_stockings(id),
  transfer_id uuid REFERENCES public.bottle_transfers(id),
  product_id uuid REFERENCES public.products(id),
  expected_qty numeric NOT NULL,
  actual_qty numeric NOT NULL,
  difference_qty numeric NOT NULL CHECK (difference_qty > 0),
  note text,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved', 'voided')),
  resolution text CHECK (resolution IS NULL OR resolution IN ('written_off', 'returned_to_stock')),
  resolution_note text,
  raised_by uuid REFERENCES auth.users(id),
  raised_at timestamptz NOT NULL DEFAULT now(),
  resolved_by uuid REFERENCES auth.users(id),
  resolved_at timestamptz
);
CREATE INDEX IF NOT EXISTS idx_preform_exceptions_factory ON public.preform_exceptions (factory_id, status);
CREATE INDEX IF NOT EXISTS idx_preform_exceptions_record ON public.preform_exceptions (shift_record_id);

-- Read access; every write goes through the functions below.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['preform_holdings','preform_movements','preform_issues','preform_shift_records',
                           'preform_qc_inspections','preform_stockings','bottle_transfers','department_stock',
                           'department_stock_movements','preform_exceptions'] LOOP
    EXECUTE format('GRANT SELECT ON public.%I TO authenticated', t);
    EXECUTE format('GRANT ALL ON public.%I TO service_role', t);
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS "preform read" ON public.%I', t);
    EXECUTE format('CREATE POLICY "preform read" ON public.%I FOR SELECT TO authenticated USING (public._pf_can(''view''))', t);
    IF NOT EXISTS (SELECT 1 FROM pg_publication_tables WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = t) THEN
      EXECUTE format('ALTER PUBLICATION supabase_realtime ADD TABLE public.%I', t);
    END IF;
  END LOOP;
END $$;

-- ============ 6. Holding ledger ============
-- The only writer of preform_holdings. Locks the holding row, refuses to go
-- below zero, and writes the movement with before/after.
CREATE OR REPLACE FUNCTION public._pf_move(
  p_factory uuid, p_operator uuid, p_material uuid, p_type text, p_qty numeric, p_date date,
  p_reference text, p_issue uuid, p_record uuid, p_reason text
) RETURNS numeric
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_before numeric;
  v_after numeric;
BEGIN
  IF p_qty = 0 THEN RETURN NULL; END IF;
  INSERT INTO preform_holdings(factory_id, operator_id, material_id, quantity)
  VALUES (p_factory, p_operator, p_material, 0)
  ON CONFLICT (operator_id, material_id) DO NOTHING;
  SELECT quantity INTO v_before FROM preform_holdings
   WHERE operator_id = p_operator AND material_id = p_material FOR UPDATE;
  v_after := v_before + p_qty;
  IF v_after < 0 THEN
    RAISE EXCEPTION 'Not enough preforms held: the operator has % pieces, this needs %', v_before, -p_qty;
  END IF;
  UPDATE preform_holdings SET quantity = v_after, updated_at = now()
   WHERE operator_id = p_operator AND material_id = p_material;
  INSERT INTO preform_movements(factory_id, operator_id, material_id, movement_type, quantity, quantity_before,
                                quantity_after, effective_date, reference, issue_id, shift_record_id, reason, user_id)
  VALUES (p_factory, p_operator, p_material, p_type, p_qty, v_before, v_after, p_date, p_reference, p_issue,
          p_record, p_reason, auth.uid());
  RETURN v_after;
END;
$$;
REVOKE ALL ON FUNCTION public._pf_move(uuid, uuid, uuid, text, numeric, date, text, uuid, uuid, text) FROM PUBLIC, anon, authenticated;

-- Store stock out / back (moving-average value, as every raw-material issue).
CREATE OR REPLACE FUNCTION public._pf_store_out(p_material uuid, p_qty numeric, p_reference text, p_reason text)
RETURNS numeric LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_m raw_materials%ROWTYPE;
  v_cost numeric;
BEGIN
  SELECT * INTO v_m FROM raw_materials WHERE id = p_material FOR UPDATE;
  IF v_m.current_stock < p_qty THEN
    RAISE EXCEPTION 'Not enough % in the store: % pieces available, % needed', v_m.name, v_m.current_stock, p_qty;
  END IF;
  v_cost := public.avg_unit_cost(v_m.current_value, v_m.current_stock, v_m.unit_cost);
  UPDATE raw_materials SET current_stock = current_stock - p_qty,
         current_value = GREATEST(current_value - p_qty * v_cost, 0), updated_at = now()
   WHERE id = p_material;
  INSERT INTO raw_material_movements(factory_id, material_id, movement_type, quantity, unit_cost, reference, reason,
                                     user_id, quantity_before, quantity_after)
  VALUES (v_m.factory_id, p_material, 'transferred', p_qty, v_cost, p_reference, p_reason, auth.uid(),
          v_m.current_stock, v_m.current_stock - p_qty);
  RETURN v_cost;
END;
$$;
REVOKE ALL ON FUNCTION public._pf_store_out(uuid, numeric, text, text) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public._pf_store_back(p_material uuid, p_qty numeric, p_cost numeric, p_reference text, p_reason text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_m raw_materials%ROWTYPE;
BEGIN
  SELECT * INTO v_m FROM raw_materials WHERE id = p_material FOR UPDATE;
  UPDATE raw_materials SET current_stock = current_stock + p_qty,
         current_value = current_value + p_qty * p_cost, updated_at = now()
   WHERE id = p_material;
  INSERT INTO raw_material_movements(factory_id, material_id, movement_type, quantity, unit_cost, reference, reason,
                                     user_id, quantity_before, quantity_after)
  VALUES (v_m.factory_id, p_material, 'return_from_production', p_qty, p_cost, p_reference, p_reason, auth.uid(),
          v_m.current_stock, v_m.current_stock + p_qty);
END;
$$;
REVOKE ALL ON FUNCTION public._pf_store_back(uuid, numeric, numeric, text, text) FROM PUBLIC, anon, authenticated;

-- Warehouse (product) stock in / out.
CREATE OR REPLACE FUNCTION public._pf_product_move(
  p_product uuid, p_qty numeric, p_type movement_type, p_reference text, p_reason text
) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_p products%ROWTYPE;
BEGIN
  SELECT * INTO v_p FROM products WHERE id = p_product FOR UPDATE;
  IF v_p.current_stock + p_qty < 0 THEN
    RAISE EXCEPTION 'Not enough % in the Warehouse: % in stock, % needed', v_p.name, v_p.current_stock, -p_qty;
  END IF;
  UPDATE products SET current_stock = current_stock + p_qty, updated_at = now() WHERE id = p_product;
  INSERT INTO inventory_movements(factory_id, product_id, movement_type, quantity, reference, reason, user_id,
                                  quantity_before, quantity_after)
  VALUES (v_p.factory_id, p_product, p_type, abs(p_qty), p_reference, p_reason, auth.uid(),
          v_p.current_stock, v_p.current_stock + p_qty);
END;
$$;
REVOKE ALL ON FUNCTION public._pf_product_move(uuid, numeric, movement_type, text, text) FROM PUBLIC, anon, authenticated;

-- Department (PM) stock in / out.
CREATE OR REPLACE FUNCTION public._pf_dept_move(
  p_factory uuid, p_department text, p_product uuid, p_qty numeric, p_type text, p_reference text, p_transfer uuid
) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_before numeric;
BEGIN
  INSERT INTO department_stock(factory_id, department, product_id, quantity)
  VALUES (p_factory, p_department, p_product, 0)
  ON CONFLICT (factory_id, department, product_id) DO NOTHING;
  SELECT quantity INTO v_before FROM department_stock
   WHERE factory_id = p_factory AND department = p_department AND product_id = p_product FOR UPDATE;
  IF v_before + p_qty < 0 THEN
    RAISE EXCEPTION '% no longer holds enough of this product (% held, % needed)', p_department, v_before, -p_qty;
  END IF;
  UPDATE department_stock SET quantity = v_before + p_qty, updated_at = now()
   WHERE factory_id = p_factory AND department = p_department AND product_id = p_product;
  INSERT INTO department_stock_movements(factory_id, department, product_id, movement_type, quantity, quantity_before,
                                         quantity_after, reference, transfer_id, user_id)
  VALUES (p_factory, p_department, p_product, p_type, p_qty, v_before, v_before + p_qty, p_reference, p_transfer, auth.uid());
END;
$$;
REVOKE ALL ON FUNCTION public._pf_dept_move(uuid, text, uuid, numeric, text, text, uuid) FROM PUBLIC, anon, authenticated;

-- ============ 7. Operators ============
-- Users who can work the blowing line (preform-production submit) in a factory.
CREATE OR REPLACE FUNCTION public.preform_operators(p_factory uuid)
RETURNS TABLE(id uuid, full_name text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NOT public._pf_can('view') THEN RAISE EXCEPTION 'Insufficient permissions'; END IF;
  RETURN QUERY
  SELECT p.id, COALESCE(NULLIF(p.full_name, ''), p.email)::text
    FROM profiles p
   WHERE EXISTS (SELECT 1 FROM user_roles ur WHERE ur.user_id = p.id AND (ur.factory_id IS NULL OR ur.factory_id = p_factory))
     AND public.has_permission(p.id, 'preform-production'::module_key, 'submit'::action_key)
     AND NOT public.has_role(p.id, 'super_admin') AND NOT public.has_role(p.id, 'chairman')
   ORDER BY 2;
END;
$$;
REVOKE ALL ON FUNCTION public.preform_operators(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.preform_operators(uuid) TO authenticated;

-- ============ 8. Store issue ============
CREATE OR REPLACE FUNCTION public.issue_preforms(payload jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_client uuid := NULLIF(payload->>'client_ref', '')::uuid;
  v_material uuid := (payload->>'material_id')::uuid;
  v_operator uuid := (payload->>'operator_id')::uuid;
  v_bags numeric := COALESCE(NULLIF(payload->>'bags', '')::numeric, 0);
  v_loose numeric := COALESCE(NULLIF(payload->>'loose_pieces', '')::numeric, 0);
  v_date date := COALESCE(NULLIF(payload->>'issue_date', '')::date, public._pf_today());
  v_notes text := NULLIF(btrim(COALESCE(payload->>'notes', '')), '');
  v_m raw_materials%ROWTYPE;
  v_pieces numeric;
  v_ref text;
  v_cost numeric;
  v_id uuid;
  v_existing preform_issues%ROWTYPE;
BEGIN
  IF NOT public._pf_can('post') THEN RAISE EXCEPTION 'Insufficient permissions'; END IF;
  IF v_client IS NOT NULL THEN
    SELECT * INTO v_existing FROM preform_issues WHERE client_ref = v_client;
    IF FOUND THEN RETURN jsonb_build_object('id', v_existing.id, 'reference', v_existing.reference, 'duplicate', true); END IF;
  END IF;

  SELECT * INTO v_m FROM raw_materials WHERE id = v_material;
  IF NOT FOUND THEN RAISE EXCEPTION 'Preform material not found'; END IF;
  IF v_m.pieces_per_bag IS NULL THEN
    RAISE EXCEPTION 'Set pieces per bag for % first (Preform Production → Setup)', v_m.name;
  END IF;
  IF v_bags < 0 OR v_loose < 0 OR v_bags <> trunc(v_bags) OR v_loose <> trunc(v_loose) THEN
    RAISE EXCEPTION 'Bags and loose pieces must be whole numbers';
  END IF;
  v_pieces := v_bags * v_m.pieces_per_bag + v_loose;
  IF v_pieces <= 0 THEN RAISE EXCEPTION 'Enter the number of bags or pieces to issue'; END IF;
  IF v_date > public._pf_today() THEN RAISE EXCEPTION 'The issue date cannot be in the future'; END IF;
  IF NOT public.has_permission(v_operator, 'preform-production'::module_key, 'submit'::action_key) THEN
    RAISE EXCEPTION 'The receiving operator is not set up to work the blowing line';
  END IF;

  v_ref := public._pf_ref('PFI');
  v_cost := public._pf_store_out(v_material, v_pieces, v_ref,
              'Issued to Preform Blowing — ' || COALESCE(public._pf_name(v_operator), 'operator'));

  INSERT INTO preform_issues(factory_id, reference, client_ref, material_id, operator_id, bags, pieces_per_bag,
                             loose_pieces, pieces, unit_cost, issue_date, notes, issued_by)
  VALUES (v_m.factory_id, v_ref, v_client, v_material, v_operator, v_bags, v_m.pieces_per_bag, v_loose, v_pieces,
          v_cost, v_date, v_notes, auth.uid())
  RETURNING id INTO v_id;

  PERFORM public._pf_audit(v_m.factory_id, 'issue_preforms', 'preform_issues', v_id, NULL,
    jsonb_build_object('reference', v_ref, 'operator', v_operator, 'bags', v_bags, 'pieces', v_pieces));
  RETURN jsonb_build_object('id', v_id, 'reference', v_ref, 'pieces', v_pieces);
END;
$$;
REVOKE ALL ON FUNCTION public.issue_preforms(jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.issue_preforms(jsonb) TO authenticated;

-- The operator accepts (preforms enter their holding) or rejects (they go
-- back to the store) an issue addressed to them.
CREATE OR REPLACE FUNCTION public.respond_preform_issue(p_id uuid, p_accept boolean, p_note text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_i preform_issues%ROWTYPE;
BEGIN
  IF NOT public._pf_can('submit') THEN RAISE EXCEPTION 'Insufficient permissions'; END IF;
  SELECT * INTO v_i FROM preform_issues WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Issue not found'; END IF;
  IF v_i.status <> 'issued' THEN RAISE EXCEPTION 'This issue has already been %', v_i.status; END IF;
  IF v_i.operator_id <> auth.uid() AND NOT (public._pf_can('reverse') OR public._pf_is_admin()) THEN
    RAISE EXCEPTION 'Only the receiving operator can accept or reject this issue';
  END IF;
  IF NOT p_accept AND NULLIF(btrim(COALESCE(p_note, '')), '') IS NULL THEN
    RAISE EXCEPTION 'Say why the issue is being rejected';
  END IF;

  IF p_accept THEN
    PERFORM public._pf_move(v_i.factory_id, v_i.operator_id, v_i.material_id, 'issue_in', v_i.pieces, v_i.issue_date,
                            v_i.reference, v_i.id, NULL, 'Accepted from store');
  ELSE
    PERFORM public._pf_store_back(v_i.material_id, v_i.pieces, v_i.unit_cost, v_i.reference, 'Rejected by operator: ' || p_note);
  END IF;
  UPDATE preform_issues SET status = CASE WHEN p_accept THEN 'accepted' ELSE 'rejected' END,
         responded_by = auth.uid(), responded_at = now(), response_note = NULLIF(btrim(COALESCE(p_note, '')), '')
   WHERE id = p_id;
  PERFORM public._pf_audit(v_i.factory_id, CASE WHEN p_accept THEN 'accept_preform_issue' ELSE 'reject_preform_issue' END,
                           'preform_issues', p_id, NULL, jsonb_build_object('note', p_note));
  RETURN jsonb_build_object('id', p_id, 'status', CASE WHEN p_accept THEN 'accepted' ELSE 'rejected' END);
END;
$$;
REVOKE ALL ON FUNCTION public.respond_preform_issue(uuid, boolean, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.respond_preform_issue(uuid, boolean, text) TO authenticated;

-- The store withdraws an issue the operator has not accepted yet.
CREATE OR REPLACE FUNCTION public.cancel_preform_issue(p_id uuid, p_reason text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_i preform_issues%ROWTYPE;
BEGIN
  IF NOT (public._pf_can('cancel') OR public._pf_can('post')) THEN RAISE EXCEPTION 'Insufficient permissions'; END IF;
  IF NULLIF(btrim(COALESCE(p_reason, '')), '') IS NULL THEN RAISE EXCEPTION 'Give a reason'; END IF;
  SELECT * INTO v_i FROM preform_issues WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Issue not found'; END IF;
  IF v_i.status <> 'issued' THEN RAISE EXCEPTION 'Only an issue the operator has not accepted can be cancelled (this one is %)', v_i.status; END IF;
  PERFORM public._pf_store_back(v_i.material_id, v_i.pieces, v_i.unit_cost, v_i.reference, 'Issue cancelled: ' || p_reason);
  UPDATE preform_issues SET status = 'cancelled', reversed_by = auth.uid(), reversed_at = now(), reversal_reason = btrim(p_reason)
   WHERE id = p_id;
  PERFORM public._pf_audit(v_i.factory_id, 'cancel_preform_issue', 'preform_issues', p_id, NULL, jsonb_build_object('reason', p_reason));
  RETURN jsonb_build_object('id', p_id, 'status', 'cancelled');
END;
$$;
REVOKE ALL ON FUNCTION public.cancel_preform_issue(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.cancel_preform_issue(uuid, text) TO authenticated;

-- A manager takes back an accepted issue that no shift has used yet.
CREATE OR REPLACE FUNCTION public.reverse_preform_issue(p_id uuid, p_reason text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_i preform_issues%ROWTYPE;
BEGIN
  IF NOT public._pf_can('reverse') THEN RAISE EXCEPTION 'Insufficient permissions'; END IF;
  IF NULLIF(btrim(COALESCE(p_reason, '')), '') IS NULL THEN RAISE EXCEPTION 'Give a reason'; END IF;
  SELECT * INTO v_i FROM preform_issues WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Issue not found'; END IF;
  IF v_i.status <> 'accepted' THEN RAISE EXCEPTION 'Only an accepted issue can be reversed'; END IF;
  IF v_i.shift_record_id IS NOT NULL THEN
    RAISE EXCEPTION 'A submitted shift has already used this issue. Reverse that shift record first.';
  END IF;
  PERFORM public._pf_move(v_i.factory_id, v_i.operator_id, v_i.material_id, 'issue_reversed', -v_i.pieces, v_i.issue_date,
                          v_i.reference, v_i.id, NULL, 'Issue reversed: ' || p_reason);
  PERFORM public._pf_store_back(v_i.material_id, v_i.pieces, v_i.unit_cost, v_i.reference, 'Issue reversed: ' || p_reason);
  UPDATE preform_issues SET status = 'reversed', reversed_by = auth.uid(), reversed_at = now(), reversal_reason = btrim(p_reason)
   WHERE id = p_id;
  PERFORM public._pf_audit(v_i.factory_id, 'reverse_preform_issue', 'preform_issues', p_id, NULL, jsonb_build_object('reason', p_reason));
  RETURN jsonb_build_object('id', p_id, 'status', 'reversed');
END;
$$;
REVOKE ALL ON FUNCTION public.reverse_preform_issue(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.reverse_preform_issue(uuid, text) TO authenticated;

-- ============ 9. Shift records ============
-- Create or edit a draft. Operators record their own shifts; a manager
-- (reverse) may record for any operator.
CREATE OR REPLACE FUNCTION public.save_preform_shift(payload jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_id uuid := NULLIF(payload->>'id', '')::uuid;
  v_operator uuid := COALESCE(NULLIF(payload->>'operator_id', '')::uuid, auth.uid());
  v_material uuid := (payload->>'material_id')::uuid;
  v_date date := (payload->>'production_date')::date;
  v_shift text := payload->>'shift';
  v_good numeric := COALESCE(NULLIF(payload->>'good_bottles', '')::numeric, 0);
  v_dp numeric := COALESCE(NULLIF(payload->>'damaged_preforms', '')::numeric, 0);
  v_db numeric := COALESCE(NULLIF(payload->>'damaged_bottles', '')::numeric, 0);
  v_ol numeric := COALESCE(NULLIF(payload->>'other_losses', '')::numeric, 0);
  v_m raw_materials%ROWTYPE;
  v_row preform_shift_records%ROWTYPE;
BEGIN
  IF NOT (public._pf_can('create') OR public._pf_can('edit')) THEN RAISE EXCEPTION 'Insufficient permissions'; END IF;
  IF v_operator <> auth.uid() AND NOT (public._pf_can('reverse') OR public._pf_is_admin()) THEN
    RAISE EXCEPTION 'You can only record your own shifts';
  END IF;
  IF v_shift NOT IN ('day', 'night') THEN RAISE EXCEPTION 'Pick the shift (day or night)'; END IF;
  IF v_date IS NULL OR v_date > public._pf_today() THEN RAISE EXCEPTION 'Pick a production date that is not in the future'; END IF;
  IF least(v_good, v_dp, v_db, v_ol) < 0 THEN RAISE EXCEPTION 'Quantities cannot be negative'; END IF;
  IF v_good <> trunc(v_good) OR v_dp <> trunc(v_dp) OR v_db <> trunc(v_db) OR v_ol <> trunc(v_ol) THEN
    RAISE EXCEPTION 'Quantities are whole pieces';
  END IF;
  IF v_ol > 0 AND NULLIF(btrim(COALESCE(payload->>'other_loss_reason', '')), '') IS NULL THEN
    RAISE EXCEPTION 'Say what the other losses were';
  END IF;
  SELECT * INTO v_m FROM raw_materials WHERE id = v_material;
  IF NOT FOUND THEN RAISE EXCEPTION 'Preform material not found'; END IF;

  IF v_id IS NULL THEN
    INSERT INTO preform_shift_records(factory_id, reference, operator_id, material_id, output_product_id, production_date,
                                      shift, machine, good_bottles, damaged_preforms, damaged_bottles, other_losses,
                                      other_loss_reason, notes, created_by)
    VALUES (v_m.factory_id, public._pf_ref('PSR'), v_operator, v_material, v_m.output_product_id, v_date, v_shift,
            NULLIF(btrim(COALESCE(payload->>'machine', '')), ''), v_good, v_dp, v_db, v_ol,
            NULLIF(btrim(COALESCE(payload->>'other_loss_reason', '')), ''),
            NULLIF(btrim(COALESCE(payload->>'notes', '')), ''), auth.uid())
    RETURNING * INTO v_row;
  ELSE
    SELECT * INTO v_row FROM preform_shift_records WHERE id = v_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Shift record not found'; END IF;
    IF v_row.status <> 'draft' THEN RAISE EXCEPTION 'Only a draft can be edited (this record is %)', replace(v_row.status, '_', ' '); END IF;
    IF v_row.operator_id <> auth.uid() AND NOT (public._pf_can('reverse') OR public._pf_is_admin()) THEN
      RAISE EXCEPTION 'You can only edit your own shift records';
    END IF;
    UPDATE preform_shift_records SET
      material_id = v_material, output_product_id = v_m.output_product_id, production_date = v_date, shift = v_shift,
      machine = NULLIF(btrim(COALESCE(payload->>'machine', '')), ''),
      good_bottles = v_good, damaged_preforms = v_dp, damaged_bottles = v_db, other_losses = v_ol,
      other_loss_reason = NULLIF(btrim(COALESCE(payload->>'other_loss_reason', '')), ''),
      notes = NULLIF(btrim(COALESCE(payload->>'notes', '')), ''), updated_at = now()
     WHERE id = v_id
    RETURNING * INTO v_row;
  END IF;
  RETURN jsonb_build_object('id', v_row.id, 'reference', v_row.reference, 'status', v_row.status);
EXCEPTION WHEN unique_violation THEN
  RAISE EXCEPTION 'There is already a % shift record for this operator and preform on %', v_shift, to_char(v_date, 'DD Mon YYYY');
END;
$$;
REVOKE ALL ON FUNCTION public.save_preform_shift(jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.save_preform_shift(jsonb) TO authenticated;

-- Submit: snapshot opening / issued / available, post the usage to the
-- holding, attach the issues this shift used. Refused if usage exceeds what
-- the operator holds.
CREATE OR REPLACE FUNCTION public.submit_preform_shift(p_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_r preform_shift_records%ROWTYPE;
  v_held numeric;
  v_issued numeric;
  v_usage numeric;
BEGIN
  IF NOT public._pf_can('submit') THEN RAISE EXCEPTION 'Insufficient permissions'; END IF;
  SELECT * INTO v_r FROM preform_shift_records WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Shift record not found'; END IF;
  IF v_r.status <> 'draft' THEN RAISE EXCEPTION 'This record has already been submitted'; END IF;
  IF v_r.operator_id <> auth.uid() AND NOT (public._pf_can('reverse') OR public._pf_is_admin()) THEN
    RAISE EXCEPTION 'You can only submit your own shift records';
  END IF;
  IF v_r.output_product_id IS NULL THEN
    RAISE EXCEPTION 'This preform has no bottle product set up (Preform Production → Setup)';
  END IF;
  v_usage := v_r.good_bottles + v_r.damaged_preforms + v_r.damaged_bottles + v_r.other_losses;
  IF v_usage <= 0 THEN RAISE EXCEPTION 'Enter the good bottles and damage for this shift'; END IF;

  -- Lock the holding so two submissions can't both spend the same preforms.
  INSERT INTO preform_holdings(factory_id, operator_id, material_id, quantity)
  VALUES (v_r.factory_id, v_r.operator_id, v_r.material_id, 0)
  ON CONFLICT (operator_id, material_id) DO NOTHING;
  SELECT quantity INTO v_held FROM preform_holdings
   WHERE operator_id = v_r.operator_id AND material_id = v_r.material_id FOR UPDATE;

  SELECT COALESCE(SUM(pieces), 0) INTO v_issued FROM preform_issues
   WHERE operator_id = v_r.operator_id AND material_id = v_r.material_id
     AND status = 'accepted' AND shift_record_id IS NULL;

  IF v_usage > v_held THEN
    RAISE EXCEPTION 'Usage of % pieces is more than the % pieces available (opening % + received %). Short by % pieces.',
      v_usage, v_held, v_held - v_issued, v_issued, v_usage - v_held;
  END IF;

  UPDATE preform_issues SET shift_record_id = p_id
   WHERE operator_id = v_r.operator_id AND material_id = v_r.material_id
     AND status = 'accepted' AND shift_record_id IS NULL;

  PERFORM public._pf_move(v_r.factory_id, v_r.operator_id, v_r.material_id, 'good_bottles', -v_r.good_bottles,
                          v_r.production_date, v_r.reference, NULL, p_id, 'Blown into good bottles');
  PERFORM public._pf_move(v_r.factory_id, v_r.operator_id, v_r.material_id, 'damaged_preforms', -v_r.damaged_preforms,
                          v_r.production_date, v_r.reference, NULL, p_id, 'Damaged preforms');
  PERFORM public._pf_move(v_r.factory_id, v_r.operator_id, v_r.material_id, 'damaged_bottles', -v_r.damaged_bottles,
                          v_r.production_date, v_r.reference, NULL, p_id, 'Damaged during blowing');
  PERFORM public._pf_move(v_r.factory_id, v_r.operator_id, v_r.material_id, 'other_losses', -v_r.other_losses,
                          v_r.production_date, v_r.reference, NULL, p_id, COALESCE(v_r.other_loss_reason, 'Other loss'));

  UPDATE preform_shift_records SET
    status = 'awaiting_inspection', opening_qty = v_held - v_issued, issued_qty = v_issued, available_qty = v_held,
    usage_qty = v_usage, expected_remaining = v_held - v_usage,
    submitted_by = auth.uid(), submitted_at = now(), updated_at = now()
   WHERE id = p_id;
  PERFORM public._pf_audit(v_r.factory_id, 'submit_preform_shift', 'preform_shift_records', p_id, NULL,
    jsonb_build_object('available', v_held, 'usage', v_usage, 'remaining', v_held - v_usage));
  RETURN jsonb_build_object('id', p_id, 'status', 'awaiting_inspection', 'available', v_held, 'usage', v_usage,
                            'expected_remaining', v_held - v_usage);
END;
$$;
REVOKE ALL ON FUNCTION public.submit_preform_shift(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.submit_preform_shift(uuid) TO authenticated;

-- Undo a submitted record's usage (QC return or manager reversal): the
-- preforms go back into the holding, the issues it used are freed for the
-- next submission.
CREATE OR REPLACE FUNCTION public._pf_undo_usage(p_record uuid, p_reason text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_r preform_shift_records%ROWTYPE;
BEGIN
  SELECT * INTO v_r FROM preform_shift_records WHERE id = p_record;
  IF COALESCE(v_r.usage_qty, 0) > 0 THEN
    PERFORM public._pf_move(v_r.factory_id, v_r.operator_id, v_r.material_id, 'usage_reversed', v_r.usage_qty,
                            v_r.production_date, v_r.reference, NULL, p_record, p_reason);
  END IF;
  UPDATE preform_issues SET shift_record_id = NULL WHERE shift_record_id = p_record;
END;
$$;
REVOKE ALL ON FUNCTION public._pf_undo_usage(uuid, text) FROM PUBLIC, anon, authenticated;

-- ============ 10. QC ============
-- approved: every good bottle reported is classified good or rejected
--           (good + rejected = good bottles); the good ones may be stocked.
-- returned: back to the operator as a draft, usage undone.
CREATE OR REPLACE FUNCTION public.inspect_preform_shift(
  p_id uuid, p_decision text, p_good numeric, p_rejected numeric,
  p_reason text DEFAULT NULL, p_disposition text DEFAULT NULL, p_notes text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_r preform_shift_records%ROWTYPE;
  v_good numeric := COALESCE(p_good, 0);
  v_rej numeric := COALESCE(p_rejected, 0);
BEGIN
  IF p_decision = 'approved' AND NOT public._pf_can('approve') THEN RAISE EXCEPTION 'Insufficient permissions'; END IF;
  IF p_decision = 'returned' AND NOT public._pf_can('reject') THEN RAISE EXCEPTION 'Insufficient permissions'; END IF;
  IF p_decision NOT IN ('approved', 'returned') THEN RAISE EXCEPTION 'Unknown decision'; END IF;
  SELECT * INTO v_r FROM preform_shift_records WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Shift record not found'; END IF;
  IF v_r.status <> 'awaiting_inspection' THEN RAISE EXCEPTION 'This record is not awaiting inspection'; END IF;
  IF (v_r.operator_id = auth.uid() OR v_r.submitted_by = auth.uid()) AND NOT public._pf_is_admin() THEN
    RAISE EXCEPTION 'QC must be done by someone other than the operator who recorded the shift';
  END IF;

  IF p_decision = 'returned' THEN
    IF NULLIF(btrim(COALESCE(p_notes, p_reason, '')), '') IS NULL THEN RAISE EXCEPTION 'Say what the operator must correct'; END IF;
    PERFORM public._pf_undo_usage(p_id, 'Returned by QC');
    INSERT INTO preform_qc_inspections(factory_id, shift_record_id, decision, inspected_qty, good_qty, rejected_qty,
                                       reason, disposition, notes, inspector_id)
    VALUES (v_r.factory_id, p_id, 'returned', 0, 0, 0, p_reason, p_disposition, COALESCE(p_notes, p_reason), auth.uid());
    UPDATE preform_shift_records SET status = 'draft', opening_qty = NULL, issued_qty = NULL, available_qty = NULL,
           usage_qty = NULL, expected_remaining = NULL, submitted_by = NULL, submitted_at = NULL, updated_at = now()
     WHERE id = p_id;
    PERFORM public._pf_audit(v_r.factory_id, 'return_preform_shift', 'preform_shift_records', p_id, NULL,
                             jsonb_build_object('notes', COALESCE(p_notes, p_reason)));
    RETURN jsonb_build_object('id', p_id, 'status', 'draft');
  END IF;

  IF v_good < 0 OR v_rej < 0 OR v_good <> trunc(v_good) OR v_rej <> trunc(v_rej) THEN
    RAISE EXCEPTION 'Good and rejected are whole numbers, 0 or more';
  END IF;
  IF v_good + v_rej <> v_r.good_bottles THEN
    RAISE EXCEPTION 'Good (%) + rejected (%) must equal the % good bottles the operator reported', v_good, v_rej, v_r.good_bottles;
  END IF;
  IF v_rej > 0 AND NULLIF(btrim(COALESCE(p_reason, '')), '') IS NULL THEN
    RAISE EXCEPTION 'Give the reason for the rejected bottles';
  END IF;

  INSERT INTO preform_qc_inspections(factory_id, shift_record_id, decision, inspected_qty, good_qty, rejected_qty,
                                     reason, disposition, notes, inspector_id)
  VALUES (v_r.factory_id, p_id, 'approved', v_r.good_bottles, v_good, v_rej, p_reason, p_disposition, p_notes, auth.uid());
  UPDATE preform_shift_records SET qc_good = v_good, qc_rejected = v_rej,
         status = CASE WHEN v_good = 0 THEN 'completed' ELSE 'awaiting_stocking' END,
         completed_at = CASE WHEN v_good = 0 THEN now() END, updated_at = now()
   WHERE id = p_id;
  PERFORM public._pf_audit(v_r.factory_id, 'approve_preform_shift', 'preform_shift_records', p_id, NULL,
                           jsonb_build_object('good', v_good, 'rejected', v_rej, 'reason', p_reason));
  RETURN jsonb_build_object('id', p_id, 'status', CASE WHEN v_good = 0 THEN 'completed' ELSE 'awaiting_stocking' END);
END;
$$;
REVOKE ALL ON FUNCTION public.inspect_preform_shift(uuid, text, numeric, numeric, text, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.inspect_preform_shift(uuid, text, numeric, numeric, text, text, text) TO authenticated;

-- ============ 11. Stocking ============
-- What is still to be stocked from a record.
CREATE OR REPLACE FUNCTION public._pf_remaining_to_stock(p_record uuid)
RETURNS numeric LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT COALESCE(r.qc_good, 0)
       - COALESCE((SELECT SUM(accepted_qty) FROM preform_stockings s WHERE s.shift_record_id = r.id AND s.status = 'accepted'), 0)
       - COALESCE((SELECT SUM(counted_qty) FROM preform_stockings s WHERE s.shift_record_id = r.id AND s.status = 'sent'), 0)
       - COALESCE((SELECT SUM(difference_qty) FROM preform_exceptions e
                    WHERE e.shift_record_id = r.id AND e.kind IN ('stock_shortfall', 'count_mismatch')
                      AND e.status IN ('open', 'resolved')), 0)
    FROM preform_shift_records r WHERE r.id = p_record;
$$;
REVOKE ALL ON FUNCTION public._pf_remaining_to_stock(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public._pf_remaining_to_stock(uuid) TO authenticated;

-- Completes the record once nothing is left to stock, nothing is waiting at
-- the Warehouse and no exception is open.
CREATE OR REPLACE FUNCTION public._pf_try_complete(p_record uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  UPDATE preform_shift_records r SET status = 'completed', completed_at = now(), updated_at = now()
   WHERE r.id = p_record AND r.status = 'awaiting_stocking'
     AND public._pf_remaining_to_stock(r.id) = 0
     AND NOT EXISTS (SELECT 1 FROM preform_stockings s WHERE s.shift_record_id = r.id AND s.status = 'sent')
     AND NOT EXISTS (SELECT 1 FROM preform_exceptions e WHERE e.shift_record_id = r.id AND e.status = 'open');
END;
$$;
REVOKE ALL ON FUNCTION public._pf_try_complete(uuid) FROM PUBLIC, anon, authenticated;

-- The operator counts good bottles and sends them to the Warehouse.
CREATE OR REPLACE FUNCTION public.send_preform_stocking(p_record uuid, p_counted numeric, p_note text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_r preform_shift_records%ROWTYPE;
  v_remaining numeric;
  v_id uuid;
  v_ref text;
BEGIN
  IF NOT public._pf_can('submit') THEN RAISE EXCEPTION 'Insufficient permissions'; END IF;
  SELECT * INTO v_r FROM preform_shift_records WHERE id = p_record FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Shift record not found'; END IF;
  IF v_r.status <> 'awaiting_stocking' THEN
    RAISE EXCEPTION 'Good bottles can be stocked only after QC approves the shift (this record is %)', replace(v_r.status, '_', ' ');
  END IF;
  IF p_counted IS NULL OR p_counted <= 0 OR p_counted <> trunc(p_counted) THEN
    RAISE EXCEPTION 'Enter the number of good bottles counted';
  END IF;
  v_remaining := public._pf_remaining_to_stock(p_record);
  IF p_counted > v_remaining THEN
    RAISE EXCEPTION 'You counted % but only % QC-approved bottles remain to be stocked. Bottles beyond what QC approved cannot be stocked; ask QC to re-inspect.',
      p_counted, v_remaining;
  END IF;
  v_ref := public._pf_ref('PGS');
  INSERT INTO preform_stockings(factory_id, reference, shift_record_id, product_id, expected_qty, counted_qty, sent_by, send_note)
  VALUES (v_r.factory_id, v_ref, p_record, v_r.output_product_id, v_remaining, p_counted, auth.uid(),
          NULLIF(btrim(COALESCE(p_note, '')), ''))
  RETURNING id INTO v_id;
  PERFORM public._pf_audit(v_r.factory_id, 'send_preform_stocking', 'preform_stockings', v_id, NULL,
                           jsonb_build_object('record', v_r.reference, 'expected', v_remaining, 'counted', p_counted));
  RETURN jsonb_build_object('id', v_id, 'reference', v_ref);
END;
$$;
REVOKE ALL ON FUNCTION public.send_preform_stocking(uuid, numeric, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.send_preform_stocking(uuid, numeric, text) TO authenticated;

-- The sender withdraws a stocking the Warehouse has not acted on.
CREATE OR REPLACE FUNCTION public.cancel_preform_stocking(p_id uuid, p_reason text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_s preform_stockings%ROWTYPE;
BEGIN
  IF NOT public._pf_can('submit') THEN RAISE EXCEPTION 'Insufficient permissions'; END IF;
  SELECT * INTO v_s FROM preform_stockings WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Stocking not found'; END IF;
  IF v_s.status <> 'sent' THEN RAISE EXCEPTION 'Only a stocking the Warehouse has not handled can be withdrawn'; END IF;
  UPDATE preform_stockings SET status = 'cancelled', reversed_by = auth.uid(), reversed_at = now(),
         reversal_reason = NULLIF(btrim(COALESCE(p_reason, '')), '')
   WHERE id = p_id;
  PERFORM public._pf_audit(v_s.factory_id, 'cancel_preform_stocking', 'preform_stockings', p_id, NULL, jsonb_build_object('reason', p_reason));
  RETURN jsonb_build_object('id', p_id, 'status', 'cancelled');
END;
$$;
REVOKE ALL ON FUNCTION public.cancel_preform_stocking(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.cancel_preform_stocking(uuid, text) TO authenticated;

-- The Warehouse counts and accepts. Stock rises by what it received; less
-- than was sent opens a count_mismatch exception for the difference.
CREATE OR REPLACE FUNCTION public.accept_preform_stocking(p_id uuid, p_received numeric, p_note text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_s preform_stockings%ROWTYPE;
  v_r preform_shift_records%ROWTYPE;
  v_exc uuid;
BEGIN
  IF NOT public._pf_can('confirm') THEN RAISE EXCEPTION 'Insufficient permissions'; END IF;
  SELECT * INTO v_s FROM preform_stockings WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Stocking not found'; END IF;
  IF v_s.status <> 'sent' THEN RAISE EXCEPTION 'This stocking has already been %', v_s.status; END IF;
  IF v_s.sent_by = auth.uid() AND NOT public._pf_is_admin() THEN
    RAISE EXCEPTION 'The Warehouse must be someone other than the person who sent the bottles';
  END IF;
  IF p_received IS NULL OR p_received < 0 OR p_received <> trunc(p_received) THEN
    RAISE EXCEPTION 'Enter the number of good bottles received';
  END IF;
  IF p_received > v_s.counted_qty THEN
    RAISE EXCEPTION 'You counted % but only % were sent. Accept % and ask the operator to send the extra as a new stocking.',
      p_received, v_s.counted_qty, v_s.counted_qty;
  END IF;
  IF p_received < v_s.counted_qty AND NULLIF(btrim(COALESCE(p_note, '')), '') IS NULL THEN
    RAISE EXCEPTION 'You received fewer than were sent. Add a note.';
  END IF;
  SELECT * INTO v_r FROM preform_shift_records WHERE id = v_s.shift_record_id FOR UPDATE;

  IF p_received > 0 THEN
    PERFORM public._pf_product_move(v_s.product_id, p_received, 'produced', v_s.reference,
                                    'Good bottles from ' || v_r.reference || ' (' || v_r.shift || ' shift ' || v_r.production_date || ')');
  END IF;
  UPDATE preform_stockings SET status = 'accepted', received_qty = p_received, accepted_qty = p_received,
         received_by = auth.uid(), received_at = now(), receive_note = NULLIF(btrim(COALESCE(p_note, '')), '')
   WHERE id = p_id;

  IF p_received < v_s.counted_qty THEN
    INSERT INTO preform_exceptions(factory_id, reference, kind, shift_record_id, stocking_id, product_id, expected_qty,
                                   actual_qty, difference_qty, note, raised_by)
    VALUES (v_s.factory_id, public._pf_ref('PEX'), 'count_mismatch', v_s.shift_record_id, p_id, v_s.product_id,
            v_s.counted_qty, p_received, v_s.counted_qty - p_received, p_note, auth.uid())
    RETURNING id INTO v_exc;
  END IF;
  PERFORM public._pf_try_complete(v_s.shift_record_id);
  PERFORM public._pf_audit(v_s.factory_id, 'accept_preform_stocking', 'preform_stockings', p_id, NULL,
                           jsonb_build_object('counted', v_s.counted_qty, 'received', p_received, 'exception', v_exc));
  RETURN jsonb_build_object('id', p_id, 'status', 'accepted', 'exception_id', v_exc);
END;
$$;
REVOKE ALL ON FUNCTION public.accept_preform_stocking(uuid, numeric, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.accept_preform_stocking(uuid, numeric, text) TO authenticated;

-- The Warehouse refuses a stocking (e.g. wrong product, not there): nothing
-- moves; the bottles are again "remaining to stock" on the record.
CREATE OR REPLACE FUNCTION public.reject_preform_stocking(p_id uuid, p_note text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_s preform_stockings%ROWTYPE;
BEGIN
  IF NOT public._pf_can('reject') OR NOT public._pf_can('confirm') THEN RAISE EXCEPTION 'Insufficient permissions'; END IF;
  IF NULLIF(btrim(COALESCE(p_note, '')), '') IS NULL THEN RAISE EXCEPTION 'Say why the stocking is refused'; END IF;
  SELECT * INTO v_s FROM preform_stockings WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Stocking not found'; END IF;
  IF v_s.status <> 'sent' THEN RAISE EXCEPTION 'This stocking has already been %', v_s.status; END IF;
  UPDATE preform_stockings SET status = 'rejected', received_by = auth.uid(), received_at = now(), receive_note = btrim(p_note)
   WHERE id = p_id;
  PERFORM public._pf_audit(v_s.factory_id, 'reject_preform_stocking', 'preform_stockings', p_id, NULL, jsonb_build_object('note', p_note));
  RETURN jsonb_build_object('id', p_id, 'status', 'rejected');
END;
$$;
REVOKE ALL ON FUNCTION public.reject_preform_stocking(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.reject_preform_stocking(uuid, text) TO authenticated;

-- The operator says no more bottles will be stocked from this record: the
-- rest becomes a stock_shortfall exception for a manager to resolve.
CREATE OR REPLACE FUNCTION public.report_preform_shortfall(p_record uuid, p_note text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_r preform_shift_records%ROWTYPE;
  v_remaining numeric;
  v_id uuid;
BEGIN
  IF NOT public._pf_can('submit') THEN RAISE EXCEPTION 'Insufficient permissions'; END IF;
  IF NULLIF(btrim(COALESCE(p_note, '')), '') IS NULL THEN RAISE EXCEPTION 'Explain the shortfall'; END IF;
  SELECT * INTO v_r FROM preform_shift_records WHERE id = p_record FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Shift record not found'; END IF;
  IF v_r.status <> 'awaiting_stocking' THEN RAISE EXCEPTION 'Nothing is waiting to be stocked on this record'; END IF;
  v_remaining := public._pf_remaining_to_stock(p_record);
  IF v_remaining <= 0 THEN RAISE EXCEPTION 'Nothing is left to stock on this record'; END IF;
  INSERT INTO preform_exceptions(factory_id, reference, kind, shift_record_id, product_id, expected_qty, actual_qty,
                                 difference_qty, note, raised_by)
  VALUES (v_r.factory_id, public._pf_ref('PEX'), 'stock_shortfall', p_record, v_r.output_product_id,
          v_r.qc_good, v_r.qc_good - v_remaining, v_remaining, btrim(p_note), auth.uid())
  RETURNING id INTO v_id;
  PERFORM public._pf_audit(v_r.factory_id, 'report_preform_shortfall', 'preform_exceptions', v_id, NULL,
                           jsonb_build_object('record', v_r.reference, 'shortfall', v_remaining, 'note', p_note));
  RETURN jsonb_build_object('id', v_id, 'shortfall', v_remaining);
END;
$$;
REVOKE ALL ON FUNCTION public.report_preform_shortfall(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.report_preform_shortfall(uuid, text) TO authenticated;

-- A manager takes an accepted stocking back out of the Warehouse (refused if
-- the bottles are no longer there, e.g. already transferred to PM).
CREATE OR REPLACE FUNCTION public.reverse_preform_stocking(p_id uuid, p_reason text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_s preform_stockings%ROWTYPE;
BEGIN
  IF NOT public._pf_can('reverse') THEN RAISE EXCEPTION 'Insufficient permissions'; END IF;
  IF NULLIF(btrim(COALESCE(p_reason, '')), '') IS NULL THEN RAISE EXCEPTION 'Give a reason'; END IF;
  SELECT * INTO v_s FROM preform_stockings WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Stocking not found'; END IF;
  IF v_s.status <> 'accepted' THEN RAISE EXCEPTION 'Only an accepted stocking can be reversed'; END IF;
  IF COALESCE(v_s.accepted_qty, 0) > 0 THEN
    PERFORM public._pf_product_move(v_s.product_id, -v_s.accepted_qty, 'correction', v_s.reference,
                                    'Stocking reversed: ' || p_reason);
  END IF;
  UPDATE preform_stockings SET status = 'reversed', reversed_by = auth.uid(), reversed_at = now(), reversal_reason = btrim(p_reason)
   WHERE id = p_id;
  -- Its count_mismatch exception no longer stands.
  UPDATE preform_exceptions SET status = 'voided', resolved_by = auth.uid(), resolved_at = now(),
         resolution_note = 'Stocking reversed: ' || p_reason
   WHERE stocking_id = p_id AND status <> 'voided';
  UPDATE preform_shift_records SET status = 'awaiting_stocking', completed_at = NULL, updated_at = now()
   WHERE id = v_s.shift_record_id AND status = 'completed';
  PERFORM public._pf_audit(v_s.factory_id, 'reverse_preform_stocking', 'preform_stockings', p_id, NULL, jsonb_build_object('reason', p_reason));
  RETURN jsonb_build_object('id', p_id, 'status', 'reversed');
END;
$$;
REVOKE ALL ON FUNCTION public.reverse_preform_stocking(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.reverse_preform_stocking(uuid, text) TO authenticated;

-- A manager reverses a submitted shift record that has nothing in stock.
CREATE OR REPLACE FUNCTION public.reverse_preform_shift(p_id uuid, p_reason text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_r preform_shift_records%ROWTYPE;
BEGIN
  IF NOT public._pf_can('reverse') THEN RAISE EXCEPTION 'Insufficient permissions'; END IF;
  IF NULLIF(btrim(COALESCE(p_reason, '')), '') IS NULL THEN RAISE EXCEPTION 'Give a reason'; END IF;
  SELECT * INTO v_r FROM preform_shift_records WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Shift record not found'; END IF;
  IF v_r.status NOT IN ('awaiting_inspection', 'awaiting_stocking', 'completed') THEN
    RAISE EXCEPTION 'Only a submitted record can be reversed (a draft can simply be edited)';
  END IF;
  IF EXISTS (SELECT 1 FROM preform_stockings WHERE shift_record_id = p_id AND status IN ('sent', 'accepted')) THEN
    RAISE EXCEPTION 'Good bottles from this record are with the Warehouse. Withdraw or reverse those stockings first.';
  END IF;
  -- Shifts submitted after this one were built on its remaining stock.
  IF EXISTS (SELECT 1 FROM preform_shift_records l
              WHERE l.operator_id = v_r.operator_id AND l.material_id = v_r.material_id AND l.id <> p_id
                AND l.status IN ('awaiting_inspection', 'awaiting_stocking', 'completed') AND l.submitted_at > v_r.submitted_at) THEN
    RAISE EXCEPTION 'A later shift for this operator and preform was submitted after this one. Reverse the later shift first.';
  END IF;
  PERFORM public._pf_undo_usage(p_id, 'Shift reversed: ' || p_reason);
  UPDATE preform_exceptions SET status = 'voided', resolved_by = auth.uid(), resolved_at = now(),
         resolution_note = 'Shift reversed: ' || p_reason
   WHERE shift_record_id = p_id AND status = 'open';
  UPDATE preform_shift_records SET status = 'reversed', reversed_by = auth.uid(), reversed_at = now(),
         reversal_reason = btrim(p_reason), updated_at = now()
   WHERE id = p_id;
  PERFORM public._pf_audit(v_r.factory_id, 'reverse_preform_shift', 'preform_shift_records', p_id, NULL, jsonb_build_object('reason', p_reason));
  RETURN jsonb_build_object('id', p_id, 'status', 'reversed');
END;
$$;
REVOKE ALL ON FUNCTION public.reverse_preform_shift(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.reverse_preform_shift(uuid, text) TO authenticated;

-- ============ 12. Transfers to PM ============
CREATE OR REPLACE FUNCTION public.dispatch_bottle_transfer(payload jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_client uuid := NULLIF(payload->>'client_ref', '')::uuid;
  v_product uuid := (payload->>'product_id')::uuid;
  v_qty numeric := (payload->>'quantity')::numeric;
  v_dept text := NULLIF(btrim(COALESCE(payload->>'to_department', '')), '');
  v_p products%ROWTYPE;
  v_ref text;
  v_id uuid;
  v_existing bottle_transfers%ROWTYPE;
BEGIN
  IF NOT public._pf_can('post') THEN RAISE EXCEPTION 'Insufficient permissions'; END IF;
  IF v_client IS NOT NULL THEN
    SELECT * INTO v_existing FROM bottle_transfers WHERE client_ref = v_client;
    IF FOUND THEN RETURN jsonb_build_object('id', v_existing.id, 'reference', v_existing.reference, 'duplicate', true); END IF;
  END IF;
  IF v_dept IS NULL THEN RAISE EXCEPTION 'Pick the receiving department'; END IF;
  IF v_qty IS NULL OR v_qty <= 0 OR v_qty <> trunc(v_qty) THEN RAISE EXCEPTION 'Enter a whole quantity above 0'; END IF;
  SELECT * INTO v_p FROM products WHERE id = v_product;
  IF NOT FOUND THEN RAISE EXCEPTION 'Product not found'; END IF;

  v_ref := public._pf_ref('BTR');
  PERFORM public._pf_product_move(v_product, -v_qty, 'transferred', v_ref, 'Transfer to ' || v_dept);
  INSERT INTO bottle_transfers(factory_id, reference, client_ref, product_id, to_department, quantity_sent, notes, sent_by)
  VALUES (v_p.factory_id, v_ref, v_client, v_product, v_dept, v_qty, NULLIF(btrim(COALESCE(payload->>'notes', '')), ''), auth.uid())
  RETURNING id INTO v_id;
  PERFORM public._pf_audit(v_p.factory_id, 'dispatch_bottle_transfer', 'bottle_transfers', v_id, NULL,
                           jsonb_build_object('reference', v_ref, 'to', v_dept, 'quantity', v_qty));
  RETURN jsonb_build_object('id', v_id, 'reference', v_ref);
END;
$$;
REVOKE ALL ON FUNCTION public.dispatch_bottle_transfer(jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.dispatch_bottle_transfer(jsonb) TO authenticated;

CREATE OR REPLACE FUNCTION public.cancel_bottle_transfer(p_id uuid, p_reason text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_t bottle_transfers%ROWTYPE;
BEGIN
  IF NOT (public._pf_can('cancel') OR public._pf_can('post')) THEN RAISE EXCEPTION 'Insufficient permissions'; END IF;
  IF NULLIF(btrim(COALESCE(p_reason, '')), '') IS NULL THEN RAISE EXCEPTION 'Give a reason'; END IF;
  SELECT * INTO v_t FROM bottle_transfers WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Transfer not found'; END IF;
  IF v_t.status <> 'dispatched' THEN RAISE EXCEPTION 'Only a transfer not yet received can be cancelled'; END IF;
  PERFORM public._pf_product_move(v_t.product_id, v_t.quantity_sent, 'returned', v_t.reference, 'Transfer cancelled: ' || p_reason);
  UPDATE bottle_transfers SET status = 'cancelled', reversed_by = auth.uid(), reversed_at = now(), reversal_reason = btrim(p_reason)
   WHERE id = p_id;
  PERFORM public._pf_audit(v_t.factory_id, 'cancel_bottle_transfer', 'bottle_transfers', p_id, NULL, jsonb_build_object('reason', p_reason));
  RETURN jsonb_build_object('id', p_id, 'status', 'cancelled');
END;
$$;
REVOKE ALL ON FUNCTION public.cancel_bottle_transfer(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.cancel_bottle_transfer(uuid, text) TO authenticated;

-- The receiving department counts what arrived. Less than sent opens a
-- transfer_shortfall exception; more than sent is refused.
CREATE OR REPLACE FUNCTION public.receive_bottle_transfer(p_id uuid, p_received numeric, p_note text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_t bottle_transfers%ROWTYPE;
  v_status text;
  v_exc uuid;
BEGIN
  IF NOT public._pf_can('submit') THEN RAISE EXCEPTION 'Insufficient permissions'; END IF;
  SELECT * INTO v_t FROM bottle_transfers WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Transfer not found'; END IF;
  IF v_t.status <> 'dispatched' THEN RAISE EXCEPTION 'This transfer has already been %', v_t.status; END IF;
  IF v_t.sent_by = auth.uid() AND NOT public._pf_is_admin() THEN
    RAISE EXCEPTION 'The receiver must be someone other than the person who dispatched it';
  END IF;
  IF p_received IS NULL OR p_received < 0 OR p_received <> trunc(p_received) THEN RAISE EXCEPTION 'Enter the quantity received'; END IF;
  IF p_received > v_t.quantity_sent THEN
    RAISE EXCEPTION 'Received (%) cannot be more than was dispatched (%). Report the extra to the Warehouse.', p_received, v_t.quantity_sent;
  END IF;
  IF p_received < v_t.quantity_sent AND NULLIF(btrim(COALESCE(p_note, '')), '') IS NULL THEN
    RAISE EXCEPTION 'You received less than was dispatched. Add a note.';
  END IF;

  IF p_received > 0 THEN
    PERFORM public._pf_dept_move(v_t.factory_id, v_t.to_department, v_t.product_id, p_received, 'transfer_in', v_t.reference, p_id);
  END IF;
  v_status := CASE WHEN p_received < v_t.quantity_sent THEN 'discrepancy' ELSE 'received' END;
  UPDATE bottle_transfers SET status = v_status, quantity_received = p_received, received_by = auth.uid(), received_at = now(),
         receive_note = NULLIF(btrim(COALESCE(p_note, '')), '')
   WHERE id = p_id;
  IF v_status = 'discrepancy' THEN
    INSERT INTO preform_exceptions(factory_id, reference, kind, transfer_id, product_id, expected_qty, actual_qty,
                                   difference_qty, note, raised_by)
    VALUES (v_t.factory_id, public._pf_ref('PEX'), 'transfer_shortfall', p_id, v_t.product_id, v_t.quantity_sent,
            p_received, v_t.quantity_sent - p_received, p_note, auth.uid())
    RETURNING id INTO v_exc;
  END IF;
  PERFORM public._pf_audit(v_t.factory_id, 'receive_bottle_transfer', 'bottle_transfers', p_id, NULL,
                           jsonb_build_object('sent', v_t.quantity_sent, 'received', p_received, 'exception', v_exc));
  RETURN jsonb_build_object('id', p_id, 'status', v_status, 'exception_id', v_exc);
END;
$$;
REVOKE ALL ON FUNCTION public.receive_bottle_transfer(uuid, numeric, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.receive_bottle_transfer(uuid, numeric, text) TO authenticated;

-- A manager reverses a received transfer: the department gives back what it
-- received (refused if it no longer holds it) and the Warehouse takes it in.
CREATE OR REPLACE FUNCTION public.reverse_bottle_transfer(p_id uuid, p_reason text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_t bottle_transfers%ROWTYPE;
BEGIN
  IF NOT public._pf_can('reverse') THEN RAISE EXCEPTION 'Insufficient permissions'; END IF;
  IF NULLIF(btrim(COALESCE(p_reason, '')), '') IS NULL THEN RAISE EXCEPTION 'Give a reason'; END IF;
  SELECT * INTO v_t FROM bottle_transfers WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Transfer not found'; END IF;
  IF v_t.status NOT IN ('received', 'discrepancy') THEN RAISE EXCEPTION 'Only a received transfer can be reversed'; END IF;
  IF EXISTS (SELECT 1 FROM preform_exceptions WHERE transfer_id = p_id AND status = 'resolved') THEN
    RAISE EXCEPTION 'The shortfall on this transfer has already been resolved; it can no longer be reversed';
  END IF;
  IF COALESCE(v_t.quantity_received, 0) > 0 THEN
    PERFORM public._pf_dept_move(v_t.factory_id, v_t.to_department, v_t.product_id, -v_t.quantity_received,
                                 'transfer_reversed', v_t.reference, p_id);
  END IF;
  -- Everything that was dispatched returns: what was received, and the
  -- shortfall still open on it.
  PERFORM public._pf_product_move(v_t.product_id, v_t.quantity_sent, 'returned', v_t.reference, 'Transfer reversed: ' || p_reason);
  UPDATE preform_exceptions SET status = 'voided', resolved_by = auth.uid(), resolved_at = now(),
         resolution_note = 'Transfer reversed: ' || p_reason
   WHERE transfer_id = p_id AND status = 'open';
  UPDATE bottle_transfers SET status = 'reversed', reversed_by = auth.uid(), reversed_at = now(), reversal_reason = btrim(p_reason)
   WHERE id = p_id;
  PERFORM public._pf_audit(v_t.factory_id, 'reverse_bottle_transfer', 'bottle_transfers', p_id, NULL, jsonb_build_object('reason', p_reason));
  RETURN jsonb_build_object('id', p_id, 'status', 'reversed');
END;
$$;
REVOKE ALL ON FUNCTION public.reverse_bottle_transfer(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.reverse_bottle_transfer(uuid, text) TO authenticated;

-- ============ 13. Exceptions ============
--   written_off        the bottles are accepted as lost (no stock moves)
--   returned_to_stock  transfer shortfall only: the missing bottles were
--                      found back at the Warehouse and return to its stock
--   reopened           stocking differences only: the bottles were found;
--                      the exception is voided so they are again "remaining
--                      to stock" and go through a new stocking (and a new
--                      Warehouse count) -- never straight into stock
CREATE OR REPLACE FUNCTION public.resolve_preform_exception(p_id uuid, p_resolution text, p_note text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_e preform_exceptions%ROWTYPE;
  v_t bottle_transfers%ROWTYPE;
BEGIN
  IF NOT public._pf_can('reverse') THEN RAISE EXCEPTION 'Insufficient permissions'; END IF;
  IF NULLIF(btrim(COALESCE(p_note, '')), '') IS NULL THEN RAISE EXCEPTION 'Record what was found'; END IF;
  SELECT * INTO v_e FROM preform_exceptions WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Exception not found'; END IF;
  IF v_e.status <> 'open' THEN RAISE EXCEPTION 'This exception is already %', v_e.status; END IF;
  IF v_e.raised_by = auth.uid() AND NOT public._pf_is_admin() THEN
    RAISE EXCEPTION 'An exception must be resolved by someone other than the person who raised it';
  END IF;
  IF p_resolution NOT IN ('written_off', 'returned_to_stock', 'reopened') THEN RAISE EXCEPTION 'Unknown resolution'; END IF;
  IF p_resolution = 'reopened' THEN
    IF v_e.kind = 'transfer_shortfall' THEN
      RAISE EXCEPTION 'A transfer shortfall is resolved as written off or returned to stock';
    END IF;
    UPDATE preform_exceptions SET status = 'voided', resolution_note = 'Bottles found, sent for stocking again: ' || btrim(p_note),
           resolved_by = auth.uid(), resolved_at = now()
     WHERE id = p_id;
    PERFORM public._pf_audit(v_e.factory_id, 'reopen_preform_exception', 'preform_exceptions', p_id, NULL,
                             jsonb_build_object('note', p_note));
    RETURN jsonb_build_object('id', p_id, 'status', 'voided');
  END IF;
  IF p_resolution = 'returned_to_stock' THEN
    IF v_e.kind <> 'transfer_shortfall' THEN
      RAISE EXCEPTION 'Only a transfer shortfall can be returned to stock. For stocking differences, send the found bottles as a new stocking.';
    END IF;
    SELECT * INTO v_t FROM bottle_transfers WHERE id = v_e.transfer_id;
    PERFORM public._pf_product_move(v_e.product_id, v_e.difference_qty, 'returned', v_t.reference,
                                    'Transfer shortfall found at the Warehouse: ' || p_note);
  END IF;
  UPDATE preform_exceptions SET status = 'resolved', resolution = p_resolution, resolution_note = btrim(p_note),
         resolved_by = auth.uid(), resolved_at = now()
   WHERE id = p_id;
  IF v_e.shift_record_id IS NOT NULL THEN PERFORM public._pf_try_complete(v_e.shift_record_id); END IF;
  PERFORM public._pf_audit(v_e.factory_id, 'resolve_preform_exception', 'preform_exceptions', p_id, NULL,
                           jsonb_build_object('resolution', p_resolution, 'note', p_note));
  RETURN jsonb_build_object('id', p_id, 'status', 'resolved');
END;
$$;
REVOKE ALL ON FUNCTION public.resolve_preform_exception(uuid, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.resolve_preform_exception(uuid, text, text) TO authenticated;

-- ============ 14. Dashboard and reports ============
-- One operator-day for one preform: opening (ledger before the date, shown
-- once), received, usage by category, closing -- plus the live position.
CREATE OR REPLACE FUNCTION public.preform_day_summary(p_operator uuid, p_material uuid, p_date date)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v jsonb;
  v_held numeric;
  v_unused numeric;
BEGIN
  IF NOT public._pf_can('view') THEN RAISE EXCEPTION 'Insufficient permissions'; END IF;
  SELECT jsonb_build_object(
    'opening', COALESCE(SUM(quantity) FILTER (WHERE effective_date < p_date), 0),
    'received', COALESCE(SUM(quantity) FILTER (WHERE effective_date = p_date AND movement_type IN ('issue_in', 'issue_reversed')), 0),
    'good_bottles', COALESCE(-SUM(quantity) FILTER (WHERE effective_date = p_date AND movement_type = 'good_bottles'), 0),
    'damaged_preforms', COALESCE(-SUM(quantity) FILTER (WHERE effective_date = p_date AND movement_type = 'damaged_preforms'), 0),
    'damaged_bottles', COALESCE(-SUM(quantity) FILTER (WHERE effective_date = p_date AND movement_type = 'damaged_bottles'), 0),
    'other_losses', COALESCE(-SUM(quantity) FILTER (WHERE effective_date = p_date AND movement_type = 'other_losses'), 0),
    'usage_reversed', COALESCE(SUM(quantity) FILTER (WHERE effective_date = p_date AND movement_type = 'usage_reversed'), 0),
    'closing', COALESCE(SUM(quantity) FILTER (WHERE effective_date <= p_date), 0))
    INTO v
    FROM preform_movements WHERE operator_id = p_operator AND material_id = p_material;
  SELECT quantity INTO v_held FROM preform_holdings WHERE operator_id = p_operator AND material_id = p_material;
  SELECT COALESCE(SUM(pieces), 0) INTO v_unused FROM preform_issues
   WHERE operator_id = p_operator AND material_id = p_material AND status = 'accepted' AND shift_record_id IS NULL;
  RETURN v || jsonb_build_object(
    'held_now', COALESCE(v_held, 0),
    'received_unused', v_unused,
    'pending_issues', (SELECT COUNT(*) FROM preform_issues WHERE operator_id = p_operator AND material_id = p_material AND status = 'issued'),
    'pending_pieces', (SELECT COALESCE(SUM(pieces), 0) FROM preform_issues WHERE operator_id = p_operator AND material_id = p_material AND status = 'issued'),
    'qc_rejected', (SELECT COALESCE(SUM(qc_rejected), 0) FROM preform_shift_records
                     WHERE operator_id = p_operator AND material_id = p_material AND production_date = p_date AND status <> 'reversed'),
    'stocked', (SELECT COALESCE(SUM(s.accepted_qty), 0) FROM preform_stockings s JOIN preform_shift_records r ON r.id = s.shift_record_id
                 WHERE r.operator_id = p_operator AND r.material_id = p_material AND r.production_date = p_date AND s.status = 'accepted'),
    'to_stock', (SELECT COALESCE(SUM(public._pf_remaining_to_stock(r.id)), 0) FROM preform_shift_records r
                  WHERE r.operator_id = p_operator AND r.material_id = p_material AND r.status = 'awaiting_stocking'),
    'open_exceptions', (SELECT COUNT(*) FROM preform_exceptions e JOIN preform_shift_records r ON r.id = e.shift_record_id
                         WHERE r.operator_id = p_operator AND r.material_id = p_material AND e.status = 'open'),
    'drafts', (SELECT COUNT(*) FROM preform_shift_records WHERE operator_id = p_operator AND material_id = p_material AND status = 'draft'),
    'awaiting_qc', (SELECT COUNT(*) FROM preform_shift_records WHERE operator_id = p_operator AND material_id = p_material AND status = 'awaiting_inspection'));
END;
$$;
REVOKE ALL ON FUNCTION public.preform_day_summary(uuid, uuid, date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.preform_day_summary(uuid, uuid, date) TO authenticated;

-- Shift report rows with their stocking and exception figures.
CREATE OR REPLACE FUNCTION public.preform_shift_report(
  p_factory uuid, p_from date, p_to date, p_operator uuid DEFAULT NULL, p_material uuid DEFAULT NULL,
  p_shift text DEFAULT NULL, p_status text DEFAULT NULL
) RETURNS TABLE(
  id uuid, reference text, production_date date, shift text, operator_id uuid, operator text, material text,
  machine text, status text, opening_qty numeric, issued_qty numeric, available_qty numeric, good_bottles numeric,
  damaged_preforms numeric, damaged_bottles numeric, other_losses numeric, usage_qty numeric,
  expected_remaining numeric, qc_good numeric, qc_rejected numeric, stocked numeric, pending_stock numeric,
  exception_qty numeric, variance numeric, open_exceptions bigint, submitted_at timestamptz
) LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NOT public._pf_can('view') THEN RAISE EXCEPTION 'Insufficient permissions'; END IF;
  RETURN QUERY
  SELECT r.id, r.reference, r.production_date, r.shift, r.operator_id, public._pf_name(r.operator_id), m.name,
         r.machine, r.status, r.opening_qty, r.issued_qty, r.available_qty, r.good_bottles, r.damaged_preforms,
         r.damaged_bottles, r.other_losses, r.usage_qty, r.expected_remaining, r.qc_good, r.qc_rejected,
         COALESCE(st.accepted, 0), COALESCE(st.pending, 0), COALESCE(ex.qty, 0),
         CASE WHEN r.qc_good IS NULL THEN NULL ELSE r.qc_good - COALESCE(st.accepted, 0) END,
         COALESCE(ex.open, 0), r.submitted_at
    FROM preform_shift_records r
    JOIN raw_materials m ON m.id = r.material_id
    LEFT JOIN LATERAL (SELECT SUM(s.accepted_qty) FILTER (WHERE s.status = 'accepted') AS accepted,
                              SUM(s.counted_qty) FILTER (WHERE s.status = 'sent') AS pending
                         FROM preform_stockings s WHERE s.shift_record_id = r.id) st ON true
    LEFT JOIN LATERAL (SELECT SUM(e.difference_qty) FILTER (WHERE e.status IN ('open', 'resolved')) AS qty,
                              COUNT(*) FILTER (WHERE e.status = 'open') AS open
                         FROM preform_exceptions e WHERE e.shift_record_id = r.id) ex ON true
   WHERE r.factory_id = p_factory AND r.production_date BETWEEN p_from AND p_to
     AND (p_operator IS NULL OR r.operator_id = p_operator)
     AND (p_material IS NULL OR r.material_id = p_material)
     AND (p_shift IS NULL OR r.shift = p_shift)
     AND (p_status IS NULL OR r.status = p_status)
   ORDER BY r.production_date DESC, r.shift, public._pf_name(r.operator_id);
END;
$$;
REVOKE ALL ON FUNCTION public.preform_shift_report(uuid, date, date, uuid, uuid, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.preform_shift_report(uuid, date, date, uuid, uuid, text, text) TO authenticated;

-- Daily report: per operator and preform, opening once, the day's movements,
-- closing -- from the holding ledger, so shifts are never double counted.
CREATE OR REPLACE FUNCTION public.preform_daily_report(
  p_factory uuid, p_from date, p_to date, p_operator uuid DEFAULT NULL, p_material uuid DEFAULT NULL
) RETURNS TABLE(
  day date, operator_id uuid, operator text, material_id uuid, material text, pieces_per_bag numeric,
  opening numeric, received numeric, good_bottles numeric, damaged_preforms numeric, damaged_bottles numeric,
  other_losses numeric, reversed numeric, usage numeric, closing numeric, shifts bigint, pending_shifts bigint,
  qc_good numeric, qc_rejected numeric, stocked numeric
) LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NOT public._pf_can('view') THEN RAISE EXCEPTION 'Insufficient permissions'; END IF;
  IF p_from IS NULL OR p_to IS NULL OR p_from > p_to THEN RAISE EXCEPTION 'Pick a valid date range'; END IF;
  IF p_to - p_from > 366 THEN RAISE EXCEPTION 'Pick at most a year'; END IF;
  RETURN QUERY
  WITH pairs AS (
    SELECT DISTINCT mv.operator_id, mv.material_id FROM preform_movements mv
     WHERE mv.factory_id = p_factory AND mv.effective_date <= p_to
       AND (p_operator IS NULL OR mv.operator_id = p_operator) AND (p_material IS NULL OR mv.material_id = p_material)
    UNION
    SELECT DISTINCT r.operator_id, r.material_id FROM preform_shift_records r
     WHERE r.factory_id = p_factory AND r.production_date BETWEEN p_from AND p_to AND r.status <> 'reversed'
       AND (p_operator IS NULL OR r.operator_id = p_operator) AND (p_material IS NULL OR r.material_id = p_material)
  ), days AS (SELECT g::date AS d FROM generate_series(p_from, p_to, interval '1 day') g)
  SELECT dd.d, pr.operator_id, public._pf_name(pr.operator_id), pr.material_id, m.name, m.pieces_per_bag,
         COALESCE((SELECT SUM(x.quantity) FROM preform_movements x WHERE x.operator_id = pr.operator_id AND x.material_id = pr.material_id AND x.effective_date < dd.d), 0),
         COALESCE((SELECT SUM(x.quantity) FROM preform_movements x WHERE x.operator_id = pr.operator_id AND x.material_id = pr.material_id AND x.effective_date = dd.d AND x.movement_type IN ('issue_in', 'issue_reversed')), 0),
         COALESCE((SELECT -SUM(x.quantity) FROM preform_movements x WHERE x.operator_id = pr.operator_id AND x.material_id = pr.material_id AND x.effective_date = dd.d AND x.movement_type = 'good_bottles'), 0),
         COALESCE((SELECT -SUM(x.quantity) FROM preform_movements x WHERE x.operator_id = pr.operator_id AND x.material_id = pr.material_id AND x.effective_date = dd.d AND x.movement_type = 'damaged_preforms'), 0),
         COALESCE((SELECT -SUM(x.quantity) FROM preform_movements x WHERE x.operator_id = pr.operator_id AND x.material_id = pr.material_id AND x.effective_date = dd.d AND x.movement_type = 'damaged_bottles'), 0),
         COALESCE((SELECT -SUM(x.quantity) FROM preform_movements x WHERE x.operator_id = pr.operator_id AND x.material_id = pr.material_id AND x.effective_date = dd.d AND x.movement_type = 'other_losses'), 0),
         COALESCE((SELECT SUM(x.quantity) FROM preform_movements x WHERE x.operator_id = pr.operator_id AND x.material_id = pr.material_id AND x.effective_date = dd.d AND x.movement_type = 'usage_reversed'), 0),
         COALESCE((SELECT -SUM(x.quantity) FROM preform_movements x WHERE x.operator_id = pr.operator_id AND x.material_id = pr.material_id AND x.effective_date = dd.d AND x.movement_type IN ('good_bottles', 'damaged_preforms', 'damaged_bottles', 'other_losses', 'usage_reversed')), 0),
         COALESCE((SELECT SUM(x.quantity) FROM preform_movements x WHERE x.operator_id = pr.operator_id AND x.material_id = pr.material_id AND x.effective_date <= dd.d), 0),
         (SELECT COUNT(*) FROM preform_shift_records r WHERE r.operator_id = pr.operator_id AND r.material_id = pr.material_id AND r.production_date = dd.d AND r.status <> 'reversed'),
         (SELECT COUNT(*) FROM preform_shift_records r WHERE r.operator_id = pr.operator_id AND r.material_id = pr.material_id AND r.production_date = dd.d AND r.status IN ('draft', 'awaiting_inspection', 'awaiting_stocking')),
         (SELECT COALESCE(SUM(r.qc_good), 0) FROM preform_shift_records r WHERE r.operator_id = pr.operator_id AND r.material_id = pr.material_id AND r.production_date = dd.d AND r.status <> 'reversed'),
         (SELECT COALESCE(SUM(r.qc_rejected), 0) FROM preform_shift_records r WHERE r.operator_id = pr.operator_id AND r.material_id = pr.material_id AND r.production_date = dd.d AND r.status <> 'reversed'),
         (SELECT COALESCE(SUM(s.accepted_qty), 0) FROM preform_stockings s JOIN preform_shift_records r ON r.id = s.shift_record_id
           WHERE r.operator_id = pr.operator_id AND r.material_id = pr.material_id AND r.production_date = dd.d AND s.status = 'accepted')
    FROM pairs pr CROSS JOIN days dd JOIN raw_materials m ON m.id = pr.material_id
   ORDER BY dd.d DESC, 3, m.name;
END;
$$;
REVOKE ALL ON FUNCTION public.preform_daily_report(uuid, date, date, uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.preform_daily_report(uuid, date, date, uuid, uuid) TO authenticated;
