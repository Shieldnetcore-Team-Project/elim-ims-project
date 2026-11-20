-- ============================================================================
-- Maintenance › Expenses
-- ----------------------------------------------------------------------------
-- The user asked (2026-11-20) for an Expenses tab on the Maintenance page so
-- the maintenance user can record expenses under the factory's own expense
-- heads (Transportation, Fuel, Gas, Engine Oil, … Gift). The list of heads
-- lives in the app (src/components/maintenance/expenses.tsx); the table keeps
-- the head's name as text so a head can be added or renamed without a
-- migration.
--
-- Its own table, not public.expenses: the maintenance user (Austin) has the
-- main Expenses page switched off on purpose (20261023200000). Access follows
-- the Maintenance ('logistics') rights: read = see the tab, create = record,
-- edit = correct, delete = remove. Recorded at once, no approval.
-- Idempotent.
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.maintenance_expenses (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  factory_id uuid NOT NULL REFERENCES public.factories(id) ON DELETE CASCADE,
  expense_number text NOT NULL,
  expense_date date NOT NULL DEFAULT CURRENT_DATE,
  category text NOT NULL CHECK (btrim(category) <> ''),
  description text,
  amount numeric(14,2) NOT NULL CHECK (amount > 0),
  paid_to text,
  payment_method text,
  receipt_ref text,
  recorded_by uuid REFERENCES auth.users(id),
  recorded_by_name text,
  updated_by_name text,
  updated_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (factory_id, expense_number)
);
CREATE INDEX IF NOT EXISTS maintenance_expenses_factory_idx
  ON public.maintenance_expenses(factory_id, expense_date DESC);
GRANT SELECT ON public.maintenance_expenses TO authenticated;
GRANT ALL ON public.maintenance_expenses TO service_role;
ALTER TABLE public.maintenance_expenses ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "maintenance read expenses" ON public.maintenance_expenses;
CREATE POLICY "maintenance read expenses" ON public.maintenance_expenses FOR SELECT TO authenticated
  USING (public.has_permission(auth.uid(), 'logistics'::module_key, 'read'::action_key));

-- Record a new expense (no id) or correct one (id given).
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
    v_number := 'MEX-' || to_char(now(),'YYYYMMDD') || '-'
                || lpad(((floor(random()*99999))::int)::text, 5, '0');
    INSERT INTO maintenance_expenses(factory_id, expense_number, expense_date, category,
                                     description, amount, paid_to, payment_method, receipt_ref,
                                     recorded_by, recorded_by_name)
    VALUES (v_factory, v_number, v_date, v_category,
            NULLIF(btrim(payload->>'description'),''), v_amount,
            NULLIF(btrim(payload->>'paid_to'),''),
            NULLIF(btrim(payload->>'payment_method'),''),
            NULLIF(btrim(payload->>'receipt_ref'),''),
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
           paid_to = NULLIF(btrim(payload->>'paid_to'),''),
           payment_method = NULLIF(btrim(payload->>'payment_method'),''),
           receipt_ref = NULLIF(btrim(payload->>'receipt_ref'),''),
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

CREATE OR REPLACE FUNCTION public.delete_maintenance_expense(p_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT public.has_permission(auth.uid(), 'logistics'::module_key, 'delete'::action_key) THEN
    RAISE EXCEPTION 'Insufficient permissions';
  END IF;
  DELETE FROM maintenance_expenses WHERE id = p_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Expense not found'; END IF;
END;
$$;
GRANT EXECUTE ON FUNCTION public.delete_maintenance_expense(uuid) TO authenticated;

-- Live updates: another user's entry shows without a refresh.
DO $$
BEGIN
  IF NOT EXISTS (
       SELECT 1 FROM pg_publication_tables
        WHERE pubname = 'supabase_realtime' AND schemaname = 'public'
          AND tablename = 'maintenance_expenses') THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.maintenance_expenses;
  END IF;
END;
$$;

NOTIFY pgrst, 'reload schema';
