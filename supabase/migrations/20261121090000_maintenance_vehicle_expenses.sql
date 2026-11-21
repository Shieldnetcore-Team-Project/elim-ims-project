-- ============================================================================
-- Maintenance › Vehicle Expenses
-- ----------------------------------------------------------------------------
-- The user asked (2026-11-21) to record expenses per vehicle like the
-- factory's "DAILY VEHICLE EXPENSES FOR <PLATE> <DRIVERS>" sheet: a list of
-- particulars (bolt and washer, gasket, oil filter, 8 litres of engine oil at
-- #3,400 ...) then the fuel bought (113 litres at #1,400 ...), totals per
-- section and a grand total, printed per vehicle.
--
-- Same table as Maintenance › Expenses, so these lines also count in the
-- expense heads (fuel lines under FUEL, parts under VEHICLE MAINT. etc.).
-- A vehicle line carries the vehicle, the driver(s), whether it is a part or
-- fuel, and the quantity (litres) and unit price. The amount is entered as
-- on the sheet (it is not forced to qty x price: the sheet's fuel amounts
-- differ from litres x price).
-- Needs 20261120090000_maintenance_expenses.sql first. Idempotent.
-- ============================================================================

ALTER TABLE public.maintenance_expenses
  ADD COLUMN IF NOT EXISTS vehicle_id uuid REFERENCES public.vehicles(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS driver_name text,
  ADD COLUMN IF NOT EXISTS line_kind text,
  ADD COLUMN IF NOT EXISTS quantity numeric(14,2),
  ADD COLUMN IF NOT EXISTS unit_price numeric(14,2);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'maintenance_expenses_line_kind_chk') THEN
    ALTER TABLE public.maintenance_expenses
      ADD CONSTRAINT maintenance_expenses_line_kind_chk
      CHECK (line_kind IS NULL OR line_kind IN ('part','fuel'));
  END IF;
END;
$$;

CREATE INDEX IF NOT EXISTS maintenance_expenses_vehicle_idx
  ON public.maintenance_expenses(vehicle_id, expense_date) WHERE vehicle_id IS NOT NULL;

-- A fresh MEX- number not yet used in the factory.
CREATE OR REPLACE FUNCTION public.next_maintenance_expense_number(p_factory uuid)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v text;
BEGIN
  LOOP
    v := 'MEX-' || to_char(now(),'YYYYMMDD') || '-'
         || lpad(((floor(random()*99999))::int)::text, 5, '0');
    EXIT WHEN NOT EXISTS (
      SELECT 1 FROM maintenance_expenses WHERE factory_id = p_factory AND expense_number = v);
  END LOOP;
  RETURN v;
END;
$$;

-- Record a new expense (no id) or correct one (id given). Vehicle fields are
-- only changed on a correction when the payload carries them, so editing a
-- vehicle line from the general Expenses tab keeps its vehicle.
CREATE OR REPLACE FUNCTION public.save_maintenance_expense(payload jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_id uuid := NULLIF(payload->>'id','')::uuid;
  v_factory uuid := (payload->>'factory_id')::uuid;
  v_category text := NULLIF(btrim(payload->>'category'),'');
  v_amount numeric := NULLIF(payload->>'amount','')::numeric;
  v_date date := COALESCE(NULLIF(payload->>'expense_date','')::date, CURRENT_DATE);
  v_name text := (SELECT full_name FROM profiles WHERE id = v_uid);
  v_kind text := NULLIF(payload->>'line_kind','');
  v_number text;
BEGIN
  IF v_factory IS NULL THEN RAISE EXCEPTION 'factory_id required'; END IF;
  IF v_category IS NULL THEN RAISE EXCEPTION 'Choose a category'; END IF;
  IF v_amount IS NULL OR v_amount <= 0 THEN RAISE EXCEPTION 'Enter an amount above 0'; END IF;
  IF v_date > CURRENT_DATE + 1 THEN RAISE EXCEPTION 'The date cannot be in the future'; END IF;

  IF v_id IS NULL THEN
    IF NOT public.has_permission(v_uid, 'logistics'::module_key, 'create'::action_key) THEN
      RAISE EXCEPTION 'Insufficient permissions';
    END IF;
    v_number := public.next_maintenance_expense_number(v_factory);
    INSERT INTO maintenance_expenses(factory_id, expense_number, expense_date, category,
                                     description, amount, paid_to, payment_method, receipt_ref,
                                     vehicle_id, driver_name, line_kind, quantity, unit_price,
                                     recorded_by, recorded_by_name)
    VALUES (v_factory, v_number, v_date, v_category,
            NULLIF(btrim(payload->>'description'),''), v_amount,
            NULLIF(btrim(payload->>'paid_to'),''),
            NULLIF(btrim(payload->>'payment_method'),''),
            NULLIF(btrim(payload->>'receipt_ref'),''),
            NULLIF(payload->>'vehicle_id','')::uuid,
            NULLIF(btrim(payload->>'driver_name'),''),
            v_kind,
            NULLIF(payload->>'quantity','')::numeric,
            NULLIF(payload->>'unit_price','')::numeric,
            v_uid, v_name)
    RETURNING id INTO v_id;
  ELSE
    IF NOT public.has_permission(v_uid, 'logistics'::module_key, 'edit'::action_key) THEN
      RAISE EXCEPTION 'Insufficient permissions';
    END IF;
    UPDATE maintenance_expenses
       SET expense_date = v_date,
           category = v_category,
           description = NULLIF(btrim(payload->>'description'),''),
           amount = v_amount,
           paid_to = CASE WHEN payload ? 'paid_to' THEN NULLIF(btrim(payload->>'paid_to'),'') ELSE paid_to END,
           payment_method = CASE WHEN payload ? 'payment_method' THEN NULLIF(btrim(payload->>'payment_method'),'') ELSE payment_method END,
           receipt_ref = CASE WHEN payload ? 'receipt_ref' THEN NULLIF(btrim(payload->>'receipt_ref'),'') ELSE receipt_ref END,
           vehicle_id = CASE WHEN payload ? 'vehicle_id' THEN NULLIF(payload->>'vehicle_id','')::uuid ELSE vehicle_id END,
           driver_name = CASE WHEN payload ? 'driver_name' THEN NULLIF(btrim(payload->>'driver_name'),'') ELSE driver_name END,
           line_kind = CASE WHEN payload ? 'line_kind' THEN v_kind ELSE line_kind END,
           quantity = CASE WHEN payload ? 'quantity' THEN NULLIF(payload->>'quantity','')::numeric ELSE quantity END,
           unit_price = CASE WHEN payload ? 'unit_price' THEN NULLIF(payload->>'unit_price','')::numeric ELSE unit_price END,
           updated_by_name = v_name,
           updated_at = now()
     WHERE id = v_id AND factory_id = v_factory
     RETURNING expense_number INTO v_number;
    IF v_number IS NULL THEN RAISE EXCEPTION 'Expense not found'; END IF;
  END IF;

  RETURN jsonb_build_object('id', v_id, 'expense_number', v_number);
END;
$$;
GRANT EXECUTE ON FUNCTION public.save_maintenance_expense(jsonb) TO authenticated;

-- One vehicle's sheet in one save: every particulars and fuel line together,
-- all or nothing. payload = { factory_id, vehicle_id, expense_date,
-- driver_name, payment_method, lines: [{ kind: 'part'|'fuel', category,
-- description, quantity, unit_price, amount }] }.
CREATE OR REPLACE FUNCTION public.save_vehicle_expenses(payload jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_factory uuid := (payload->>'factory_id')::uuid;
  v_vehicle uuid := NULLIF(payload->>'vehicle_id','')::uuid;
  v_date date := COALESCE(NULLIF(payload->>'expense_date','')::date, CURRENT_DATE);
  v_name text := (SELECT full_name FROM profiles WHERE id = v_uid);
  v_line jsonb;
  v_kind text;
  v_amount numeric;
  v_count int := 0;
  v_total numeric := 0;
BEGIN
  IF NOT public.has_permission(v_uid, 'logistics'::module_key, 'create'::action_key) THEN
    RAISE EXCEPTION 'Insufficient permissions';
  END IF;
  IF v_factory IS NULL THEN RAISE EXCEPTION 'factory_id required'; END IF;
  IF v_vehicle IS NULL THEN RAISE EXCEPTION 'Choose a vehicle'; END IF;
  IF NOT EXISTS (SELECT 1 FROM vehicles WHERE id = v_vehicle AND factory_id = v_factory) THEN
    RAISE EXCEPTION 'Vehicle not found';
  END IF;
  IF v_date > CURRENT_DATE + 1 THEN RAISE EXCEPTION 'The date cannot be in the future'; END IF;
  IF jsonb_typeof(payload->'lines') IS DISTINCT FROM 'array'
     OR jsonb_array_length(payload->'lines') = 0 THEN
    RAISE EXCEPTION 'Add at least one line';
  END IF;

  FOR v_line IN SELECT * FROM jsonb_array_elements(payload->'lines') LOOP
    v_kind := COALESCE(NULLIF(v_line->>'kind',''), 'part');
    IF v_kind NOT IN ('part','fuel') THEN RAISE EXCEPTION 'Unknown line kind %', v_kind; END IF;
    v_amount := NULLIF(v_line->>'amount','')::numeric;
    IF v_amount IS NULL OR v_amount <= 0 THEN RAISE EXCEPTION 'Every line needs an amount above 0'; END IF;
    IF v_kind = 'part' AND NULLIF(btrim(v_line->>'description'),'') IS NULL THEN
      RAISE EXCEPTION 'Every particulars line needs a description';
    END IF;
    IF v_kind = 'fuel' AND COALESCE(NULLIF(v_line->>'quantity','')::numeric, 0) <= 0 THEN
      RAISE EXCEPTION 'Every fuel line needs the litres';
    END IF;

    INSERT INTO maintenance_expenses(factory_id, expense_number, expense_date, category,
                                     description, amount, payment_method,
                                     vehicle_id, driver_name, line_kind, quantity, unit_price,
                                     recorded_by, recorded_by_name)
    VALUES (v_factory, public.next_maintenance_expense_number(v_factory), v_date,
            COALESCE(NULLIF(btrim(v_line->>'category'),''),
                     CASE WHEN v_kind = 'fuel' THEN 'FUEL' ELSE 'VEHICLE MAINT.' END),
            NULLIF(btrim(v_line->>'description'),''), v_amount,
            NULLIF(btrim(payload->>'payment_method'),''),
            v_vehicle, NULLIF(btrim(payload->>'driver_name'),''), v_kind,
            NULLIF(v_line->>'quantity','')::numeric,
            NULLIF(v_line->>'unit_price','')::numeric,
            v_uid, v_name);
    v_count := v_count + 1;
    v_total := v_total + v_amount;
  END LOOP;

  RETURN jsonb_build_object('lines', v_count, 'total', v_total);
END;
$$;
GRANT EXECUTE ON FUNCTION public.save_vehicle_expenses(jsonb) TO authenticated;

NOTIFY pgrst, 'reload schema';
