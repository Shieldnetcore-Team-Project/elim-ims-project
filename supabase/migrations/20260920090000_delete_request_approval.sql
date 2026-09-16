-- ============================================================================
-- DELETE REQUEST / APPROVAL — all record deletions go to Admin, with a reason
-- ----------------------------------------------------------------------------
-- Today, deleting an employee/vehicle/driver/sales rep/expense/cash
-- transaction/employee document/packaging rule is an immediate client-side
-- .delete() gated only by the 'delete' action on the module. This adds a
-- generic request/approve/reject layer (one delete_requests table + 3 RPCs,
-- following the maker-checker pattern in 20260815090000/20260815092000) and
-- closes the direct-delete RLS path on all 8 tables so it can't be bypassed.
--
-- Approval is scoped to Admin (super_admin) only, not a per-module 'approve'
-- tier — confirmed with the user, and consistent with the existing
-- "roles delete" policy which is already super_admin-only. The `roles` table
-- itself is deliberately NOT included here: it's already super_admin-only
-- and system-role-protected, so routing it through self-request/self-approve
-- adds friction without adding safety.
-- ============================================================================

-- ============ 1. delete_requests table ============
-- IF NOT EXISTS / DROP-then-CREATE guards throughout this file make it safe
-- to re-run after a partial failure (e.g. the earlier has_permission
-- ambiguity error) without erroring on "already exists".
CREATE TABLE IF NOT EXISTS public.delete_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  factory_id uuid REFERENCES public.factories(id),
  table_name text NOT NULL CHECK (table_name IN (
    'employees','employee_documents','sales_reps','vehicles','drivers',
    'expenses','cash_transactions','product_units'
  )),
  entity_id uuid NOT NULL,
  entity_label text NOT NULL,
  module public.module_key NOT NULL,
  payload jsonb,
  reason text NOT NULL,
  requested_by uuid NOT NULL REFERENCES auth.users(id),
  requested_at timestamptz NOT NULL DEFAULT now(),
  review_status public.review_status NOT NULL DEFAULT 'pending',
  reviewed_by uuid REFERENCES auth.users(id),
  reviewed_at timestamptz,
  review_reason text
);
GRANT SELECT ON public.delete_requests TO authenticated;
GRANT ALL ON public.delete_requests TO service_role;
ALTER TABLE public.delete_requests ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "delete requests read" ON public.delete_requests;
CREATE POLICY "delete requests read" ON public.delete_requests FOR SELECT TO authenticated
  USING (public.has_role(auth.uid(), 'super_admin') OR requested_by = auth.uid());
-- INSERT/UPDATE are RPC-only (request_delete/approve_delete/reject_delete are
-- SECURITY DEFINER); no direct client INSERT/UPDATE policy is granted so
-- review state can't be forged client-side.

-- Only one pending request per entity at a time; a resolved request doesn't
-- block re-requesting the same entity later.
DROP INDEX IF EXISTS delete_requests_one_pending;
CREATE UNIQUE INDEX delete_requests_one_pending ON public.delete_requests (table_name, entity_id)
  WHERE review_status = 'pending';

-- ============ 2. request_delete() ============
CREATE OR REPLACE FUNCTION public.request_delete(p_table_name text, p_entity_id uuid, p_reason text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_module public.module_key;
  v_factory uuid;
  v_label text;
  v_payload jsonb;
  v_id uuid;
  v_admin_id uuid;
BEGIN
  IF p_reason IS NULL OR btrim(p_reason) = '' THEN
    RAISE EXCEPTION 'A reason is required to request a deletion';
  END IF;

  IF EXISTS (
    SELECT 1 FROM delete_requests
    WHERE table_name = p_table_name AND entity_id = p_entity_id AND review_status = 'pending'
  ) THEN
    RAISE EXCEPTION 'A deletion request for this record is already pending';
  END IF;

  IF p_table_name = 'employees' THEN
    v_module := 'employees'::module_key;
    SELECT factory_id, full_name, jsonb_build_object('photo_url', photo_url)
      INTO v_factory, v_label, v_payload
      FROM employees WHERE id = p_entity_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Employee not found'; END IF;

  ELSIF p_table_name = 'employee_documents' THEN
    v_module := 'employees'::module_key;
    SELECT factory_id, file_name, jsonb_build_object('file_path', file_path)
      INTO v_factory, v_label, v_payload
      FROM employee_documents WHERE id = p_entity_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Document not found'; END IF;

  ELSIF p_table_name = 'sales_reps' THEN
    v_module := 'distribution'::module_key;
    SELECT factory_id, full_name INTO v_factory, v_label
      FROM sales_reps WHERE id = p_entity_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Sales rep not found'; END IF;

  ELSIF p_table_name = 'vehicles' THEN
    v_module := 'logistics'::module_key;
    SELECT factory_id, plate_number INTO v_factory, v_label
      FROM vehicles WHERE id = p_entity_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Vehicle not found'; END IF;

  ELSIF p_table_name = 'drivers' THEN
    v_module := 'logistics'::module_key;
    SELECT factory_id, full_name INTO v_factory, v_label
      FROM drivers WHERE id = p_entity_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Driver not found'; END IF;

  ELSIF p_table_name = 'expenses' THEN
    v_module := 'expenses'::module_key;
    SELECT factory_id, COALESCE(description, 'Expense'), jsonb_build_object('attachment_url', attachment_url)
      INTO v_factory, v_label, v_payload
      FROM expenses WHERE id = p_entity_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Expense not found'; END IF;

  ELSIF p_table_name = 'cash_transactions' THEN
    v_module := 'receipts-payments'::module_key;
    SELECT factory_id, COALESCE(description, transaction_number) INTO v_factory, v_label
      FROM cash_transactions WHERE id = p_entity_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Cash transaction not found'; END IF;

  ELSIF p_table_name = 'product_units' THEN
    v_module := 'finished-goods'::module_key;
    SELECT p.factory_id, pu.packaging_unit || ' (' || pu.base_unit || ')'
      INTO v_factory, v_label
      FROM product_units pu JOIN products p ON p.id = pu.product_id
      WHERE pu.id = p_entity_id FOR UPDATE OF pu;
    IF NOT FOUND THEN RAISE EXCEPTION 'Packaging rule not found'; END IF;

  ELSE
    RAISE EXCEPTION 'Unsupported table for delete requests: %', p_table_name;
  END IF;

  IF NOT public.has_permission(v_uid, v_module, 'delete'::action_key) THEN
    RAISE EXCEPTION 'Insufficient permissions';
  END IF;

  INSERT INTO delete_requests(factory_id, table_name, entity_id, entity_label, module, payload, reason, requested_by)
  VALUES (v_factory, p_table_name, p_entity_id, v_label, v_module, v_payload, p_reason, v_uid)
  RETURNING id INTO v_id;

  FOR v_admin_id IN SELECT user_id FROM user_roles WHERE role = 'super_admin' LOOP
    INSERT INTO notifications(user_id, factory_id, title, body)
    VALUES (v_admin_id, v_factory, 'Deletion requested',
            initcap(replace(p_table_name, '_', ' ')) || ' "' || v_label || '" — reason: ' || p_reason);
  END LOOP;

  INSERT INTO audit_logs(user_id, factory_id, action, entity, entity_id, old_value, new_value)
  VALUES (v_uid, v_factory, 'request_delete', p_table_name, p_entity_id::text,
          NULL, jsonb_build_object('reason', p_reason, 'label', v_label));

  RETURN jsonb_build_object('id', v_id);
END;
$$;
GRANT EXECUTE ON FUNCTION public.request_delete(text, uuid, text) TO authenticated;

-- ============ 3. approve_delete() ============
CREATE OR REPLACE FUNCTION public.approve_delete(p_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_req delete_requests%ROWTYPE;
BEGIN
  IF NOT public.has_role(v_uid, 'super_admin') THEN
    RAISE EXCEPTION 'Only an admin can approve a deletion request';
  END IF;

  SELECT * INTO v_req FROM delete_requests WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Request not found'; END IF;
  IF v_req.review_status <> 'pending' THEN RAISE EXCEPTION 'Request is already %', v_req.review_status; END IF;

  IF v_req.table_name = 'employees' THEN
    DELETE FROM employees WHERE id = v_req.entity_id;
  ELSIF v_req.table_name = 'employee_documents' THEN
    DELETE FROM employee_documents WHERE id = v_req.entity_id;
  ELSIF v_req.table_name = 'sales_reps' THEN
    DELETE FROM sales_reps WHERE id = v_req.entity_id;
  ELSIF v_req.table_name = 'vehicles' THEN
    DELETE FROM vehicles WHERE id = v_req.entity_id;
  ELSIF v_req.table_name = 'drivers' THEN
    DELETE FROM drivers WHERE id = v_req.entity_id;
  ELSIF v_req.table_name = 'expenses' THEN
    DELETE FROM expenses WHERE id = v_req.entity_id;
  ELSIF v_req.table_name = 'cash_transactions' THEN
    DELETE FROM cash_transactions WHERE id = v_req.entity_id;
  ELSIF v_req.table_name = 'product_units' THEN
    DELETE FROM product_units WHERE id = v_req.entity_id;
  ELSE
    RAISE EXCEPTION 'Unsupported table for delete requests: %', v_req.table_name;
  END IF;

  UPDATE delete_requests SET review_status = 'approved', reviewed_by = v_uid, reviewed_at = now()
  WHERE id = p_id;

  INSERT INTO notifications(user_id, factory_id, title, body)
  VALUES (v_req.requested_by, v_req.factory_id, 'Deletion approved',
          initcap(replace(v_req.table_name, '_', ' ')) || ' "' || v_req.entity_label || '" was deleted.');

  INSERT INTO audit_logs(user_id, factory_id, action, entity, entity_id, old_value, new_value)
  VALUES (v_uid, v_req.factory_id, 'approve_delete', v_req.table_name, v_req.entity_id::text,
          jsonb_build_object('label', v_req.entity_label, 'reason', v_req.reason, 'requested_by', v_req.requested_by),
          jsonb_build_object('deleted', true));

  RETURN jsonb_build_object('approved', true, 'payload', v_req.payload);
END;
$$;
GRANT EXECUTE ON FUNCTION public.approve_delete(uuid) TO authenticated;

-- ============ 4. reject_delete() ============
CREATE OR REPLACE FUNCTION public.reject_delete(p_id uuid, p_reason text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_req delete_requests%ROWTYPE;
BEGIN
  IF NOT public.has_role(v_uid, 'super_admin') THEN
    RAISE EXCEPTION 'Only an admin can reject a deletion request';
  END IF;

  SELECT * INTO v_req FROM delete_requests WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Request not found'; END IF;
  IF v_req.review_status <> 'pending' THEN RAISE EXCEPTION 'Request is already %', v_req.review_status; END IF;

  UPDATE delete_requests SET review_status = 'rejected', reviewed_by = v_uid, reviewed_at = now(), review_reason = p_reason
  WHERE id = p_id;

  INSERT INTO notifications(user_id, factory_id, title, body)
  VALUES (v_req.requested_by, v_req.factory_id, 'Deletion rejected',
          initcap(replace(v_req.table_name, '_', ' ')) || ' "' || v_req.entity_label || '" was not deleted' ||
          CASE WHEN p_reason IS NOT NULL AND btrim(p_reason) <> '' THEN ': ' || p_reason ELSE '.' END);

  RETURN jsonb_build_object('rejected', true);
END;
$$;
GRANT EXECUTE ON FUNCTION public.reject_delete(uuid, text) TO authenticated;

-- ============ 5. close the direct-delete RLS path on all 8 tables ============

-- employees / employee_documents: split "FOR ALL" into INSERT + UPDATE only.
-- Explicit ::module_key/::action_key casts throughout this section: with both
-- the legacy has_permission(uuid, module_key, access_level) and the current
-- has_permission(uuid, module_key, action_key) overloads live in the
-- database, bare text literals are ambiguous (the exact bug fixed in
-- 20260826093000_fix_has_permission_overload_ambiguity_and_public_execute.sql).
DROP POLICY IF EXISTS "employees write" ON public.employees;
DROP POLICY IF EXISTS "employees insert" ON public.employees;
DROP POLICY IF EXISTS "employees update" ON public.employees;
CREATE POLICY "employees insert" ON public.employees FOR INSERT TO authenticated
  WITH CHECK (public.has_permission(auth.uid(), 'employees'::module_key, 'write'::action_key));
CREATE POLICY "employees update" ON public.employees FOR UPDATE TO authenticated
  USING (public.has_permission(auth.uid(), 'employees'::module_key, 'write'::action_key))
  WITH CHECK (public.has_permission(auth.uid(), 'employees'::module_key, 'write'::action_key));
REVOKE DELETE ON public.employees FROM authenticated, anon;

DROP POLICY IF EXISTS "employees write documents" ON public.employee_documents;
DROP POLICY IF EXISTS "employees insert documents" ON public.employee_documents;
DROP POLICY IF EXISTS "employees update documents" ON public.employee_documents;
CREATE POLICY "employees insert documents" ON public.employee_documents FOR INSERT TO authenticated
  WITH CHECK (public.has_permission(auth.uid(), 'employees'::module_key, 'write'::action_key));
CREATE POLICY "employees update documents" ON public.employee_documents FOR UPDATE TO authenticated
  USING (public.has_permission(auth.uid(), 'employees'::module_key, 'write'::action_key))
  WITH CHECK (public.has_permission(auth.uid(), 'employees'::module_key, 'write'::action_key));
REVOKE DELETE ON public.employee_documents FROM authenticated, anon;

-- sales_reps: just drop the standalone delete policy (insert/update already separate).
DROP POLICY IF EXISTS "sales reps delete" ON public.sales_reps;
REVOKE DELETE ON public.sales_reps FROM authenticated;

-- vehicles / drivers: split "FOR ALL" into INSERT + UPDATE only.
DROP POLICY IF EXISTS "logistics write vehicles" ON public.vehicles;
DROP POLICY IF EXISTS "logistics insert vehicles" ON public.vehicles;
DROP POLICY IF EXISTS "logistics update vehicles" ON public.vehicles;
CREATE POLICY "logistics insert vehicles" ON public.vehicles FOR INSERT TO authenticated
  WITH CHECK (public.has_permission(auth.uid(), 'logistics'::module_key, 'write'::action_key));
CREATE POLICY "logistics update vehicles" ON public.vehicles FOR UPDATE TO authenticated
  USING (public.has_permission(auth.uid(), 'logistics'::module_key, 'write'::action_key))
  WITH CHECK (public.has_permission(auth.uid(), 'logistics'::module_key, 'write'::action_key));
REVOKE DELETE ON public.vehicles FROM authenticated;

DROP POLICY IF EXISTS "logistics write drivers" ON public.drivers;
DROP POLICY IF EXISTS "logistics insert drivers" ON public.drivers;
DROP POLICY IF EXISTS "logistics update drivers" ON public.drivers;
CREATE POLICY "logistics insert drivers" ON public.drivers FOR INSERT TO authenticated
  WITH CHECK (public.has_permission(auth.uid(), 'logistics'::module_key, 'write'::action_key));
CREATE POLICY "logistics update drivers" ON public.drivers FOR UPDATE TO authenticated
  USING (public.has_permission(auth.uid(), 'logistics'::module_key, 'write'::action_key))
  WITH CHECK (public.has_permission(auth.uid(), 'logistics'::module_key, 'write'::action_key));
REVOKE DELETE ON public.drivers FROM authenticated;

-- expenses: drop both the FOR ALL write policy's delete coverage and the
-- narrower "delete while pending" policy.
DROP POLICY IF EXISTS "expenses write" ON public.expenses;
DROP POLICY IF EXISTS "expenses insert" ON public.expenses;
DROP POLICY IF EXISTS "expenses update" ON public.expenses;
CREATE POLICY "expenses insert" ON public.expenses FOR INSERT TO authenticated
  WITH CHECK (public.has_permission(auth.uid(), 'expenses'::module_key, 'write'::action_key));
CREATE POLICY "expenses update" ON public.expenses FOR UPDATE TO authenticated
  USING (public.has_permission(auth.uid(), 'expenses'::module_key, 'write'::action_key))
  WITH CHECK (public.has_permission(auth.uid(), 'expenses'::module_key, 'write'::action_key));
DROP POLICY IF EXISTS "expenses delete while pending" ON public.expenses;
REVOKE DELETE ON public.expenses FROM authenticated;

-- cash_transactions: split "FOR ALL" into INSERT + UPDATE only.
DROP POLICY IF EXISTS "receipts-payments write" ON public.cash_transactions;
DROP POLICY IF EXISTS "receipts-payments insert" ON public.cash_transactions;
DROP POLICY IF EXISTS "receipts-payments update" ON public.cash_transactions;
CREATE POLICY "receipts-payments insert" ON public.cash_transactions FOR INSERT TO authenticated
  WITH CHECK (public.has_permission(auth.uid(), 'receipts-payments'::module_key, 'write'::action_key));
CREATE POLICY "receipts-payments update" ON public.cash_transactions FOR UPDATE TO authenticated
  USING (public.has_permission(auth.uid(), 'receipts-payments'::module_key, 'write'::action_key))
  WITH CHECK (public.has_permission(auth.uid(), 'receipts-payments'::module_key, 'write'::action_key));
REVOKE DELETE ON public.cash_transactions FROM authenticated, anon;

-- product_units: split "FOR ALL" into INSERT + UPDATE only.
DROP POLICY IF EXISTS "product units write" ON public.product_units;
DROP POLICY IF EXISTS "product units insert" ON public.product_units;
DROP POLICY IF EXISTS "product units update" ON public.product_units;
CREATE POLICY "product units insert" ON public.product_units FOR INSERT TO authenticated
  WITH CHECK (public.has_permission(auth.uid(), 'finished-goods'::module_key, 'write'::action_key));
CREATE POLICY "product units update" ON public.product_units FOR UPDATE TO authenticated
  USING (public.has_permission(auth.uid(), 'finished-goods'::module_key, 'write'::action_key))
  WITH CHECK (public.has_permission(auth.uid(), 'finished-goods'::module_key, 'write'::action_key));
REVOKE DELETE ON public.product_units FROM authenticated;
