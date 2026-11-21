-- ============================================================================
-- Maintenance › Expenses: TIRE head with tire type and size
-- ----------------------------------------------------------------------------
-- The user asked (2026-11-21) for a TIRE head; when chosen, the tire type and
-- size are entered too. Users can also type their own heads (category is
-- already free text, so that needs nothing here).
-- Needs 20261120090000 and 20261121090000 first. Idempotent.
-- ============================================================================

ALTER TABLE public.maintenance_expenses
  ADD COLUMN IF NOT EXISTS tire_type text,
  ADD COLUMN IF NOT EXISTS tire_size text;

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
                                     tire_type, tire_size,
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
            NULLIF(btrim(payload->>'tire_type'),''),
            NULLIF(btrim(payload->>'tire_size'),''),
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
           tire_type = CASE WHEN payload ? 'tire_type' THEN NULLIF(btrim(payload->>'tire_type'),'') ELSE tire_type END,
           tire_size = CASE WHEN payload ? 'tire_size' THEN NULLIF(btrim(payload->>'tire_size'),'') ELSE tire_size END,
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

NOTIFY pgrst, 'reload schema';
