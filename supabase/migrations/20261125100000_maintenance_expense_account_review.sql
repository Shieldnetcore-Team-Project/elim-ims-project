-- Accounts review and approve/reject maintenance expenses. Existing expenses
-- enter the review queue; approved entries are locked, while rejected entries
-- return to review when corrected by Maintenance.

ALTER TABLE public.maintenance_expenses
  ADD COLUMN IF NOT EXISTS approval_status text NOT NULL DEFAULT 'pending_review',
  ADD COLUMN IF NOT EXISTS reviewed_by uuid REFERENCES auth.users(id),
  ADD COLUMN IF NOT EXISTS reviewed_by_name text,
  ADD COLUMN IF NOT EXISTS reviewed_at timestamptz,
  ADD COLUMN IF NOT EXISTS review_note text;

ALTER TABLE public.maintenance_expenses
  DROP CONSTRAINT IF EXISTS maintenance_expenses_approval_status_check;
ALTER TABLE public.maintenance_expenses
  ADD CONSTRAINT maintenance_expenses_approval_status_check
  CHECK (approval_status IN ('pending_review', 'approved', 'rejected'));

DROP POLICY IF EXISTS "maintenance read expenses" ON public.maintenance_expenses;
CREATE POLICY "maintenance read expenses" ON public.maintenance_expenses
  FOR SELECT TO authenticated
  USING (
    public.has_permission(auth.uid(), 'logistics'::module_key, 'read'::action_key)
    OR public.is_requisition_accounts(auth.uid())
  );

CREATE OR REPLACE FUNCTION public.guard_reviewed_maintenance_expense()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF OLD.approval_status = 'approved' THEN
    RAISE EXCEPTION 'Approved maintenance expenses cannot be edited';
  ELSIF OLD.approval_status = 'rejected' THEN
    NEW.approval_status := 'pending_review';
    NEW.reviewed_by := NULL;
    NEW.reviewed_by_name := NULL;
    NEW.reviewed_at := NULL;
    NEW.review_note := NULL;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS guard_reviewed_maintenance_expense ON public.maintenance_expenses;
CREATE TRIGGER guard_reviewed_maintenance_expense
  BEFORE UPDATE ON public.maintenance_expenses
  FOR EACH ROW EXECUTE FUNCTION public.guard_reviewed_maintenance_expense();

CREATE OR REPLACE FUNCTION public.delete_maintenance_expense(p_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_status text;
BEGIN
  IF NOT public.has_permission(auth.uid(), 'logistics'::module_key, 'delete'::action_key) THEN
    RAISE EXCEPTION 'Insufficient permissions';
  END IF;

  DELETE FROM public.maintenance_expenses
  WHERE id = p_id AND approval_status <> 'approved';
  IF FOUND THEN RETURN; END IF;

  SELECT approval_status INTO v_status
  FROM public.maintenance_expenses
  WHERE id = p_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Expense not found'; END IF;
  RAISE EXCEPTION 'Approved maintenance expenses cannot be deleted';
END;
$$;
GRANT EXECUTE ON FUNCTION public.delete_maintenance_expense(uuid) TO authenticated;

CREATE OR REPLACE FUNCTION public.decide_maintenance_expense(
  p_id uuid,
  p_approve boolean,
  p_note text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_name text := (SELECT full_name FROM profiles WHERE id = auth.uid());
  v_row public.maintenance_expenses%ROWTYPE;
  v_note text := NULLIF(btrim(p_note), '');
  v_status text;
BEGIN
  IF p_approve IS NULL THEN
    RAISE EXCEPTION 'Choose approve or reject';
  END IF;
  IF NOT public.is_requisition_accounts(v_uid) THEN
    RAISE EXCEPTION 'Only Accounts may review maintenance expenses';
  END IF;

  SELECT * INTO v_row
  FROM public.maintenance_expenses
  WHERE id = p_id
  FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Maintenance expense not found'; END IF;
  IF v_row.recorded_by = v_uid AND NOT public.has_role(v_uid, 'super_admin') THEN
    RAISE EXCEPTION 'You cannot review an expense you recorded';
  END IF;
  IF v_row.approval_status <> 'pending_review' THEN
    RAISE EXCEPTION 'Expense is already %', replace(v_row.approval_status, '_', ' ');
  END IF;
  IF NOT p_approve AND v_note IS NULL THEN
    RAISE EXCEPTION 'A reason is required to reject';
  END IF;

  v_status := CASE WHEN p_approve THEN 'approved' ELSE 'rejected' END;
  UPDATE public.maintenance_expenses
  SET approval_status = v_status,
      reviewed_by = v_uid,
      reviewed_by_name = v_name,
      reviewed_at = now(),
      review_note = v_note
  WHERE id = p_id;

  RETURN jsonb_build_object('id', p_id, 'approval_status', v_status);
END;
$$;
GRANT EXECUTE ON FUNCTION public.decide_maintenance_expense(uuid, boolean, text) TO authenticated;

NOTIFY pgrst, 'reload schema';
