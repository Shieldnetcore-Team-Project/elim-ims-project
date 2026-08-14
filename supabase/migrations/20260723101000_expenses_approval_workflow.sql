
-- Expenses spec calls for a "person who requested the expense" distinct from the person who
-- recorded it, plus a real approval_status/approved_at pair instead of the free-text
-- approved_by field silently meaning "approved". Existing rows that already had an
-- approved_by filled in are backfilled to 'approved' so they don't all appear newly pending.

ALTER TABLE public.expenses ADD COLUMN IF NOT EXISTS requested_by_name text;
ALTER TABLE public.expenses ADD COLUMN IF NOT EXISTS approval_status text NOT NULL DEFAULT 'pending';
ALTER TABLE public.expenses DROP CONSTRAINT IF EXISTS expenses_approval_status_check;
ALTER TABLE public.expenses ADD CONSTRAINT expenses_approval_status_check
  CHECK (approval_status IN ('pending', 'approved', 'rejected'));
ALTER TABLE public.expenses ADD COLUMN IF NOT EXISTS approved_at timestamptz;

UPDATE public.expenses SET approval_status = 'approved', approved_at = COALESCE(approved_at, created_at)
WHERE approved_by IS NOT NULL AND approval_status = 'pending';

-- Seed the categories called out in the spec for every existing factory. New factories aren't
-- provisioned through the app (no factory-creation UI), so there's no ongoing trigger needed.
INSERT INTO public.expense_categories (factory_id, name)
SELECT f.id, c.name FROM public.factories f
CROSS JOIN (VALUES
  ('Office Expenses'), ('Operational Expenses'), ('Transportation'),
  ('Utilities'), ('Maintenance'), ('Other Expenses')
) AS c(name)
WHERE NOT EXISTS (
  SELECT 1 FROM public.expense_categories ec WHERE ec.factory_id = f.id AND ec.name = c.name
);

CREATE OR REPLACE FUNCTION public.approve_expense(p_id uuid, p_approver_name text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE v_row expenses%ROWTYPE;
BEGIN
  IF p_approver_name IS NULL OR btrim(p_approver_name) = '' THEN RAISE EXCEPTION 'Approver name is required'; END IF;
  SELECT * INTO v_row FROM expenses WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Expense not found'; END IF;
  IF v_row.approval_status <> 'pending' THEN RAISE EXCEPTION 'Expense is already %', v_row.approval_status; END IF;

  UPDATE expenses SET approval_status = 'approved', approved_by = p_approver_name, approved_at = now() WHERE id = p_id;
  RETURN jsonb_build_object('approved', true);
END;
$$;
GRANT EXECUTE ON FUNCTION public.approve_expense(uuid, text) TO anon, authenticated;

CREATE OR REPLACE FUNCTION public.reject_expense(p_id uuid, p_approver_name text, p_reason text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE v_row expenses%ROWTYPE;
BEGIN
  IF p_approver_name IS NULL OR btrim(p_approver_name) = '' THEN RAISE EXCEPTION 'Approver name is required'; END IF;
  SELECT * INTO v_row FROM expenses WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Expense not found'; END IF;
  IF v_row.approval_status <> 'pending' THEN RAISE EXCEPTION 'Expense is already %', v_row.approval_status; END IF;

  UPDATE expenses SET
    approval_status = 'rejected', approved_by = p_approver_name, approved_at = now(),
    remarks = CASE WHEN p_reason IS NOT NULL AND btrim(p_reason) <> ''
                   THEN COALESCE(remarks || E'\n', '') || 'Rejected: ' || p_reason ELSE remarks END
  WHERE id = p_id;
  RETURN jsonb_build_object('rejected', true);
END;
$$;
GRANT EXECUTE ON FUNCTION public.reject_expense(uuid, text, text) TO anon, authenticated;
