-- ============================================================================
-- Chairman is now fully equivalent to admin (super_admin) in practice
-- ----------------------------------------------------------------------------
-- The user asked for chairman to see every page and be able to do every
-- action in the system, including approving/posting/confirming their own
-- submissions (no maker-checker separation for a chairman account, same as
-- super_admin already gets) -- confirmed explicitly before writing this.
--
-- This required patching every place that special-cases super_admin,
-- because there is no single choke point:
--
-- 1. has_permission() and get_my_permissions() -- the two functions that
--    back essentially every RLS policy, RPC guard, and the frontend's own
--    permission cache (usePermissions()/canView/canWrite/canApprove/etc in
--    src/lib/permissions.ts) -- now short-circuit to fully-granted for
--    chairman exactly like they already do for super_admin. This alone
--    covers "every page, every module action" for both data access (RLS)
--    and UI visibility (the frontend permission cache), since neither of
--    those two functions previously granted chairman anything beyond its
--    seeded role_permissions rows.
--
-- 2. has_production_scope_access() -- a parallel 3rd bypass layer (NYLON/
--    WATER production isolation) that has its own independent super_admin
--    short-circuit, not routed through has_permission().
--
-- 3. ~10 admin-only RPCs that check has_role(uid,'super_admin') directly
--    instead of going through has_permission() at all: set_production_scope,
--    admin_update_profile, admin_set_user_role, get_all_users_last_login,
--    approve_delete, reject_delete, request_delete (its admin-notify loop),
--    restore_sale, purge_expired_deleted_sales.
--
-- 4. ~40 workflow RPCs' self-approval exemption ("you can't approve your
--    own submission, unless you're super_admin") -- every approve/reject/
--    post/reverse/confirm/inspect RPC across expenses, debts, payments,
--    payroll, staff loans/deductions, role grants, goods receiving, costing,
--    production batches/requests, stock adjustments, new materials, sales
--    returns, and sales. All of these shared the exact same literal
--    condition text, confirmed by reading back every one of their current
--    live definitions (via a temporary pg_get_functiondef() helper -- see
--    20260923180000/180100 -- dropped at the end of this migration) rather
--    than retyping ~40 multi-branch functions by hand.
--
-- 5. 8 RLS policies that hardcode has_role(auth.uid(),'super_admin'),
--    bypassing has_permission()/get_my_permissions() entirely: the Roles &
--    Permissions matrix and its per-user overrides editor, Role Management
--    CRUD (create/edit/delete a role), the Approval Workflows page's
--    required-approvals editor, Deleted Sales visibility, and Delete
--    Requests visibility.
--
-- Frontend: useIsSuperAdmin() (src/lib/permissions.ts) is left as-is --
-- "is this literally a super_admin" is still a meaningful question for a
-- few UI strings (e.g. "This user is an Admin, which has every page by
-- design" in user-page-access.tsx) -- but every canView/canWrite/canApprove/
-- etc check chairman now passes automatically via get_my_permissions(), so
-- most of the ~20 frontend gates the earlier audit found start working for
-- chairman the moment this ships without any frontend change; the handful
-- of purely admin-panel-tab visibility checks (Delete Requests / Deleted
-- Sales tabs in src/routes/_app.admin.tsx) are patched in a matching
-- frontend commit alongside this migration.
-- ============================================================================

-- ---------- public.has_permission(uuid, module_key, action_key) ----------
CREATE OR REPLACE FUNCTION public.has_permission(_user_id uuid, _module module_key, _action action_key DEFAULT 'view'::text)
 RETURNS boolean
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_actions public.action_key[];
  v_result boolean;
BEGIN
  IF _user_id IS NULL THEN RETURN false; END IF;
  IF public.has_role(_user_id, 'super_admin') OR public.has_role(_user_id, 'chairman') THEN RETURN true; END IF;

  -- Legacy aliases resolve against a bucket of concrete actions so existing
  -- RLS policies/RPC guards calling has_permission(x,'read'/'write') keep
  -- working unchanged against the new fine-grained grants.
  v_actions := CASE _action
    WHEN 'read' THEN ARRAY['view','create','edit','submit','approve','reject','confirm','post','reverse','cancel','export','print','delete']::public.action_key[]
    WHEN 'write' THEN ARRAY['create','edit','delete']::public.action_key[]
    ELSE ARRAY[_action]
  END;

  SELECT EXISTS (
    SELECT 1 FROM unnest(v_actions) AS a(action)
    WHERE COALESCE(
      (SELECT po.granted FROM public.permission_overrides po
        WHERE po.user_id = _user_id AND po.module = _module AND po.action = a.action),
      EXISTS (
        SELECT 1 FROM public.role_permissions rp
        JOIN public.user_roles ur ON ur.role = rp.role
        WHERE ur.user_id = _user_id AND rp.module = _module AND rp.action = a.action
      )
    )
  ) INTO v_result;

  RETURN v_result;
END;
$function$;

-- ---------- public.get_my_permissions() ----------
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
    'settings','costing','logistics','approvals','goods-receiving','distribution','sales-returns'
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

-- ---------- public.has_production_scope_access(uuid, uuid) ----------
CREATE OR REPLACE FUNCTION public.has_production_scope_access(_user_id uuid, _factory_id uuid)
 RETURNS boolean
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE v_scope text; v_factory_code text;
BEGIN
  IF _user_id IS NULL THEN RETURN false; END IF;
  IF public.has_role(_user_id, 'super_admin') OR public.has_role(_user_id, 'chairman') THEN RETURN true; END IF;
  IF _factory_id IS NULL THEN RETURN true; END IF;

  SELECT production_scope INTO v_scope FROM profiles WHERE id = _user_id;
  IF v_scope IS NULL OR v_scope = 'BOTH' THEN RETURN true; END IF;

  SELECT upper(code) INTO v_factory_code FROM factories WHERE id = _factory_id;
  RETURN v_factory_code = v_scope;
END;
$function$;

-- ---------- public.set_production_scope(uuid, text) ----------
CREATE OR REPLACE FUNCTION public.set_production_scope(p_user_id uuid, p_scope text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE v_uid uuid := auth.uid();
BEGIN
  IF NOT (public.has_role(v_uid, 'super_admin') OR public.has_role(v_uid, 'chairman') OR public.has_permission(v_uid, 'users'::module_key, 'edit'::action_key)) THEN
    RAISE EXCEPTION 'Insufficient permissions';
  END IF;
  IF p_scope NOT IN ('NYLON','WATER','BOTH') THEN RAISE EXCEPTION 'Invalid production scope'; END IF;

  UPDATE profiles SET production_scope = p_scope WHERE id = p_user_id;
  INSERT INTO audit_logs(user_id, action, entity, entity_id, new_value)
  VALUES (v_uid, 'update', 'profiles', p_user_id::text, jsonb_build_object('production_scope', p_scope));
  RETURN jsonb_build_object('updated', true);
END; $function$;

-- ---------- public.admin_update_profile(uuid, text, text, text, text, text) ----------
CREATE OR REPLACE FUNCTION public.admin_update_profile(target_id uuid, p_full_name text, p_phone text DEFAULT NULL::text, p_department text DEFAULT NULL::text, p_username text DEFAULT NULL::text, p_email text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  v_before profiles%ROWTYPE;
BEGIN
  IF NOT (public.has_role(v_uid, 'super_admin') OR public.has_role(v_uid, 'chairman') OR public.has_permission(v_uid, 'users'::module_key, 'edit'::action_key)) THEN
    RAISE EXCEPTION 'Insufficient permissions';
  END IF;
  IF p_full_name IS NULL OR btrim(p_full_name) = '' THEN
    RAISE EXCEPTION 'Full name is required';
  END IF;

  SELECT * INTO v_before FROM profiles WHERE id = target_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Account not found';
  END IF;

  UPDATE profiles SET
    full_name = btrim(p_full_name),
    phone = NULLIF(btrim(COALESCE(p_phone, '')), ''),
    department = NULLIF(btrim(COALESCE(p_department, '')), ''),
    username = NULLIF(btrim(COALESCE(p_username, '')), ''),
    email = COALESCE(NULLIF(btrim(COALESCE(p_email, '')), ''), email)
  WHERE id = target_id;

  INSERT INTO audit_logs(user_id, action, entity, entity_id, old_value, new_value)
  VALUES (v_uid, 'admin_update_profile', 'profiles', target_id::text,
          jsonb_build_object('full_name', v_before.full_name, 'phone', v_before.phone,
                              'department', v_before.department, 'username', v_before.username,
                              'email', v_before.email),
          jsonb_build_object('full_name', btrim(p_full_name), 'phone', p_phone,
                              'department', p_department, 'username', p_username,
                              'email', COALESCE(NULLIF(btrim(COALESCE(p_email, '')), ''), v_before.email)));

  RETURN jsonb_build_object('updated', true);
END;
$function$;

-- ---------- public.admin_set_user_role(uuid, text) ----------
CREATE OR REPLACE FUNCTION public.admin_set_user_role(target_user_id uuid, new_role text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  v_old_roles text[];
BEGIN
  IF NOT (public.has_role(v_uid, 'super_admin') OR public.has_role(v_uid, 'chairman')) THEN
    RAISE EXCEPTION 'Only a super admin can assign roles directly';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM profiles WHERE id = target_user_id) THEN
    RAISE EXCEPTION 'Target user not found';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM roles WHERE slug = new_role) THEN
    RAISE EXCEPTION 'Unknown role: %', new_role;
  END IF;

  SELECT coalesce(array_agg(role), '{}') INTO v_old_roles
  FROM user_roles WHERE user_id = target_user_id AND factory_id IS NULL;

  -- Factory-scoped roles (factory_id IS NOT NULL) are untouched -- this
  -- replaces only the user's global role, matching the single "Role"
  -- dropdown the Edit User dialog shows.
  DELETE FROM user_roles WHERE user_id = target_user_id AND factory_id IS NULL;
  INSERT INTO user_roles(user_id, role) VALUES (target_user_id, new_role)
    ON CONFLICT (user_id, role, factory_id) DO NOTHING;

  INSERT INTO audit_logs(user_id, action, entity, entity_id, old_value, new_value)
  VALUES (
    v_uid, 'admin_set_role', 'user_roles', target_user_id::text,
    jsonb_build_object('roles', v_old_roles),
    jsonb_build_object('role', new_role)
  );

  RETURN jsonb_build_object('set', true, 'role', new_role);
END; $function$;

-- ---------- public.get_all_users_last_login() ----------
CREATE OR REPLACE FUNCTION public.get_all_users_last_login()
 RETURNS TABLE(id uuid, last_sign_in_at timestamp with time zone)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  IF NOT (public.has_role(auth.uid(), 'super_admin') OR public.has_role(auth.uid(), 'chairman')) THEN RAISE EXCEPTION 'Insufficient permissions'; END IF;
  RETURN QUERY SELECT u.id, u.last_sign_in_at FROM auth.users u;
END;
$function$;

-- ---------- public.approve_delete(uuid) ----------
CREATE OR REPLACE FUNCTION public.approve_delete(p_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  v_req delete_requests%ROWTYPE;
  v_sale sales%ROWTYPE;
  v_item RECORD;
  v_before numeric;
  v_debt debts%ROWTYPE;
  v_found_debt boolean;
  v_total_collected numeric;
  v_refund numeric;
BEGIN
  IF NOT (public.has_role(v_uid, 'super_admin') OR public.has_role(v_uid, 'chairman')) THEN
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
  ELSIF v_req.table_name = 'suppliers' THEN
    DELETE FROM suppliers WHERE id = v_req.entity_id;

  ELSIF v_req.table_name = 'sales' THEN
    SELECT * INTO v_sale FROM sales WHERE id = v_req.entity_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Sale not found'; END IF;

    IF v_sale.status = 'posted' THEN
      -- Undo the stock effect applied at approve_sale() time.
      FOR v_item IN SELECT product_id, quantity FROM sale_items WHERE sale_id = v_sale.id LOOP
        IF v_sale.sales_rep_id IS NOT NULL THEN
          UPDATE rep_stock SET quantity = quantity + v_item.quantity, updated_at = now()
           WHERE sales_rep_id = v_sale.sales_rep_id AND product_id = v_item.product_id;
          INSERT INTO rep_stock_movements(factory_id, sales_rep_id, product_id, movement_type, quantity, reference, reason, user_id)
          VALUES (v_sale.factory_id, v_sale.sales_rep_id, v_item.product_id, 'reversal', v_item.quantity, v_sale.invoice_number, 'Sale deleted', v_uid);
        ELSE
          SELECT current_stock INTO v_before FROM products WHERE id = v_item.product_id FOR UPDATE;
          UPDATE products SET current_stock = current_stock + v_item.quantity, updated_at = now() WHERE id = v_item.product_id;
          INSERT INTO inventory_movements(factory_id, product_id, movement_type, quantity, reference, reason, user_id, quantity_before, quantity_after)
          VALUES (v_sale.factory_id, v_item.product_id, 'returned', v_item.quantity, v_sale.invoice_number, 'Sale deleted', v_uid, COALESCE(v_before,0), COALESCE(v_before,0) + v_item.quantity);
        END IF;
      END LOOP;

      -- Refund everything ever actually collected for this sale (register
      -- payments + any later installments against its debt) plus whatever
      -- credit balance was applied to it, back to the customer's credit --
      -- nothing is handed back out of a till here, it just becomes
      -- available to them again.
      SELECT COALESCE(SUM(amount), 0) INTO v_total_collected FROM payments_received WHERE sale_id = v_sale.id;
      v_refund := v_total_collected + v_sale.credit_applied;

      SELECT * INTO v_debt FROM debts WHERE sale_id = v_sale.id FOR UPDATE;
      v_found_debt := FOUND;
      IF v_found_debt THEN
        DELETE FROM debts WHERE id = v_debt.id;
      END IF;

      IF v_sale.customer_id IS NOT NULL THEN
        UPDATE customers SET
          total_purchases = GREATEST(total_purchases - v_sale.grand_total, 0),
          outstanding_balance = GREATEST(outstanding_balance - COALESCE(v_debt.outstanding, 0), 0),
          total_transactions = GREATEST(total_transactions - 1, 0),
          credit_balance = credit_balance + v_refund,
          updated_at = now()
        WHERE id = v_sale.customer_id;
      END IF;
    END IF;

    -- Soft delete either way: 30-day retention, restorable from the
    -- Deleted Sales admin tab (see 20260923130000_...).
    UPDATE sales SET deleted_at = now() WHERE id = v_req.entity_id;
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
$function$;

-- ---------- public.reject_delete(uuid, text) ----------
CREATE OR REPLACE FUNCTION public.reject_delete(p_id uuid, p_reason text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  v_req delete_requests%ROWTYPE;
BEGIN
  IF NOT (public.has_role(v_uid, 'super_admin') OR public.has_role(v_uid, 'chairman')) THEN
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
$function$;

-- ---------- public.request_delete(text, uuid, text) ----------
CREATE OR REPLACE FUNCTION public.request_delete(p_table_name text, p_entity_id uuid, p_reason text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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

  ELSIF p_table_name = 'suppliers' THEN
    v_module := 'suppliers'::module_key;
    SELECT factory_id, name INTO v_factory, v_label
      FROM suppliers WHERE id = p_entity_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Supplier not found'; END IF;

  ELSIF p_table_name = 'sales' THEN
    v_module := 'sales'::module_key;
    SELECT factory_id, invoice_number INTO v_factory, v_label
      FROM sales WHERE id = p_entity_id AND deleted_at IS NULL FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Sale not found'; END IF;

  ELSE
    RAISE EXCEPTION 'Unsupported table for delete requests: %', p_table_name;
  END IF;

  IF NOT public.has_permission(v_uid, v_module, 'delete'::action_key) THEN
    RAISE EXCEPTION 'Insufficient permissions';
  END IF;

  INSERT INTO delete_requests(factory_id, table_name, entity_id, entity_label, module, payload, reason, requested_by)
  VALUES (v_factory, p_table_name, p_entity_id, v_label, v_module, v_payload, p_reason, v_uid)
  RETURNING id INTO v_id;

  FOR v_admin_id IN SELECT user_id FROM user_roles WHERE role IN ('super_admin', 'chairman') LOOP
    INSERT INTO notifications(user_id, factory_id, title, body)
    VALUES (v_admin_id, v_factory, 'Deletion requested',
            initcap(replace(p_table_name, '_', ' ')) || ' "' || v_label || '" — reason: ' || p_reason);
  END LOOP;

  INSERT INTO audit_logs(user_id, factory_id, action, entity, entity_id, old_value, new_value)
  VALUES (v_uid, v_factory, 'request_delete', p_table_name, p_entity_id::text,
          NULL, jsonb_build_object('reason', p_reason, 'label', v_label));

  RETURN jsonb_build_object('id', v_id);
END;
$function$;

-- ---------- public.restore_sale(uuid) ----------
CREATE OR REPLACE FUNCTION public.restore_sale(p_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_uid uuid := auth.uid();
BEGIN
  IF NOT (public.has_role(v_uid, 'super_admin') OR public.has_role(v_uid, 'chairman')) THEN
    RAISE EXCEPTION 'Only an admin can restore a deleted sale';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM sales WHERE id = p_id AND deleted_at IS NOT NULL) THEN
    RAISE EXCEPTION 'This sale is not deleted';
  END IF;

  UPDATE sales SET deleted_at = NULL WHERE id = p_id;

  INSERT INTO audit_logs(user_id, factory_id, action, entity, entity_id, old_value, new_value)
  SELECT v_uid, factory_id, 'restore_sale', 'sales', p_id::text,
         jsonb_build_object('deleted', true), jsonb_build_object('deleted', false)
  FROM sales WHERE id = p_id;

  RETURN jsonb_build_object('restored', true);
END;
$function$;

-- ---------- public.purge_expired_deleted_sales() ----------
CREATE OR REPLACE FUNCTION public.purge_expired_deleted_sales()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  v_row RECORD;
  v_purged int := 0;
  v_skipped int := 0;
BEGIN
  IF NOT (public.has_role(v_uid, 'super_admin') OR public.has_role(v_uid, 'chairman')) THEN
    RAISE EXCEPTION 'Only an admin can purge deleted sales';
  END IF;

  FOR v_row IN
    SELECT id FROM sales
    WHERE deleted_at IS NOT NULL AND deleted_at < now() - interval '30 days'
  LOOP
    BEGIN
      DELETE FROM sales WHERE id = v_row.id;
      v_purged := v_purged + 1;
    EXCEPTION WHEN foreign_key_violation THEN
      -- Something else (a debt/payment/delivery/return) still references
      -- this sale -- leave it soft-deleted rather than aborting the batch.
      v_skipped := v_skipped + 1;
    END;
  END LOOP;

  RETURN jsonb_build_object('purged', v_purged, 'skipped', v_skipped);
END;
$function$;

-- ---------- public.approve_expense(uuid, text) ----------
CREATE OR REPLACE FUNCTION public.approve_expense(p_id uuid, p_comment text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE v_row expenses%ROWTYPE; v_uid uuid := auth.uid(); v_progress record;
BEGIN
  IF NOT public.has_permission(v_uid, 'expenses'::module_key, 'approve'::action_key) THEN RAISE EXCEPTION 'Insufficient permissions'; END IF;
  SELECT * INTO v_row FROM expenses WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Expense not found'; END IF;
  IF v_row.submitted_by = v_uid AND NOT (public.has_role(v_uid, 'super_admin') OR public.has_role(v_uid, 'chairman')) THEN
    RAISE EXCEPTION 'You cannot approve an expense you submitted yourself';
  END IF;

  PERFORM public.record_workflow_action('expenses', p_id, 'approve', v_row.status, v_row.status, p_comment);
  SELECT * INTO v_progress FROM public.workflow_approval_progress('expenses', p_id);
  IF NOT v_progress.satisfied THEN
    RETURN jsonb_build_object('approved', false, 'partial', true, 'approvals_so_far', v_progress.approvals_so_far, 'required', v_progress.required_approvals);
  END IF;

  PERFORM public.assert_valid_transition(v_row.status, 'approved');
  UPDATE expenses SET status = 'approved', reviewed_by = v_uid, reviewed_at = now() WHERE id = p_id;
  INSERT INTO audit_logs(user_id, factory_id, action, entity, entity_id, old_value, new_value)
  VALUES (v_uid, v_row.factory_id, 'approve_expense', 'expenses', p_id::text,
          jsonb_build_object('status', v_row.status), jsonb_build_object('status', 'approved'));
  RETURN jsonb_build_object('approved', true, 'approvals_so_far', v_progress.approvals_so_far, 'required', v_progress.required_approvals);
END; $function$;

-- ---------- public.reject_expense(uuid, text) ----------
CREATE OR REPLACE FUNCTION public.reject_expense(p_id uuid, p_reason text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE v_row expenses%ROWTYPE; v_uid uuid := auth.uid();
BEGIN
  IF NOT public.has_permission(v_uid, 'expenses'::module_key, 'reject'::action_key) THEN RAISE EXCEPTION 'Insufficient permissions'; END IF;
  SELECT * INTO v_row FROM expenses WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Expense not found'; END IF;
  IF v_row.submitted_by = v_uid AND NOT (public.has_role(v_uid, 'super_admin') OR public.has_role(v_uid, 'chairman')) THEN
    RAISE EXCEPTION 'You cannot reject an expense you submitted yourself';
  END IF;
  PERFORM public.assert_valid_transition(v_row.status, 'rejected');

  UPDATE expenses SET status = 'rejected', approval_status = 'rejected', reviewed_by = v_uid, reviewed_at = now(),
    remarks = CASE WHEN p_reason IS NOT NULL AND btrim(p_reason) <> '' THEN COALESCE(remarks || E'\n', '') || 'Rejected: ' || p_reason ELSE remarks END
  WHERE id = p_id;
  PERFORM public.record_workflow_action('expenses', p_id, 'reject', v_row.status, 'rejected', p_reason);
  INSERT INTO audit_logs(user_id, factory_id, action, entity, entity_id, old_value, new_value)
  VALUES (v_uid, v_row.factory_id, 'reject_expense', 'expenses', p_id::text,
          jsonb_build_object('status', v_row.status), jsonb_build_object('status', 'rejected', 'reason', p_reason));
  RETURN jsonb_build_object('rejected', true);
END; $function$;

-- ---------- public.post_expense(uuid, text) ----------
CREATE OR REPLACE FUNCTION public.post_expense(p_id uuid, p_comment text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE v_row expenses%ROWTYPE; v_uid uuid := auth.uid(); v_name text;
BEGIN
  IF NOT public.has_permission(v_uid, 'expenses'::module_key, 'post'::action_key) THEN RAISE EXCEPTION 'Insufficient permissions'; END IF;
  SELECT * INTO v_row FROM expenses WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Expense not found'; END IF;
  IF v_row.submitted_by = v_uid AND NOT (public.has_role(v_uid, 'super_admin') OR public.has_role(v_uid, 'chairman')) THEN
    RAISE EXCEPTION 'You cannot post an expense you submitted yourself';
  END IF;
  PERFORM public.assert_valid_transition(v_row.status, 'posted');

  SELECT COALESCE(full_name, email, 'Unknown') INTO v_name FROM profiles WHERE id = v_uid;
  UPDATE expenses SET status = 'posted', approval_status = 'approved', approved_by = v_name, approved_at = now(),
    reviewed_by = v_uid, reviewed_at = now()
  WHERE id = p_id;
  PERFORM public.record_workflow_action('expenses', p_id, 'post', v_row.status, 'posted', p_comment);
  INSERT INTO audit_logs(user_id, factory_id, action, entity, entity_id, old_value, new_value)
  VALUES (v_uid, v_row.factory_id, 'post_expense', 'expenses', p_id::text,
          jsonb_build_object('status', v_row.status), jsonb_build_object('status', 'posted'));
  RETURN jsonb_build_object('posted', true);
END; $function$;

-- ---------- public.reverse_expense(uuid, text) ----------
CREATE OR REPLACE FUNCTION public.reverse_expense(p_id uuid, p_reason text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE v_row expenses%ROWTYPE; v_uid uuid := auth.uid();
BEGIN
  IF NOT public.has_permission(v_uid, 'expenses'::module_key, 'reverse'::action_key) THEN RAISE EXCEPTION 'Insufficient permissions'; END IF;
  IF p_reason IS NULL OR btrim(p_reason) = '' THEN RAISE EXCEPTION 'A reason is required to reverse a posted expense'; END IF;
  SELECT * INTO v_row FROM expenses WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Expense not found'; END IF;
  IF v_row.submitted_by = v_uid AND NOT (public.has_role(v_uid, 'super_admin') OR public.has_role(v_uid, 'chairman')) THEN
    RAISE EXCEPTION 'You cannot reverse an expense you submitted yourself';
  END IF;
  PERFORM public.assert_valid_transition(v_row.status, 'reversed');

  UPDATE expenses SET status = 'reversed' WHERE id = p_id;
  PERFORM public.record_workflow_action('expenses', p_id, 'reverse', v_row.status, 'reversed', p_reason);
  INSERT INTO audit_logs(user_id, factory_id, action, entity, entity_id, old_value, new_value)
  VALUES (v_uid, v_row.factory_id, 'reverse_expense', 'expenses', p_id::text,
          jsonb_build_object('status', v_row.status), jsonb_build_object('status', 'reversed', 'reason', p_reason));
  RETURN jsonb_build_object('reversed', true);
END; $function$;

-- ---------- public.approve_debt_writeoff(uuid, text) ----------
CREATE OR REPLACE FUNCTION public.approve_debt_writeoff(p_debt_id uuid, p_comment text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE v_uid uuid := auth.uid(); v_debt debts%ROWTYPE; v_progress record;
BEGIN
  IF NOT public.has_permission(v_uid, 'debts'::module_key, 'approve'::action_key) THEN RAISE EXCEPTION 'Insufficient permissions'; END IF;
  SELECT * INTO v_debt FROM debts WHERE id = p_debt_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Debt not found'; END IF;
  IF v_debt.writeoff_requested_by = v_uid AND NOT (public.has_role(v_uid, 'super_admin') OR public.has_role(v_uid, 'chairman')) THEN
    RAISE EXCEPTION 'You cannot approve a write-off you requested yourself';
  END IF;

  PERFORM public.record_workflow_action('debts', p_debt_id, 'approve', v_debt.writeoff_status, v_debt.writeoff_status, p_comment);
  SELECT * INTO v_progress FROM public.workflow_approval_progress('debts', p_debt_id);
  IF NOT v_progress.satisfied THEN
    RETURN jsonb_build_object('approved', false, 'partial', true, 'approvals_so_far', v_progress.approvals_so_far, 'required', v_progress.required_approvals);
  END IF;

  PERFORM public.assert_valid_transition(v_debt.writeoff_status, 'approved');
  UPDATE debts SET writeoff_status = 'approved', writeoff_reviewed_by = v_uid, writeoff_reviewed_at = now() WHERE id = p_debt_id;
  RETURN jsonb_build_object('approved', true, 'approvals_so_far', v_progress.approvals_so_far, 'required', v_progress.required_approvals);
END; $function$;

-- ---------- public.reject_debt_writeoff(uuid, text) ----------
CREATE OR REPLACE FUNCTION public.reject_debt_writeoff(p_debt_id uuid, p_reason text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE v_uid uuid := auth.uid(); v_debt debts%ROWTYPE;
BEGIN
  IF NOT public.has_permission(v_uid, 'debts'::module_key, 'reject'::action_key) THEN RAISE EXCEPTION 'Insufficient permissions'; END IF;
  SELECT * INTO v_debt FROM debts WHERE id = p_debt_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Debt not found'; END IF;
  IF v_debt.writeoff_requested_by = v_uid AND NOT (public.has_role(v_uid, 'super_admin') OR public.has_role(v_uid, 'chairman')) THEN
    RAISE EXCEPTION 'You cannot reject a write-off you requested yourself';
  END IF;
  PERFORM public.assert_valid_transition(v_debt.writeoff_status, 'rejected');

  UPDATE debts SET writeoff_status = 'rejected', writeoff_reviewed_by = v_uid, writeoff_reviewed_at = now(), writeoff_reject_reason = p_reason
  WHERE id = p_debt_id;
  PERFORM public.record_workflow_action('debts', p_debt_id, 'reject', v_debt.writeoff_status, 'rejected', p_reason);
  RETURN jsonb_build_object('rejected', true);
END; $function$;

-- ---------- public.post_debt_writeoff(uuid, text) ----------
CREATE OR REPLACE FUNCTION public.post_debt_writeoff(p_debt_id uuid, p_comment text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE v_uid uuid := auth.uid(); v_debt debts%ROWTYPE; v_written_off numeric;
BEGIN
  IF NOT public.has_permission(v_uid, 'debts'::module_key, 'post'::action_key) THEN RAISE EXCEPTION 'Insufficient permissions'; END IF;
  SELECT * INTO v_debt FROM debts WHERE id = p_debt_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Debt not found'; END IF;
  IF v_debt.writeoff_requested_by = v_uid AND NOT (public.has_role(v_uid, 'super_admin') OR public.has_role(v_uid, 'chairman')) THEN
    RAISE EXCEPTION 'You cannot post a write-off you requested yourself';
  END IF;
  PERFORM public.assert_valid_transition(v_debt.writeoff_status, 'posted');

  v_written_off := v_debt.outstanding;
  UPDATE debts SET amount_paid = total_amount, outstanding = 0, status = 'paid', updated_at = now(),
    writeoff_status = 'posted', writeoff_amount = v_written_off
  WHERE id = p_debt_id;
  IF v_debt.customer_id IS NOT NULL THEN
    UPDATE customers SET outstanding_balance = GREATEST(outstanding_balance - v_written_off, 0), updated_at = now() WHERE id = v_debt.customer_id;
  END IF;
  PERFORM public.record_workflow_action('debts', p_debt_id, 'post', v_debt.writeoff_status, 'posted', p_comment);
  INSERT INTO audit_logs(user_id, factory_id, action, entity, entity_id, old_value, new_value)
  VALUES (v_uid, v_debt.factory_id, 'post_debt_writeoff', 'debts', p_debt_id::text,
          jsonb_build_object('outstanding', v_debt.outstanding, 'status', v_debt.status),
          jsonb_build_object('outstanding', 0, 'status', 'paid', 'written_off', v_written_off));
  RETURN jsonb_build_object('closed', true, 'written_off', v_written_off);
END; $function$;

-- ---------- public.reverse_debt_writeoff(uuid, text) ----------
CREATE OR REPLACE FUNCTION public.reverse_debt_writeoff(p_debt_id uuid, p_reason text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE v_uid uuid := auth.uid(); v_debt debts%ROWTYPE;
BEGIN
  IF NOT public.has_permission(v_uid, 'debts'::module_key, 'reverse'::action_key) THEN RAISE EXCEPTION 'Insufficient permissions'; END IF;
  IF p_reason IS NULL OR btrim(p_reason) = '' THEN RAISE EXCEPTION 'A reason is required to reverse a write-off'; END IF;
  SELECT * INTO v_debt FROM debts WHERE id = p_debt_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Debt not found'; END IF;
  IF v_debt.writeoff_requested_by = v_uid AND NOT (public.has_role(v_uid, 'super_admin') OR public.has_role(v_uid, 'chairman')) THEN
    RAISE EXCEPTION 'You cannot reverse a write-off you requested yourself';
  END IF;
  PERFORM public.assert_valid_transition(v_debt.writeoff_status, 'reversed');
  IF v_debt.writeoff_amount IS NULL THEN RAISE EXCEPTION 'No recorded write-off amount to reverse'; END IF;

  UPDATE debts SET
    amount_paid = GREATEST(amount_paid - v_debt.writeoff_amount, 0),
    outstanding = outstanding + v_debt.writeoff_amount,
    status = CASE WHEN amount_paid - v_debt.writeoff_amount <= 0 THEN 'unpaid'::debt_status ELSE 'partial'::debt_status END,
    updated_at = now(), writeoff_status = 'reversed'
  WHERE id = p_debt_id;
  IF v_debt.customer_id IS NOT NULL THEN
    UPDATE customers SET outstanding_balance = outstanding_balance + v_debt.writeoff_amount, updated_at = now() WHERE id = v_debt.customer_id;
  END IF;
  PERFORM public.record_workflow_action('debts', p_debt_id, 'reverse', v_debt.writeoff_status, 'reversed', p_reason);
  INSERT INTO audit_logs(user_id, factory_id, action, entity, entity_id, old_value, new_value)
  VALUES (v_uid, v_debt.factory_id, 'reverse_debt_writeoff', 'debts', p_debt_id::text,
          jsonb_build_object('status', 'paid', 'outstanding', 0),
          jsonb_build_object('status', 'reversed', 'restored', v_debt.writeoff_amount, 'reason', p_reason));
  RETURN jsonb_build_object('reversed', true, 'restored', v_debt.writeoff_amount);
END; $function$;

-- ---------- public.confirm_payment(uuid, text) ----------
CREATE OR REPLACE FUNCTION public.confirm_payment(p_id uuid, p_note text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE v_row payments_received%ROWTYPE; v_uid uuid := auth.uid(); v_progress record;
BEGIN
  IF NOT public.has_permission(v_uid, 'payments'::module_key, 'confirm'::action_key) THEN RAISE EXCEPTION 'Insufficient permissions'; END IF;
  SELECT * INTO v_row FROM payments_received WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Payment not found'; END IF;
  IF v_row.received_by = v_uid AND NOT (public.has_role(v_uid, 'super_admin') OR public.has_role(v_uid, 'chairman')) THEN
    RAISE EXCEPTION 'You cannot confirm a payment you recorded yourself';
  END IF;

  PERFORM public.record_workflow_action('payments', p_id, 'confirm', v_row.status, v_row.status, p_note);
  SELECT * INTO v_progress FROM public.workflow_approval_progress('payments', p_id);
  IF NOT v_progress.satisfied THEN
    RETURN jsonb_build_object('confirmed', false, 'partial', true, 'approvals_so_far', v_progress.approvals_so_far, 'required', v_progress.required_approvals);
  END IF;

  PERFORM public.assert_valid_transition(v_row.status, 'confirmed');
  UPDATE payments_received SET status = 'confirmed', review_status = 'approved', reviewed_by = v_uid, reviewed_at = now(), review_note = p_note
  WHERE id = p_id;
  INSERT INTO audit_logs(user_id, factory_id, action, entity, entity_id, old_value, new_value)
  VALUES (v_uid, v_row.factory_id, 'confirm_payment', 'payments_received', p_id::text,
          jsonb_build_object('status', v_row.status), jsonb_build_object('status', 'confirmed'));
  RETURN jsonb_build_object('confirmed', true, 'approvals_so_far', v_progress.approvals_so_far, 'required', v_progress.required_approvals);
END; $function$;

-- ---------- public.reject_payment(uuid, text) ----------
CREATE OR REPLACE FUNCTION public.reject_payment(p_id uuid, p_reason text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE v_row payments_received%ROWTYPE; v_uid uuid := auth.uid();
BEGIN
  IF NOT public.has_permission(v_uid, 'payments'::module_key, 'reject'::action_key) THEN RAISE EXCEPTION 'Insufficient permissions'; END IF;
  IF p_reason IS NULL OR btrim(p_reason) = '' THEN RAISE EXCEPTION 'A reason is required to flag/reject a payment'; END IF;
  SELECT * INTO v_row FROM payments_received WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Payment not found'; END IF;
  IF v_row.received_by = v_uid AND NOT (public.has_role(v_uid, 'super_admin') OR public.has_role(v_uid, 'chairman')) THEN
    RAISE EXCEPTION 'You cannot reject a payment you recorded yourself';
  END IF;
  PERFORM public.assert_valid_transition(v_row.status, 'rejected');

  UPDATE payments_received SET status = 'rejected', review_status = 'rejected', reviewed_by = v_uid, reviewed_at = now(), review_note = p_reason
  WHERE id = p_id;
  PERFORM public.record_workflow_action('payments', p_id, 'reject', v_row.status, 'rejected', p_reason);
  INSERT INTO audit_logs(user_id, factory_id, action, entity, entity_id, old_value, new_value)
  VALUES (v_uid, v_row.factory_id, 'reject_payment', 'payments_received', p_id::text,
          jsonb_build_object('status', v_row.status), jsonb_build_object('status', 'rejected', 'reason', p_reason));
  RETURN jsonb_build_object('rejected', true);
END; $function$;

-- ---------- public.reverse_payment(uuid, text) ----------
CREATE OR REPLACE FUNCTION public.reverse_payment(p_id uuid, p_reason text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_row payments_received%ROWTYPE; v_uid uuid := auth.uid(); v_debt debts%ROWTYPE;
BEGIN
  IF NOT public.has_permission(v_uid, 'payments'::module_key, 'reverse'::action_key) THEN RAISE EXCEPTION 'Insufficient permissions'; END IF;
  IF p_reason IS NULL OR btrim(p_reason) = '' THEN RAISE EXCEPTION 'A reason is required to reverse a payment'; END IF;
  SELECT * INTO v_row FROM payments_received WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Payment not found'; END IF;
  IF v_row.received_by = v_uid AND NOT (public.has_role(v_uid, 'super_admin') OR public.has_role(v_uid, 'chairman')) THEN
    RAISE EXCEPTION 'You cannot reverse a payment you recorded yourself';
  END IF;
  PERFORM public.assert_valid_transition(v_row.status, 'reversed');

  IF v_row.sale_id IS NOT NULL THEN
    SELECT * INTO v_debt FROM debts WHERE sale_id = v_row.sale_id FOR UPDATE;
    IF FOUND THEN
      UPDATE debts SET
        amount_paid = GREATEST(amount_paid - v_row.amount, 0),
        outstanding = LEAST(outstanding + v_row.amount, total_amount),
        status = CASE WHEN amount_paid - v_row.amount <= 0 THEN 'unpaid'::debt_status ELSE 'partial'::debt_status END,
        updated_at = now()
      WHERE id = v_debt.id;
    END IF;
    UPDATE sales SET amount_paid = GREATEST(amount_paid - v_row.amount, 0), balance = balance + v_row.amount WHERE id = v_row.sale_id;
  END IF;
  IF v_row.customer_id IS NOT NULL THEN
    UPDATE customers SET outstanding_balance = outstanding_balance + v_row.amount, updated_at = now()
    WHERE id = v_row.customer_id;
  END IF;

  UPDATE payments_received SET status = 'reversed', reviewed_by = v_uid, reviewed_at = now(), review_note = p_reason WHERE id = p_id;
  PERFORM public.record_workflow_action('payments', p_id, 'reverse', v_row.status, 'reversed', p_reason);
  INSERT INTO audit_logs(user_id, factory_id, action, entity, entity_id, old_value, new_value)
  VALUES (v_uid, v_row.factory_id, 'reverse_payment', 'payments_received', p_id::text,
          jsonb_build_object('status', v_row.status, 'amount', v_row.amount),
          jsonb_build_object('status', 'reversed', 'reason', p_reason));
  RETURN jsonb_build_object('reversed', true);
END; $function$;

-- ---------- public.approve_payroll(uuid, text) ----------
CREATE OR REPLACE FUNCTION public.approve_payroll(p_id uuid, p_comment text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE v_row payroll%ROWTYPE; v_uid uuid := auth.uid(); v_progress record;
BEGIN
  IF NOT public.has_permission(v_uid, 'payroll'::module_key, 'approve'::action_key) THEN RAISE EXCEPTION 'Insufficient permissions'; END IF;
  SELECT * INTO v_row FROM payroll WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Payroll record not found'; END IF;
  IF v_row.submitted_by = v_uid AND NOT (public.has_role(v_uid, 'super_admin') OR public.has_role(v_uid, 'chairman')) THEN
    RAISE EXCEPTION 'You cannot approve a payroll run you submitted yourself';
  END IF;

  PERFORM public.record_workflow_action('payroll', p_id, 'approve', v_row.status, v_row.status, p_comment);
  SELECT * INTO v_progress FROM public.workflow_approval_progress('payroll', p_id);
  IF NOT v_progress.satisfied THEN
    RETURN jsonb_build_object('approved', false, 'partial', true, 'approvals_so_far', v_progress.approvals_so_far, 'required', v_progress.required_approvals);
  END IF;

  PERFORM public.assert_valid_transition(v_row.status, 'approved');
  UPDATE payroll SET status = 'approved', reviewed_by = v_uid, reviewed_at = now() WHERE id = p_id;
  RETURN jsonb_build_object('approved', true, 'approvals_so_far', v_progress.approvals_so_far, 'required', v_progress.required_approvals);
END; $function$;

-- ---------- public.reject_payroll(uuid, text) ----------
CREATE OR REPLACE FUNCTION public.reject_payroll(p_id uuid, p_reason text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE v_row payroll%ROWTYPE; v_uid uuid := auth.uid();
BEGIN
  IF NOT public.has_permission(v_uid, 'payroll'::module_key, 'reject'::action_key) THEN RAISE EXCEPTION 'Insufficient permissions'; END IF;
  SELECT * INTO v_row FROM payroll WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Payroll record not found'; END IF;
  IF v_row.submitted_by = v_uid AND NOT (public.has_role(v_uid, 'super_admin') OR public.has_role(v_uid, 'chairman')) THEN
    RAISE EXCEPTION 'You cannot reject a payroll run you submitted yourself';
  END IF;
  PERFORM public.assert_valid_transition(v_row.status, 'rejected');

  UPDATE payroll SET status = 'rejected', reviewed_by = v_uid, reviewed_at = now(), review_reason = p_reason WHERE id = p_id;
  PERFORM public.record_workflow_action('payroll', p_id, 'reject', v_row.status, 'rejected', p_reason);

  DELETE FROM staff_loan_repayments WHERE payroll_id = p_id AND status = 'scheduled';
  UPDATE staff_deductions SET status = 'approved', applied_payroll_id = NULL WHERE applied_payroll_id = p_id AND status = 'applied';
  RETURN jsonb_build_object('rejected', true);
END; $function$;

-- ---------- public.post_payroll(uuid, date, text) ----------
CREATE OR REPLACE FUNCTION public.post_payroll(p_id uuid, p_payment_date date DEFAULT CURRENT_DATE, p_comment text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE v_row payroll%ROWTYPE; v_uid uuid := auth.uid(); v_rep staff_loan_repayments%ROWTYPE;
BEGIN
  IF NOT public.has_permission(v_uid, 'payroll'::module_key, 'post'::action_key) THEN RAISE EXCEPTION 'Insufficient permissions'; END IF;
  SELECT * INTO v_row FROM payroll WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Payroll record not found'; END IF;
  IF v_row.submitted_by = v_uid AND NOT (public.has_role(v_uid, 'super_admin') OR public.has_role(v_uid, 'chairman')) THEN
    RAISE EXCEPTION 'You cannot post a payroll run you submitted yourself';
  END IF;
  PERFORM public.assert_valid_transition(v_row.status, 'posted');

  UPDATE payroll SET status = 'posted', payment_date = p_payment_date, reviewed_by = v_uid, reviewed_at = now() WHERE id = p_id;
  PERFORM public.record_workflow_action('payroll', p_id, 'post', v_row.status, 'posted', p_comment);

  FOR v_rep IN SELECT * FROM staff_loan_repayments WHERE payroll_id = p_id AND status = 'scheduled' FOR UPDATE LOOP
    UPDATE staff_loan_repayments SET status = 'paid', paid_at = now() WHERE id = v_rep.id;
    UPDATE staff_loans SET amount_repaid = amount_repaid + v_rep.amount, updated_at = now() WHERE id = v_rep.loan_id;
    UPDATE staff_loans SET status = 'settled' WHERE id = v_rep.loan_id AND status = 'active' AND amount_repaid >= principal;
  END LOOP;

  INSERT INTO audit_logs(user_id, factory_id, action, entity, entity_id, old_value, new_value)
  VALUES (v_uid, v_row.factory_id, 'post_payroll', 'payroll', p_id::text,
          jsonb_build_object('status', v_row.status), jsonb_build_object('status', 'posted', 'net_salary', v_row.net_salary));
  RETURN jsonb_build_object('posted', true);
END; $function$;

-- ---------- public.reverse_payroll(uuid, text) ----------
CREATE OR REPLACE FUNCTION public.reverse_payroll(p_id uuid, p_reason text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE v_row payroll%ROWTYPE; v_uid uuid := auth.uid(); v_rep staff_loan_repayments%ROWTYPE;
BEGIN
  IF NOT public.has_permission(v_uid, 'payroll'::module_key, 'reverse'::action_key) THEN RAISE EXCEPTION 'Insufficient permissions'; END IF;
  IF p_reason IS NULL OR btrim(p_reason) = '' THEN RAISE EXCEPTION 'A reason is required to reverse a posted payroll run'; END IF;
  SELECT * INTO v_row FROM payroll WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Payroll record not found'; END IF;
  IF v_row.submitted_by = v_uid AND NOT (public.has_role(v_uid, 'super_admin') OR public.has_role(v_uid, 'chairman')) THEN
    RAISE EXCEPTION 'You cannot reverse a payroll run you submitted yourself';
  END IF;
  PERFORM public.assert_valid_transition(v_row.status, 'reversed');

  UPDATE payroll SET status = 'reversed' WHERE id = p_id;
  PERFORM public.record_workflow_action('payroll', p_id, 'reverse', v_row.status, 'reversed', p_reason);

  FOR v_rep IN SELECT * FROM staff_loan_repayments WHERE payroll_id = p_id AND status = 'paid' FOR UPDATE LOOP
    UPDATE staff_loan_repayments SET status = 'void' WHERE id = v_rep.id;
    UPDATE staff_loans
       SET amount_repaid = GREATEST(amount_repaid - v_rep.amount, 0),
           status = CASE WHEN status = 'settled' THEN 'active' ELSE status END,
           updated_at = now()
     WHERE id = v_rep.loan_id;
  END LOOP;
  UPDATE staff_deductions SET status = 'approved', applied_payroll_id = NULL WHERE applied_payroll_id = p_id AND status = 'applied';

  INSERT INTO audit_logs(user_id, factory_id, action, entity, entity_id, old_value, new_value)
  VALUES (v_uid, v_row.factory_id, 'reverse_payroll', 'payroll', p_id::text,
          jsonb_build_object('status', v_row.status), jsonb_build_object('status', 'reversed', 'reason', p_reason));
  RETURN jsonb_build_object('reversed', true);
END; $function$;

-- ---------- public.approve_staff_loan(uuid, text) ----------
CREATE OR REPLACE FUNCTION public.approve_staff_loan(p_id uuid, p_comment text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE v_uid uuid := auth.uid(); v_row staff_loans%ROWTYPE;
BEGIN
  IF NOT public.has_permission(v_uid, 'payroll'::module_key, 'approve'::action_key) THEN
    RAISE EXCEPTION 'Insufficient permissions';
  END IF;
  SELECT * INTO v_row FROM staff_loans WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Loan not found'; END IF;
  IF v_row.status <> 'pending' THEN RAISE EXCEPTION 'Loan is already %', v_row.status; END IF;
  IF v_row.submitted_by = v_uid AND NOT (public.has_role(v_uid, 'super_admin') OR public.has_role(v_uid, 'chairman')) THEN
    RAISE EXCEPTION 'You cannot approve a loan you recorded yourself';
  END IF;
  UPDATE staff_loans SET status = 'active', approved_by = v_uid, approved_at = now() WHERE id = p_id;
  RETURN jsonb_build_object('approved', true);
END; $function$;

-- ---------- public.reject_staff_loan(uuid, text) ----------
CREATE OR REPLACE FUNCTION public.reject_staff_loan(p_id uuid, p_reason text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE v_uid uuid := auth.uid(); v_row staff_loans%ROWTYPE;
BEGIN
  IF NOT public.has_permission(v_uid, 'payroll'::module_key, 'reject'::action_key) THEN
    RAISE EXCEPTION 'Insufficient permissions';
  END IF;
  IF p_reason IS NULL OR btrim(p_reason) = '' THEN RAISE EXCEPTION 'A reason is required to reject a loan'; END IF;
  SELECT * INTO v_row FROM staff_loans WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Loan not found'; END IF;
  IF v_row.status <> 'pending' THEN RAISE EXCEPTION 'Loan is already %', v_row.status; END IF;
  IF v_row.submitted_by = v_uid AND NOT (public.has_role(v_uid, 'super_admin') OR public.has_role(v_uid, 'chairman')) THEN
    RAISE EXCEPTION 'You cannot reject a loan you recorded yourself';
  END IF;
  UPDATE staff_loans SET status = 'rejected', approved_by = v_uid, approved_at = now(), reject_reason = p_reason WHERE id = p_id;
  RETURN jsonb_build_object('rejected', true);
END; $function$;

-- ---------- public.approve_staff_deduction(uuid, text) ----------
CREATE OR REPLACE FUNCTION public.approve_staff_deduction(p_id uuid, p_comment text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE v_uid uuid := auth.uid(); v_row staff_deductions%ROWTYPE;
BEGIN
  IF NOT public.has_permission(v_uid, 'payroll'::module_key, 'approve'::action_key) THEN
    RAISE EXCEPTION 'Insufficient permissions';
  END IF;
  SELECT * INTO v_row FROM staff_deductions WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Entry not found'; END IF;
  IF v_row.status <> 'pending' THEN RAISE EXCEPTION 'Entry is already %', v_row.status; END IF;
  IF v_row.submitted_by = v_uid AND NOT (public.has_role(v_uid, 'super_admin') OR public.has_role(v_uid, 'chairman')) THEN
    RAISE EXCEPTION 'You cannot approve an entry you recorded yourself';
  END IF;
  UPDATE staff_deductions SET status = 'approved', approved_by = v_uid, approved_at = now() WHERE id = p_id;
  RETURN jsonb_build_object('approved', true);
END; $function$;

-- ---------- public.reject_staff_deduction(uuid, text) ----------
CREATE OR REPLACE FUNCTION public.reject_staff_deduction(p_id uuid, p_reason text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE v_uid uuid := auth.uid(); v_row staff_deductions%ROWTYPE;
BEGIN
  IF NOT public.has_permission(v_uid, 'payroll'::module_key, 'reject'::action_key) THEN
    RAISE EXCEPTION 'Insufficient permissions';
  END IF;
  IF p_reason IS NULL OR btrim(p_reason) = '' THEN RAISE EXCEPTION 'A reason is required'; END IF;
  SELECT * INTO v_row FROM staff_deductions WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Entry not found'; END IF;
  IF v_row.status <> 'pending' THEN RAISE EXCEPTION 'Entry is already %', v_row.status; END IF;
  IF v_row.submitted_by = v_uid AND NOT (public.has_role(v_uid, 'super_admin') OR public.has_role(v_uid, 'chairman')) THEN
    RAISE EXCEPTION 'You cannot reject an entry you recorded yourself';
  END IF;
  UPDATE staff_deductions SET status = 'rejected', approved_by = v_uid, approved_at = now(), reject_reason = p_reason WHERE id = p_id;
  RETURN jsonb_build_object('rejected', true);
END; $function$;

-- ---------- public.approve_role_grant(uuid, text) ----------
CREATE OR REPLACE FUNCTION public.approve_role_grant(p_request_id uuid, p_comment text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE v_uid uuid := auth.uid(); v_req role_grant_requests%ROWTYPE; v_progress record;
BEGIN
  IF NOT public.has_permission(v_uid, 'users'::module_key, 'approve'::action_key) THEN RAISE EXCEPTION 'Insufficient permissions'; END IF;
  SELECT * INTO v_req FROM role_grant_requests WHERE id = p_request_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Request not found'; END IF;
  IF v_req.requested_by = v_uid AND NOT (public.has_role(v_uid, 'super_admin') OR public.has_role(v_uid, 'chairman')) THEN
    RAISE EXCEPTION 'You cannot approve a role change you requested yourself';
  END IF;

  PERFORM public.record_workflow_action('users', p_request_id, 'approve', v_req.status, v_req.status, p_comment);
  SELECT * INTO v_progress FROM public.workflow_approval_progress('users', p_request_id);
  IF NOT v_progress.satisfied THEN
    RETURN jsonb_build_object('approved', false, 'partial', true, 'approvals_so_far', v_progress.approvals_so_far, 'required', v_progress.required_approvals);
  END IF;

  PERFORM public.assert_valid_transition(v_req.status, 'approved');
  UPDATE role_grant_requests SET status = 'approved', reviewed_by = v_uid, reviewed_at = now() WHERE id = p_request_id;
  RETURN jsonb_build_object('approved', true, 'approvals_so_far', v_progress.approvals_so_far, 'required', v_progress.required_approvals);
END; $function$;

-- ---------- public.reject_role_grant(uuid, text) ----------
CREATE OR REPLACE FUNCTION public.reject_role_grant(p_request_id uuid, p_reason text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE v_uid uuid := auth.uid(); v_req role_grant_requests%ROWTYPE;
BEGIN
  IF NOT public.has_permission(v_uid, 'users'::module_key, 'reject'::action_key) THEN RAISE EXCEPTION 'Insufficient permissions'; END IF;
  SELECT * INTO v_req FROM role_grant_requests WHERE id = p_request_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Request not found'; END IF;
  IF v_req.requested_by = v_uid AND NOT (public.has_role(v_uid, 'super_admin') OR public.has_role(v_uid, 'chairman')) THEN
    RAISE EXCEPTION 'You cannot reject a role change you requested yourself';
  END IF;
  PERFORM public.assert_valid_transition(v_req.status, 'rejected');

  UPDATE role_grant_requests SET status = 'rejected', reviewed_by = v_uid, reviewed_at = now(), review_reason = p_reason WHERE id = p_request_id;
  PERFORM public.record_workflow_action('users', p_request_id, 'reject', v_req.status, 'rejected', p_reason);
  RETURN jsonb_build_object('rejected', true);
END; $function$;

-- ---------- public.post_role_grant(uuid, text) ----------
CREATE OR REPLACE FUNCTION public.post_role_grant(p_request_id uuid, p_comment text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE v_uid uuid := auth.uid(); v_req role_grant_requests%ROWTYPE;
BEGIN
  IF NOT public.has_permission(v_uid, 'users'::module_key, 'post'::action_key) THEN RAISE EXCEPTION 'Insufficient permissions'; END IF;
  SELECT * INTO v_req FROM role_grant_requests WHERE id = p_request_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Request not found'; END IF;
  IF v_req.requested_by = v_uid AND NOT (public.has_role(v_uid, 'super_admin') OR public.has_role(v_uid, 'chairman')) THEN
    RAISE EXCEPTION 'You cannot post a role change you requested yourself';
  END IF;
  PERFORM public.assert_valid_transition(v_req.status, 'posted');

  IF v_req.action = 'grant' THEN
    INSERT INTO user_roles(user_id, role, factory_id) VALUES (v_req.target_user_id, v_req.role, v_req.factory_id) ON CONFLICT (user_id, role, factory_id) DO NOTHING;
  ELSE
    DELETE FROM user_roles WHERE user_id = v_req.target_user_id AND role = v_req.role AND factory_id IS NOT DISTINCT FROM v_req.factory_id;
  END IF;

  UPDATE role_grant_requests SET status = 'posted', reviewed_by = v_uid, reviewed_at = now() WHERE id = p_request_id;
  PERFORM public.record_workflow_action('users', p_request_id, 'post', v_req.status, 'posted', p_comment);
  INSERT INTO audit_logs(user_id, factory_id, action, entity, entity_id, old_value, new_value)
  VALUES (v_uid, v_req.factory_id, 'post_role_' || v_req.action, 'user_roles', v_req.target_user_id::text,
          jsonb_build_object('action', v_req.action, 'role', v_req.role, 'requested_by', v_req.requested_by), jsonb_build_object('applied', true));
  RETURN jsonb_build_object('posted', true);
END; $function$;

-- ---------- public.reverse_role_grant(uuid, text) ----------
CREATE OR REPLACE FUNCTION public.reverse_role_grant(p_request_id uuid, p_reason text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE v_uid uuid := auth.uid(); v_req role_grant_requests%ROWTYPE;
BEGIN
  IF NOT public.has_permission(v_uid, 'users'::module_key, 'reverse'::action_key) THEN RAISE EXCEPTION 'Insufficient permissions'; END IF;
  IF p_reason IS NULL OR btrim(p_reason) = '' THEN RAISE EXCEPTION 'A reason is required to reverse a posted role change'; END IF;
  SELECT * INTO v_req FROM role_grant_requests WHERE id = p_request_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Request not found'; END IF;
  IF v_req.requested_by = v_uid AND NOT (public.has_role(v_uid, 'super_admin') OR public.has_role(v_uid, 'chairman')) THEN
    RAISE EXCEPTION 'You cannot reverse a role change you requested yourself';
  END IF;
  PERFORM public.assert_valid_transition(v_req.status, 'reversed');

  IF v_req.action = 'grant' THEN
    DELETE FROM user_roles WHERE user_id = v_req.target_user_id AND role = v_req.role AND factory_id IS NOT DISTINCT FROM v_req.factory_id;
  ELSE
    INSERT INTO user_roles(user_id, role, factory_id) VALUES (v_req.target_user_id, v_req.role, v_req.factory_id) ON CONFLICT (user_id, role, factory_id) DO NOTHING;
  END IF;

  UPDATE role_grant_requests SET status = 'reversed' WHERE id = p_request_id;
  PERFORM public.record_workflow_action('users', p_request_id, 'reverse', v_req.status, 'reversed', p_reason);
  INSERT INTO audit_logs(user_id, factory_id, action, entity, entity_id, old_value, new_value)
  VALUES (v_uid, v_req.factory_id, 'reverse_role_' || v_req.action, 'user_roles', v_req.target_user_id::text,
          jsonb_build_object('action', v_req.action, 'role', v_req.role), jsonb_build_object('reversed', true, 'reason', p_reason));
  RETURN jsonb_build_object('reversed', true);
END; $function$;

-- ---------- public.confirm_goods_receipt(uuid, text) ----------
CREATE OR REPLACE FUNCTION public.confirm_goods_receipt(p_id uuid, p_comment text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  v_req goods_receipts%ROWTYPE;
  v_before numeric;
  v_before_value numeric;
  v_before_unit_cost numeric;
  v_receipt_cost numeric;
  v_po_received numeric;
  v_po_status text;
BEGIN
  SELECT * INTO v_req FROM goods_receipts WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Goods receipt not found'; END IF;
  IF NOT public.has_permission(v_uid, 'goods-receiving', 'confirm'::action_key) THEN RAISE EXCEPTION 'Insufficient permissions'; END IF;
  IF v_req.submitted_by = v_uid AND NOT (public.has_role(v_uid, 'super_admin') OR public.has_role(v_uid, 'chairman')) THEN
    RAISE EXCEPTION 'You cannot confirm a goods receipt you submitted yourself — dual control requires a different person';
  END IF;

  PERFORM public.assert_valid_transition(v_req.status, 'confirmed');
  UPDATE goods_receipts SET status = 'confirmed', confirmed_by = v_uid, confirmed_at = now() WHERE id = p_id;
  PERFORM public.record_workflow_action('goods-receiving', p_id, 'confirm', v_req.status, 'confirmed', p_comment);

  PERFORM public.assert_valid_transition('confirmed', 'posted');
  SELECT current_stock, current_value, unit_cost INTO v_before, v_before_value, v_before_unit_cost FROM raw_materials WHERE id = v_req.material_id FOR UPDATE;
  v_receipt_cost := COALESCE(v_req.unit_cost, v_before_unit_cost);
  UPDATE raw_materials SET
    current_stock = current_stock + v_req.accepted_quantity,
    current_value = v_before_value + v_req.accepted_quantity * v_receipt_cost,
    unit_cost = COALESCE(v_req.unit_cost, unit_cost),
    supplier_id = COALESCE(v_req.supplier_id, supplier_id),
    updated_at = now()
  WHERE id = v_req.material_id;

  INSERT INTO raw_material_movements(factory_id, material_id, movement_type, quantity, unit_cost, reference, reason, user_id, quantity_before, quantity_after)
  VALUES (v_req.factory_id, v_req.material_id, 'received', v_req.accepted_quantity, v_receipt_cost, v_req.receipt_number,
          COALESCE(v_req.remarks, 'Goods receipt confirmed'), v_uid, v_before, v_before + v_req.accepted_quantity);

  IF v_req.damaged_quantity > 0 THEN
    INSERT INTO damage_records(factory_id, reference_number, source_type, source_reference, material_id, quantity, unit, unit_cost, reason, reported_by, approved_by, status)
    VALUES (v_req.factory_id, 'DMG-' || to_char(now(),'YYYYMMDD') || '-' || lpad(((floor(random()*99999))::int)::text, 5, '0'),
            'INVENTORY', v_req.receipt_number, v_req.material_id, v_req.damaged_quantity, v_req.unit, v_receipt_cost,
            'Damaged on goods receipt', v_req.submitted_by, v_uid, 'posted');
  END IF;

  UPDATE goods_receipts SET status = 'posted' WHERE id = p_id;
  PERFORM public.record_workflow_action('goods-receiving', p_id, 'post', 'confirmed', 'posted', p_comment);

  IF v_req.purchase_order_id IS NOT NULL THEN
    UPDATE purchase_orders SET quantity_received = quantity_received + v_req.quantity
    WHERE id = v_req.purchase_order_id
    RETURNING quantity_received, (CASE WHEN quantity_received >= quantity_ordered THEN 'received' ELSE 'partially_received' END)
    INTO v_po_received, v_po_status;
    UPDATE purchase_orders SET status = v_po_status WHERE id = v_req.purchase_order_id;

    IF v_po_status = 'received' THEN
      UPDATE production_requests SET production_status = 'completed'
      WHERE id = (SELECT purchase_request_id FROM purchase_orders WHERE id = v_req.purchase_order_id) AND request_type = 'purchase';
    END IF;
  ELSIF v_req.purchase_request_id IS NOT NULL THEN
    UPDATE production_requests SET production_status = 'completed' WHERE id = v_req.purchase_request_id AND request_type = 'purchase';
  END IF;

  INSERT INTO audit_logs(user_id, factory_id, action, entity, entity_id, old_value, new_value)
  VALUES (v_uid, v_req.factory_id, 'confirm_goods_receipt', 'goods_receipts', p_id::text,
          jsonb_build_object('current_stock', v_before), jsonb_build_object('current_stock', v_before + v_req.accepted_quantity));

  RETURN jsonb_build_object('confirmed', true, 'posted', true, 'accepted_quantity', v_req.accepted_quantity);
END; $function$;

-- ---------- public.reject_goods_receipt(uuid, text) ----------
CREATE OR REPLACE FUNCTION public.reject_goods_receipt(p_id uuid, p_reason text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE v_uid uuid := auth.uid(); v_req goods_receipts%ROWTYPE;
BEGIN
  IF p_reason IS NULL OR btrim(p_reason) = '' THEN RAISE EXCEPTION 'A reason is required to reject a goods receipt'; END IF;
  SELECT * INTO v_req FROM goods_receipts WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Goods receipt not found'; END IF;
  IF NOT public.has_permission(v_uid, 'goods-receiving'::module_key, 'reject'::action_key) THEN RAISE EXCEPTION 'Insufficient permissions'; END IF;
  IF v_req.submitted_by = v_uid AND NOT (public.has_role(v_uid, 'super_admin') OR public.has_role(v_uid, 'chairman')) THEN
    RAISE EXCEPTION 'You cannot reject a goods receipt you submitted yourself';
  END IF;
  PERFORM public.assert_valid_transition(v_req.status, 'rejected');

  UPDATE goods_receipts SET status = 'rejected', confirmed_by = v_uid, confirmed_at = now(), reject_reason = p_reason WHERE id = p_id;
  PERFORM public.record_workflow_action('goods-receiving', p_id, 'reject', v_req.status, 'rejected', p_reason);
  RETURN jsonb_build_object('rejected', true);
END; $function$;

-- ---------- public.approve_costing_sheet(uuid, text) ----------
CREATE OR REPLACE FUNCTION public.approve_costing_sheet(p_id uuid, p_comment text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE v_uid uuid := auth.uid(); v_row costing_sheets%ROWTYPE;
BEGIN
  SELECT * INTO v_row FROM costing_sheets WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Costing sheet not found'; END IF;
  IF NOT public.has_permission(v_uid, 'costing'::module_key, 'approve'::action_key) THEN RAISE EXCEPTION 'Insufficient permissions'; END IF;
  IF v_row.created_by = v_uid AND NOT (public.has_role(v_uid, 'super_admin') OR public.has_role(v_uid, 'chairman')) THEN
    RAISE EXCEPTION 'Costing approval must be done by someone other than who submitted the sheet';
  END IF;
  PERFORM public.assert_valid_transition(v_row.status, 'posted');

  UPDATE costing_sheets SET status = 'posted', approved_by = v_uid, approved_at = now() WHERE id = p_id;
  PERFORM public.record_workflow_action('costing', p_id, 'approve', v_row.status, 'posted', p_comment);

  IF v_row.apply_to_product THEN
    UPDATE products SET cost_price = v_row.cost_per_pack, updated_at = now() WHERE id = v_row.product_id;
    INSERT INTO audit_logs(user_id, factory_id, action, entity, entity_id, old_value, new_value)
    VALUES (v_uid, v_row.factory_id, 'approve_costing_sheet', 'products', v_row.product_id::text,
            jsonb_build_object('sheet_id', p_id), jsonb_build_object('cost_price', v_row.cost_per_pack));
  END IF;

  RETURN jsonb_build_object('approved', true, 'posted', true, 'applied', v_row.apply_to_product, 'cost_per_pack', v_row.cost_per_pack);
END; $function$;

-- ---------- public.reject_costing_sheet(uuid, text) ----------
CREATE OR REPLACE FUNCTION public.reject_costing_sheet(p_id uuid, p_reason text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE v_uid uuid := auth.uid(); v_row costing_sheets%ROWTYPE;
BEGIN
  IF p_reason IS NULL OR btrim(p_reason) = '' THEN RAISE EXCEPTION 'A reason is required to reject a costing sheet'; END IF;
  SELECT * INTO v_row FROM costing_sheets WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Costing sheet not found'; END IF;
  IF NOT public.has_permission(v_uid, 'costing'::module_key, 'reject'::action_key) THEN RAISE EXCEPTION 'Insufficient permissions'; END IF;
  IF v_row.created_by = v_uid AND NOT (public.has_role(v_uid, 'super_admin') OR public.has_role(v_uid, 'chairman')) THEN
    RAISE EXCEPTION 'You cannot reject a costing sheet you submitted yourself';
  END IF;
  PERFORM public.assert_valid_transition(v_row.status, 'rejected');

  UPDATE costing_sheets SET status = 'rejected', approved_by = v_uid, approved_at = now(), reject_reason = p_reason WHERE id = p_id;
  PERFORM public.record_workflow_action('costing', p_id, 'reject', v_row.status, 'rejected', p_reason);
  RETURN jsonb_build_object('rejected', true);
END; $function$;

-- ---------- public.confirm_production_batch(uuid, numeric, numeric, numeric, text) ----------
CREATE OR REPLACE FUNCTION public.confirm_production_batch(p_id uuid, p_actual_received numeric, p_damaged numeric, p_rejected numeric, p_comment text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_uid uuid := auth.uid(); v_row production%ROWTYPE; v_accepted numeric; v_before numeric; v_cost_price numeric;
BEGIN
  SELECT * INTO v_row FROM production WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Production batch not found'; END IF;
  IF NOT public.has_permission(v_uid, 'production', 'confirm'::action_key) THEN RAISE EXCEPTION 'Insufficient permissions'; END IF;
  IF v_row.created_by = v_uid AND NOT (public.has_role(v_uid, 'super_admin') OR public.has_role(v_uid, 'chairman')) THEN
    RAISE EXCEPTION 'Store confirmation must be done by someone other than who recorded the batch';
  END IF;
  IF p_actual_received IS NULL OR p_actual_received < 0 THEN RAISE EXCEPTION 'Actual quantity received must be >= 0'; END IF;
  IF COALESCE(p_damaged,0) < 0 OR COALESCE(p_rejected,0) < 0 THEN RAISE EXCEPTION 'Damaged/rejected quantities cannot be negative'; END IF;
  IF COALESCE(p_damaged,0) + COALESCE(p_rejected,0) > p_actual_received THEN
    RAISE EXCEPTION 'Damaged + rejected cannot exceed actual quantity received';
  END IF;
  v_accepted := p_actual_received - COALESCE(p_damaged,0) - COALESCE(p_rejected,0);

  PERFORM public.assert_valid_transition(v_row.status, 'confirmed');
  UPDATE production SET
    actual_quantity_received = p_actual_received, damaged_quantity = COALESCE(p_damaged,0),
    rejected_quantity = COALESCE(p_rejected,0), accepted_quantity = v_accepted,
    confirmed_by = v_uid, confirmed_at = now(), status = 'confirmed'
  WHERE id = p_id;
  PERFORM public.record_workflow_action('production', p_id, 'confirm', v_row.status, 'confirmed', p_comment);

  PERFORM public.assert_valid_transition('confirmed', 'posted');
  SELECT current_stock, cost_price INTO v_before, v_cost_price FROM products WHERE id = v_row.product_id FOR UPDATE;
  UPDATE products SET current_stock = current_stock + v_accepted, updated_at = now() WHERE id = v_row.product_id;
  INSERT INTO inventory_movements(factory_id, product_id, movement_type, quantity, reference, reason, user_id, quantity_before, quantity_after)
  VALUES (v_row.factory_id, v_row.product_id, 'produced', v_accepted, v_row.production_number,
          'Production batch confirmed by Store', v_uid, v_before, v_before + v_accepted);
  UPDATE production SET status = 'posted' WHERE id = p_id;
  PERFORM public.record_workflow_action('production', p_id, 'post', 'confirmed', 'posted', p_comment);

  IF COALESCE(p_damaged,0) > 0 THEN
    INSERT INTO damage_records(factory_id, reference_number, source_type, source_reference, product_id, quantity, unit, unit_cost, reason, reported_by, status)
    VALUES (v_row.factory_id, 'DMG-' || to_char(now(),'YYYYMMDD') || '-' || lpad(((floor(random()*99999))::int)::text, 5, '0'),
            'PRODUCTION', v_row.production_number, v_row.product_id, p_damaged, v_row.unit, v_cost_price, 'Damaged during Store confirmation', v_uid, 'posted');
  END IF;
  IF COALESCE(p_rejected,0) > 0 THEN
    INSERT INTO damage_records(factory_id, reference_number, source_type, source_reference, product_id, quantity, unit, unit_cost, reason, reported_by, status)
    VALUES (v_row.factory_id, 'DMG-' || to_char(now(),'YYYYMMDD') || '-' || lpad(((floor(random()*99999))::int)::text, 5, '0'),
            'PRODUCTION', v_row.production_number, v_row.product_id, p_rejected, v_row.unit, v_cost_price, 'Rejected during Store confirmation', v_uid, 'posted');
  END IF;

  INSERT INTO audit_logs(user_id, factory_id, action, entity, entity_id, old_value, new_value)
  VALUES (v_uid, v_row.factory_id, 'confirm_production_batch', 'production', p_id::text,
          jsonb_build_object('current_stock', v_before), jsonb_build_object('current_stock', v_before + v_accepted, 'accepted_quantity', v_accepted));

  RETURN jsonb_build_object('confirmed', true, 'posted', true, 'accepted_quantity', v_accepted);
END; $function$;

-- ---------- public.reject_production_batch(uuid, text) ----------
CREATE OR REPLACE FUNCTION public.reject_production_batch(p_id uuid, p_reason text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE v_uid uuid := auth.uid(); v_row production%ROWTYPE;
BEGIN
  IF p_reason IS NULL OR btrim(p_reason) = '' THEN RAISE EXCEPTION 'A reason is required to reject a production batch'; END IF;
  SELECT * INTO v_row FROM production WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Production batch not found'; END IF;
  IF NOT public.has_permission(v_uid, 'production'::module_key, 'reject'::action_key) THEN RAISE EXCEPTION 'Insufficient permissions'; END IF;
  IF v_row.created_by = v_uid AND NOT (public.has_role(v_uid, 'super_admin') OR public.has_role(v_uid, 'chairman')) THEN
    RAISE EXCEPTION 'You cannot reject a batch you recorded yourself';
  END IF;
  PERFORM public.assert_valid_transition(v_row.status, 'rejected');

  UPDATE production SET status = 'rejected', confirmed_by = v_uid, confirmed_at = now(), reject_reason = p_reason WHERE id = p_id;
  IF v_row.production_request_id IS NOT NULL THEN
    UPDATE production_requests SET production_status = 'materials_issued'
    WHERE id = v_row.production_request_id AND production_status = 'completed';
  END IF;
  PERFORM public.record_workflow_action('production', p_id, 'reject', v_row.status, 'rejected', p_reason);
  RETURN jsonb_build_object('rejected', true);
END; $function$;

-- ---------- public.approve_production_request(uuid, text) ----------
CREATE OR REPLACE FUNCTION public.approve_production_request(p_id uuid, p_approver_name text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_row production_requests%ROWTYPE; v_uid uuid := auth.uid();
  v_item production_request_items%ROWTYPE;
  v_material raw_materials%ROWTYPE;
  v_move_cost numeric;
BEGIN
  IF NOT public.has_permission(v_uid, 'production-requests', 'approve'::action_key) THEN RAISE EXCEPTION 'Insufficient permissions'; END IF;
  IF p_approver_name IS NULL OR btrim(p_approver_name) = '' THEN RAISE EXCEPTION 'Approver name is required'; END IF;
  SELECT * INTO v_row FROM production_requests WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Production request not found'; END IF;
  IF v_row.approval_status <> 'pending' THEN RAISE EXCEPTION 'Request is already %', v_row.approval_status; END IF;
  IF v_row.requested_by = v_uid AND NOT (public.has_role(v_uid, 'super_admin') OR public.has_role(v_uid, 'chairman')) THEN
    RAISE EXCEPTION 'You cannot approve a request you submitted yourself';
  END IF;
  IF v_row.request_type = 'production_material' AND NOT public.has_production_scope_access(v_uid, v_row.factory_id) THEN
    RAISE EXCEPTION 'Your production scope does not cover this factory';
  END IF;

  UPDATE production_requests SET
    approval_status = 'approved', approved_by_name = p_approver_name, approval_date = now(),
    production_status = 'approved'
  WHERE id = p_id;

  IF v_row.request_type = 'production_material' THEN
    FOR v_item IN SELECT * FROM production_request_items WHERE request_id = p_id LOOP
      SELECT * INTO v_material FROM raw_materials WHERE id = v_item.material_id FOR UPDATE;
      IF NOT FOUND THEN RAISE EXCEPTION 'Raw material not found for this request'; END IF;
      IF v_material.current_stock < v_item.quantity_requested THEN
        RAISE EXCEPTION 'Insufficient stock for %: have %, need %', v_material.name, v_material.current_stock, v_item.quantity_requested;
      END IF;
      v_move_cost := public.avg_unit_cost(v_material.current_value, v_material.current_stock, v_material.unit_cost);

      UPDATE raw_materials SET
        current_stock = current_stock - v_item.quantity_requested,
        current_value = current_value - v_item.quantity_requested * v_move_cost,
        updated_at = now()
      WHERE id = v_item.material_id;

      INSERT INTO raw_material_movements(factory_id, material_id, movement_type, quantity, unit_cost, reference, reason, user_id, quantity_before, quantity_after)
      VALUES (v_row.factory_id, v_item.material_id, 'used_for_production', v_item.quantity_requested, v_move_cost,
              v_row.request_number, 'Production Request ' || v_row.request_number, v_uid,
              v_material.current_stock, v_material.current_stock - v_item.quantity_requested);

      UPDATE production_request_items SET quantity_issued = quantity_requested WHERE id = v_item.id;
    END LOOP;

    UPDATE production_requests SET
      materials_issued = true, issued_by_name = p_approver_name, issued_at = now(),
      production_status = 'materials_issued'
    WHERE id = p_id;
  END IF;

  RETURN jsonb_build_object('approved', true);
END;
$function$;

-- ---------- public.reject_production_request(uuid, text, text) ----------
CREATE OR REPLACE FUNCTION public.reject_production_request(p_id uuid, p_approver_name text, p_reason text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE v_row production_requests%ROWTYPE; v_uid uuid := auth.uid();
BEGIN
  IF NOT public.has_permission(v_uid, 'production-requests'::module_key, 'reject'::action_key) THEN RAISE EXCEPTION 'Insufficient permissions'; END IF;
  IF p_approver_name IS NULL OR btrim(p_approver_name) = '' THEN RAISE EXCEPTION 'Approver name is required'; END IF;
  SELECT * INTO v_row FROM production_requests WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Production request not found'; END IF;
  IF v_row.approval_status <> 'pending' THEN RAISE EXCEPTION 'Request is already %', v_row.approval_status; END IF;
  IF v_row.requested_by = v_uid AND NOT (public.has_role(v_uid, 'super_admin') OR public.has_role(v_uid, 'chairman')) THEN
    RAISE EXCEPTION 'You cannot reject a request you submitted yourself';
  END IF;
  IF v_row.request_type = 'production_material' AND NOT public.has_production_scope_access(v_uid, v_row.factory_id) THEN
    RAISE EXCEPTION 'Your production scope does not cover this factory';
  END IF;

  UPDATE production_requests SET
    approval_status = 'rejected', approved_by_name = p_approver_name, approval_date = now(),
    production_status = 'rejected',
    remarks = CASE WHEN p_reason IS NOT NULL AND btrim(p_reason) <> ''
                   THEN COALESCE(remarks || E'\n', '') || 'Rejected: ' || p_reason ELSE remarks END
  WHERE id = p_id;

  RETURN jsonb_build_object('rejected', true);
END;
$function$;

-- ---------- public.approve_stock_adjustment(uuid, text) ----------
CREATE OR REPLACE FUNCTION public.approve_stock_adjustment(p_id uuid, p_comment text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE v_uid uuid := auth.uid(); v_req stock_adjustment_requests%ROWTYPE; v_module public.module_key; v_progress record;
BEGIN
  SELECT * INTO v_req FROM stock_adjustment_requests WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Request not found'; END IF;
  v_module := CASE v_req.entity_type WHEN 'raw_material' THEN 'raw-materials' ELSE 'finished-goods' END;
  IF NOT public.has_permission(v_uid, v_module, 'approve'::action_key) THEN RAISE EXCEPTION 'Insufficient permissions'; END IF;
  IF v_req.submitted_by = v_uid AND NOT (public.has_role(v_uid, 'super_admin') OR public.has_role(v_uid, 'chairman')) THEN
    RAISE EXCEPTION 'You cannot approve a stock write-off you submitted yourself';
  END IF;

  PERFORM public.record_workflow_action(v_module, p_id, 'approve', v_req.status, v_req.status, p_comment);
  SELECT * INTO v_progress FROM public.workflow_approval_progress(v_module, p_id);
  IF NOT v_progress.satisfied THEN
    RETURN jsonb_build_object('approved', false, 'partial', true, 'approvals_so_far', v_progress.approvals_so_far, 'required', v_progress.required_approvals);
  END IF;

  PERFORM public.assert_valid_transition(v_req.status, 'approved');
  UPDATE stock_adjustment_requests SET status = 'approved', reviewed_by = v_uid, reviewed_at = now() WHERE id = p_id;
  RETURN jsonb_build_object('approved', true, 'approvals_so_far', v_progress.approvals_so_far, 'required', v_progress.required_approvals);
END; $function$;

-- ---------- public.reject_stock_adjustment(uuid, text) ----------
CREATE OR REPLACE FUNCTION public.reject_stock_adjustment(p_id uuid, p_reason text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE v_uid uuid := auth.uid(); v_req stock_adjustment_requests%ROWTYPE; v_module public.module_key;
BEGIN
  SELECT * INTO v_req FROM stock_adjustment_requests WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Request not found'; END IF;
  v_module := CASE v_req.entity_type WHEN 'raw_material' THEN 'raw-materials' ELSE 'finished-goods' END;
  IF NOT public.has_permission(v_uid, v_module, 'reject'::action_key) THEN RAISE EXCEPTION 'Insufficient permissions'; END IF;
  IF v_req.submitted_by = v_uid AND NOT (public.has_role(v_uid, 'super_admin') OR public.has_role(v_uid, 'chairman')) THEN
    RAISE EXCEPTION 'You cannot reject a stock write-off you submitted yourself';
  END IF;
  PERFORM public.assert_valid_transition(v_req.status, 'rejected');

  UPDATE stock_adjustment_requests SET status = 'rejected', reviewed_by = v_uid, reviewed_at = now(), review_reason = p_reason WHERE id = p_id;
  PERFORM public.record_workflow_action(v_module, p_id, 'reject', v_req.status, 'rejected', p_reason);
  RETURN jsonb_build_object('rejected', true);
END; $function$;

-- ---------- public.reverse_stock_adjustment(uuid, text) ----------
CREATE OR REPLACE FUNCTION public.reverse_stock_adjustment(p_id uuid, p_reason text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_uid uuid := auth.uid(); v_req stock_adjustment_requests%ROWTYPE; v_module public.module_key;
  v_before numeric; v_unit_cost numeric; v_restore numeric;
BEGIN
  SELECT * INTO v_req FROM stock_adjustment_requests WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Request not found'; END IF;
  v_module := CASE v_req.entity_type WHEN 'raw_material' THEN 'raw-materials' ELSE 'finished-goods' END;
  IF NOT public.has_permission(v_uid, v_module, 'reverse'::action_key) THEN RAISE EXCEPTION 'Insufficient permissions'; END IF;
  IF p_reason IS NULL OR btrim(p_reason) = '' THEN RAISE EXCEPTION 'A reason is required to reverse a posted write-off'; END IF;
  IF v_req.submitted_by = v_uid AND NOT (public.has_role(v_uid, 'super_admin') OR public.has_role(v_uid, 'chairman')) THEN
    RAISE EXCEPTION 'You cannot reverse a stock write-off you submitted yourself';
  END IF;
  PERFORM public.assert_valid_transition(v_req.status, 'reversed');

  v_restore := abs(v_req.quantity_delta);
  IF v_req.entity_type = 'raw_material' THEN
    SELECT current_stock, unit_cost INTO v_before, v_unit_cost FROM raw_materials WHERE id = v_req.material_id FOR UPDATE;
    UPDATE raw_materials SET current_stock = current_stock + v_restore, updated_at = now() WHERE id = v_req.material_id;
    INSERT INTO raw_material_movements(factory_id, material_id, movement_type, quantity, unit_cost, reference, reason, user_id, quantity_before, quantity_after)
    VALUES (v_req.factory_id, v_req.material_id, 'adjusted', v_restore, v_unit_cost, 'Reversal of write-off', p_reason, v_uid, v_before, v_before + v_restore);
  ELSE
    SELECT current_stock INTO v_before FROM products WHERE id = v_req.product_id FOR UPDATE;
    UPDATE products SET current_stock = current_stock + v_restore, updated_at = now() WHERE id = v_req.product_id;
    INSERT INTO inventory_movements(factory_id, product_id, movement_type, quantity, reference, reason, user_id, quantity_before, quantity_after)
    VALUES (v_req.factory_id, v_req.product_id, 'adjusted', v_restore, 'Reversal of write-off', p_reason, v_uid, v_before, v_before + v_restore);
  END IF;

  UPDATE stock_adjustment_requests SET status = 'reversed' WHERE id = p_id;
  PERFORM public.record_workflow_action(v_module, p_id, 'reverse', v_req.status, 'reversed', p_reason);
  INSERT INTO audit_logs(user_id, factory_id, action, entity, entity_id, old_value, new_value)
  VALUES (v_uid, v_req.factory_id, 'reverse_stock_adjustment', v_req.entity_type, COALESCE(v_req.material_id, v_req.product_id)::text,
          jsonb_build_object('current_stock', v_before), jsonb_build_object('current_stock', v_before + v_restore, 'reason', p_reason));
  RETURN jsonb_build_object('reversed', true);
END; $function$;

-- ---------- public.post_stock_adjustment(uuid, text) ----------
CREATE OR REPLACE FUNCTION public.post_stock_adjustment(p_id uuid, p_comment text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_uid uuid := auth.uid(); v_req stock_adjustment_requests%ROWTYPE; v_module public.module_key;
  v_before numeric; v_before_value numeric; v_unit_cost numeric; v_unit text; v_move_cost numeric;
BEGIN
  SELECT * INTO v_req FROM stock_adjustment_requests WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Request not found'; END IF;
  v_module := CASE v_req.entity_type WHEN 'raw_material' THEN 'raw-materials' ELSE 'finished-goods' END;
  IF NOT public.has_permission(v_uid, v_module, 'post'::action_key) THEN RAISE EXCEPTION 'Insufficient permissions'; END IF;
  IF v_req.submitted_by = v_uid AND NOT (public.has_role(v_uid, 'super_admin') OR public.has_role(v_uid, 'chairman')) THEN
    RAISE EXCEPTION 'You cannot post a stock write-off you submitted yourself';
  END IF;
  PERFORM public.assert_valid_transition(v_req.status, 'posted');

  IF v_req.entity_type = 'raw_material' THEN
    SELECT current_stock, current_value, unit_cost, unit INTO v_before, v_before_value, v_unit_cost, v_unit FROM raw_materials WHERE id = v_req.material_id FOR UPDATE;
    IF v_req.quantity_delta >= 0 THEN
      v_move_cost := v_unit_cost;
    ELSE
      v_move_cost := public.avg_unit_cost(v_before_value, v_before, v_unit_cost);
    END IF;
    UPDATE raw_materials SET
      current_stock = current_stock + v_req.quantity_delta,
      current_value = v_before_value + v_req.quantity_delta * v_move_cost,
      updated_at = now()
    WHERE id = v_req.material_id;
    INSERT INTO raw_material_movements(factory_id, material_id, movement_type, quantity, unit_cost, reference, reason, user_id, quantity_before, quantity_after)
    VALUES (v_req.factory_id, v_req.material_id, v_req.movement_type::movement_type, v_req.quantity_delta, v_move_cost, 'Posted write-off',
            COALESCE(v_req.reason, 'Stock write-off'), v_uid, v_before, v_before + v_req.quantity_delta);
  ELSE
    SELECT current_stock, cost_price, unit INTO v_before, v_unit_cost, v_unit FROM products WHERE id = v_req.product_id FOR UPDATE;
    v_move_cost := v_unit_cost;
    UPDATE products SET current_stock = current_stock + v_req.quantity_delta, updated_at = now() WHERE id = v_req.product_id;
    INSERT INTO inventory_movements(factory_id, product_id, movement_type, quantity, reference, reason, user_id, quantity_before, quantity_after)
    VALUES (v_req.factory_id, v_req.product_id, v_req.movement_type::movement_type, v_req.quantity_delta, 'Posted write-off',
            COALESCE(v_req.reason, 'Stock write-off'), v_uid, v_before, v_before + v_req.quantity_delta);
  END IF;

  IF v_req.movement_type = 'damaged' THEN
    INSERT INTO damage_records(factory_id, reference_number, source_type, source_reference, product_id, material_id, quantity, unit, unit_cost, reason, reported_by, approved_by, status)
    VALUES (v_req.factory_id, 'DMG-' || to_char(now(),'YYYYMMDD') || '-' || lpad(((floor(random()*99999))::int)::text, 5, '0'),
            CASE WHEN v_req.entity_type = 'finished_good' THEN 'STORE' ELSE 'INVENTORY' END,
            p_id::text, v_req.product_id, v_req.material_id, abs(v_req.quantity_delta), v_unit, v_move_cost,
            v_req.reason, v_req.submitted_by, v_uid, 'posted');
  END IF;

  UPDATE stock_adjustment_requests SET status = 'posted', reviewed_by = v_uid, reviewed_at = now() WHERE id = p_id;
  PERFORM public.record_workflow_action(v_module, p_id, 'post', v_req.status, 'posted', p_comment);
  INSERT INTO audit_logs(user_id, factory_id, action, entity, entity_id, old_value, new_value)
  VALUES (v_uid, v_req.factory_id, 'post_stock_adjustment', v_req.entity_type, COALESCE(v_req.material_id, v_req.product_id)::text,
          jsonb_build_object('current_stock', v_before), jsonb_build_object('current_stock', v_before + v_req.quantity_delta));
  RETURN jsonb_build_object('posted', true);
END; $function$;

-- ---------- public.approve_new_material(uuid, text) ----------
CREATE OR REPLACE FUNCTION public.approve_new_material(p_id uuid, p_comment text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE v_uid uuid := auth.uid(); v_row raw_materials%ROWTYPE;
BEGIN
  SELECT * INTO v_row FROM raw_materials WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Material not found'; END IF;
  IF NOT public.has_permission(v_uid, 'raw-materials'::module_key, 'approve'::action_key) THEN RAISE EXCEPTION 'Insufficient permissions'; END IF;
  IF v_row.created_by = v_uid AND NOT (public.has_role(v_uid, 'super_admin') OR public.has_role(v_uid, 'chairman')) THEN
    RAISE EXCEPTION 'You cannot approve a material you added yourself';
  END IF;
  IF v_row.approval_status <> 'pending_approval' THEN RAISE EXCEPTION 'Material is already %', v_row.approval_status; END IF;

  UPDATE raw_materials SET approval_status = 'approved', active = true WHERE id = p_id;

  IF v_row.opening_stock > 0 THEN
    INSERT INTO raw_material_movements(factory_id, material_id, movement_type, quantity, unit_cost, reference, reason, user_id, quantity_before, quantity_after)
    VALUES (v_row.factory_id, v_row.id, 'opening_balance', v_row.opening_stock, v_row.unit_cost, v_row.name, 'Opening balance', v_uid, 0, v_row.opening_stock);
  END IF;

  INSERT INTO audit_logs(user_id, factory_id, action, entity, entity_id, new_value)
  VALUES (v_uid, v_row.factory_id, 'approve_new_material', 'raw_materials', p_id::text, jsonb_build_object('comment', p_comment));
  RETURN jsonb_build_object('approved', true);
END; $function$;

-- ---------- public.reject_new_material(uuid, text) ----------
CREATE OR REPLACE FUNCTION public.reject_new_material(p_id uuid, p_reason text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE v_uid uuid := auth.uid(); v_row raw_materials%ROWTYPE;
BEGIN
  SELECT * INTO v_row FROM raw_materials WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Material not found'; END IF;
  IF NOT public.has_permission(v_uid, 'raw-materials'::module_key, 'reject'::action_key) THEN RAISE EXCEPTION 'Insufficient permissions'; END IF;
  IF v_row.created_by = v_uid AND NOT (public.has_role(v_uid, 'super_admin') OR public.has_role(v_uid, 'chairman')) THEN
    RAISE EXCEPTION 'You cannot reject a material you added yourself';
  END IF;
  IF v_row.approval_status <> 'pending_approval' THEN RAISE EXCEPTION 'Material is already %', v_row.approval_status; END IF;

  UPDATE raw_materials SET
    approval_status = 'rejected', active = false,
    remarks = CASE WHEN p_reason IS NOT NULL AND btrim(p_reason) <> ''
                   THEN COALESCE(remarks || E'\n', '') || 'Rejected: ' || p_reason ELSE remarks END
  WHERE id = p_id;
  RETURN jsonb_build_object('rejected', true);
END; $function$;

-- ---------- public.inspect_sales_return(uuid, numeric, numeric, numeric, text) ----------
CREATE OR REPLACE FUNCTION public.inspect_sales_return(p_id uuid, p_accepted numeric, p_damaged numeric, p_rejected numeric, p_notes text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  v_row sales_returns%ROWTYPE;
  v_before numeric;
  v_cost_price numeric;
BEGIN
  SELECT * INTO v_row FROM sales_returns WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Sales return not found'; END IF;
  IF NOT public.has_permission(v_uid, 'sales'::module_key, 'confirm'::action_key) THEN RAISE EXCEPTION 'Insufficient permissions'; END IF;
  IF v_row.received_by = v_uid AND NOT (public.has_role(v_uid, 'super_admin') OR public.has_role(v_uid, 'chairman')) THEN
    RAISE EXCEPTION 'Inspection must be done by someone other than who logged the return';
  END IF;
  IF v_row.status <> 'received' THEN RAISE EXCEPTION 'This return has already been inspected'; END IF;
  IF COALESCE(p_accepted,0) < 0 OR COALESCE(p_damaged,0) < 0 OR COALESCE(p_rejected,0) < 0 THEN
    RAISE EXCEPTION 'Quantities cannot be negative';
  END IF;
  IF COALESCE(p_accepted,0) + COALESCE(p_damaged,0) + COALESCE(p_rejected,0) <> v_row.quantity_returned THEN
    RAISE EXCEPTION 'Accepted + damaged + rejected must equal the % returned', v_row.quantity_returned;
  END IF;

  UPDATE sales_returns SET
    accepted_quantity = p_accepted, damaged_quantity = COALESCE(p_damaged,0), rejected_quantity = COALESCE(p_rejected,0),
    inspected_by = v_uid, inspected_at = now(), status = 'completed', notes = p_notes
  WHERE id = p_id;

  IF COALESCE(p_accepted,0) > 0 THEN
    SELECT current_stock INTO v_before FROM products WHERE id = v_row.product_id FOR UPDATE;
    UPDATE products SET current_stock = current_stock + p_accepted, updated_at = now() WHERE id = v_row.product_id;
    INSERT INTO inventory_movements(factory_id, product_id, movement_type, quantity, reference, reason, user_id, quantity_before, quantity_after)
    VALUES (v_row.factory_id, v_row.product_id, 'returned', p_accepted, v_row.return_number, 'Accepted sales return', v_uid, v_before, v_before + p_accepted);
  END IF;

  IF COALESCE(p_damaged,0) > 0 THEN
    SELECT cost_price INTO v_cost_price FROM products WHERE id = v_row.product_id;
    INSERT INTO damage_records(factory_id, reference_number, source_type, source_reference, product_id, quantity, unit, unit_cost, reason, reported_by, status)
    VALUES (v_row.factory_id, 'DMG-' || to_char(now(),'YYYYMMDD') || '-' || lpad(((floor(random()*99999))::int)::text, 5, '0'),
            'SALES_RETURN', v_row.return_number, v_row.product_id, p_damaged, v_row.unit, v_cost_price, 'Damaged on sales return inspection', v_uid, 'posted');
  END IF;

  RETURN jsonb_build_object('completed', true, 'accepted', p_accepted, 'damaged', p_damaged, 'rejected', p_rejected);
END; $function$;

-- ---------- public.approve_sale(uuid, text) ----------
CREATE OR REPLACE FUNCTION public.approve_sale(p_id uuid, p_comment text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  v_row sales%ROWTYPE;
  v_item RECORD;
  v_receipt_prefix text;
  v_receipt text;
  v_pay_line jsonb;
  v_line_amount numeric;
  v_line_method payment_method;
  v_move_reason text;
  v_before numeric;
  v_customer_credit numeric;
  v_credit_to_apply numeric := 0;
  v_final_balance numeric;
  v_excess numeric := 0;
BEGIN
  SELECT * INTO v_row FROM sales WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Sale not found'; END IF;
  IF NOT public.has_permission(v_uid, 'sales'::module_key, 'approve'::action_key) THEN RAISE EXCEPTION 'Insufficient permissions'; END IF;
  IF v_row.created_by = v_uid AND NOT (public.has_role(v_uid, 'super_admin') OR public.has_role(v_uid, 'chairman')) THEN
    RAISE EXCEPTION 'Approval must be done by someone other than who recorded the sale';
  END IF;
  PERFORM public.assert_valid_transition(v_row.status, 'posted');

  -- The authoritative credit draw-down: however much the customer has
  -- available right now, automatically applied to whatever cash didn't
  -- cover -- not limited to (or by) whatever was estimated at submission.
  -- Locks the customer row so a concurrent sale for the same customer
  -- can't double-spend the same credit.
  IF v_row.customer_id IS NOT NULL AND NOT v_row.is_pr THEN
    SELECT credit_balance INTO v_customer_credit FROM customers WHERE id = v_row.customer_id FOR UPDATE;
    v_customer_credit := COALESCE(v_customer_credit, 0);
    v_credit_to_apply := LEAST(GREATEST(v_row.grand_total - v_row.amount_paid, 0), v_customer_credit);
  END IF;
  v_final_balance := GREATEST(v_row.grand_total - v_row.amount_paid - v_credit_to_apply, 0);

  v_move_reason := CASE WHEN v_row.is_pr THEN 'PR - complimentary, no charge' ELSE 'Sale' END;

  -- Re-validate and apply stock now, at approval time -- availability may
  -- have moved since the sale was submitted.
  FOR v_item IN SELECT si.product_id, si.quantity FROM sale_items si WHERE si.sale_id = p_id LOOP
    IF v_row.sales_rep_id IS NOT NULL THEN
      SELECT quantity INTO v_before FROM rep_stock WHERE sales_rep_id = v_row.sales_rep_id AND product_id = v_item.product_id FOR UPDATE;
      IF COALESCE(v_before,0) < v_item.quantity THEN
        RAISE EXCEPTION 'Insufficient van stock for a line on this sale (product %)', v_item.product_id;
      END IF;
      UPDATE rep_stock SET quantity = quantity - v_item.quantity, updated_at = now()
       WHERE sales_rep_id = v_row.sales_rep_id AND product_id = v_item.product_id;
      INSERT INTO rep_stock_movements(factory_id, sales_rep_id, product_id, movement_type, quantity, reference, reason, user_id, quantity_before, quantity_after)
      VALUES (v_row.factory_id, v_row.sales_rep_id, v_item.product_id, 'sold', -v_item.quantity, v_row.invoice_number, v_move_reason, v_uid, v_before, v_before - v_item.quantity);
    ELSE
      SELECT current_stock INTO v_before FROM products WHERE id = v_item.product_id FOR UPDATE;
      IF v_before IS NULL OR v_before < v_item.quantity THEN
        RAISE EXCEPTION 'Insufficient stock for a line on this sale (product %): have %, need %', v_item.product_id, COALESCE(v_before,0), v_item.quantity;
      END IF;
      UPDATE products SET current_stock = current_stock - v_item.quantity, updated_at = now() WHERE id = v_item.product_id;
      INSERT INTO inventory_movements(factory_id, product_id, movement_type, quantity, reference, reason, user_id, quantity_before, quantity_after)
      VALUES (v_row.factory_id, v_item.product_id, 'sold', v_item.quantity, v_row.invoice_number, v_move_reason, v_uid, v_before, v_before - v_item.quantity);
    END IF;
  END LOOP;

  IF v_row.pending_payments IS NOT NULL AND jsonb_array_length(v_row.pending_payments) > 0 THEN
    FOR v_pay_line IN SELECT * FROM jsonb_array_elements(v_row.pending_payments) LOOP
      v_line_amount := (v_pay_line->>'amount')::numeric;
      v_line_method := COALESCE((v_pay_line->>'method')::payment_method, 'cash');
      IF v_line_amount IS NULL OR v_line_amount <= 0 THEN CONTINUE; END IF;

      SELECT COALESCE(receipt_prefix,'RCP-') INTO v_receipt_prefix FROM settings WHERE factory_id = v_row.factory_id;
      IF v_receipt_prefix IS NULL THEN v_receipt_prefix := 'RCP-'; END IF;
      v_receipt := v_receipt_prefix || to_char(now(),'YYYYMMDD') || '-' || lpad(((floor(random()*99999))::int)::text, 5, '0');

      INSERT INTO payments_received(factory_id, receipt_number, customer_id, sale_id, amount, payment_method, payment_date, received_by, remarks)
      VALUES (v_row.factory_id, v_receipt, v_row.customer_id, p_id, v_line_amount, v_line_method, v_row.sale_date, v_uid, 'Payment at point of sale');
    END LOOP;
  END IF;

  IF v_final_balance > 0 THEN
    INSERT INTO debts(factory_id, customer_id, sale_id, sales_rep_id, total_amount, amount_paid, outstanding, status)
    VALUES (v_row.factory_id, v_row.customer_id, p_id, v_row.sales_rep_id, v_row.grand_total, v_row.amount_paid, v_final_balance,
            CASE WHEN v_row.amount_paid > 0 OR v_credit_to_apply > 0 THEN 'partial'::debt_status ELSE 'unpaid'::debt_status END);
  END IF;

  -- Cash alone paying more than the grand total (credit draw-down is
  -- already capped so it can never itself cause this) becomes new credit
  -- instead of silently disappearing.
  v_excess := GREATEST(v_row.amount_paid - v_row.grand_total, 0);

  IF v_row.customer_id IS NOT NULL THEN
    UPDATE customers
       SET total_purchases = total_purchases + v_row.grand_total,
           outstanding_balance = outstanding_balance + v_final_balance,
           total_transactions = total_transactions + 1,
           credit_balance = credit_balance - v_credit_to_apply + v_excess,
           updated_at = now()
     WHERE id = v_row.customer_id;
  END IF;

  UPDATE sales SET
    status = 'posted', approved_by = v_uid, approved_at = now(),
    credit_applied = v_credit_to_apply, balance = v_final_balance
  WHERE id = p_id;
  PERFORM public.record_workflow_action('sales', p_id, 'approve', v_row.status, 'posted', p_comment);

  INSERT INTO audit_logs(user_id, factory_id, action, entity, entity_id, old_value, new_value)
  VALUES (v_uid, v_row.factory_id, 'approve_sale', 'sales', p_id::text,
          jsonb_build_object('status', v_row.status), jsonb_build_object('status', 'posted', 'credit_applied', v_credit_to_apply, 'balance', v_final_balance));

  RETURN jsonb_build_object('sale_id', p_id, 'status', 'posted', 'credit_applied', v_credit_to_apply, 'balance', v_final_balance);
END;
$function$;

-- ---------- public.reject_sale(uuid, text) ----------
CREATE OR REPLACE FUNCTION public.reject_sale(p_id uuid, p_reason text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  v_row sales%ROWTYPE;
BEGIN
  IF p_reason IS NULL OR btrim(p_reason) = '' THEN RAISE EXCEPTION 'A rejection reason is required'; END IF;
  SELECT * INTO v_row FROM sales WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Sale not found'; END IF;
  IF NOT public.has_permission(v_uid, 'sales'::module_key, 'reject'::action_key) THEN RAISE EXCEPTION 'Insufficient permissions'; END IF;
  IF v_row.created_by = v_uid AND NOT (public.has_role(v_uid, 'super_admin') OR public.has_role(v_uid, 'chairman')) THEN
    RAISE EXCEPTION 'Rejection must be done by someone other than who recorded the sale';
  END IF;
  PERFORM public.assert_valid_transition(v_row.status, 'rejected');

  UPDATE sales SET status = 'rejected', rejected_reason = p_reason WHERE id = p_id;
  PERFORM public.record_workflow_action('sales', p_id, 'reject', v_row.status, 'rejected', p_reason);

  RETURN jsonb_build_object('sale_id', p_id, 'status', 'rejected');
END;
$function$;


-- ---------- RLS policies hardcoded to super_admin, outside has_permission() ----------
DROP POLICY IF EXISTS "permission overrides read own" ON public.permission_overrides;
CREATE POLICY "permission overrides read own" ON public.permission_overrides FOR SELECT TO authenticated
  USING (user_id = auth.uid() OR public.has_role(auth.uid(), 'super_admin') OR public.has_role(auth.uid(), 'chairman'));

DROP POLICY IF EXISTS "role permissions write" ON public.role_permissions;
CREATE POLICY "role permissions write" ON public.role_permissions FOR ALL TO authenticated
  USING (public.has_role(auth.uid(), 'super_admin') OR public.has_role(auth.uid(), 'chairman'))
  WITH CHECK (public.has_role(auth.uid(), 'super_admin') OR public.has_role(auth.uid(), 'chairman'));

DROP POLICY IF EXISTS "permission overrides write" ON public.permission_overrides;
CREATE POLICY "permission overrides write" ON public.permission_overrides FOR ALL TO authenticated
  USING (public.has_role(auth.uid(), 'super_admin') OR public.has_role(auth.uid(), 'chairman'))
  WITH CHECK (public.has_role(auth.uid(), 'super_admin') OR public.has_role(auth.uid(), 'chairman'));

DROP POLICY IF EXISTS "workflow configs write" ON public.workflow_configs;
CREATE POLICY "workflow configs write" ON public.workflow_configs FOR UPDATE TO authenticated
  USING (public.has_role(auth.uid(), 'super_admin') OR public.has_role(auth.uid(), 'chairman'))
  WITH CHECK (public.has_role(auth.uid(), 'super_admin') OR public.has_role(auth.uid(), 'chairman'));

DROP POLICY IF EXISTS "roles write" ON public.roles;
CREATE POLICY "roles write" ON public.roles FOR INSERT TO authenticated
  WITH CHECK (public.has_role(auth.uid(), 'super_admin') OR public.has_role(auth.uid(), 'chairman'));

DROP POLICY IF EXISTS "roles update" ON public.roles;
CREATE POLICY "roles update" ON public.roles FOR UPDATE TO authenticated
  USING (public.has_role(auth.uid(), 'super_admin') OR public.has_role(auth.uid(), 'chairman'))
  WITH CHECK (public.has_role(auth.uid(), 'super_admin') OR public.has_role(auth.uid(), 'chairman'));

-- Can't delete a system role, ever -- unchanged. Chairman just also gets to
-- delete non-system roles now, same as super_admin already could.
DROP POLICY IF EXISTS "roles delete" ON public.roles;
CREATE POLICY "roles delete" ON public.roles FOR DELETE TO authenticated
  USING ((public.has_role(auth.uid(), 'super_admin') OR public.has_role(auth.uid(), 'chairman')) AND NOT is_system);

DROP POLICY IF EXISTS "sales read deleted" ON public.sales;
CREATE POLICY "sales read deleted" ON public.sales FOR SELECT TO authenticated
  USING ((public.has_role(auth.uid(), 'super_admin') OR public.has_role(auth.uid(), 'chairman')) AND deleted_at IS NOT NULL);

DROP POLICY IF EXISTS "delete requests read" ON public.delete_requests;
CREATE POLICY "delete requests read" ON public.delete_requests FOR SELECT TO authenticated
  USING (public.has_role(auth.uid(), 'super_admin') OR public.has_role(auth.uid(), 'chairman') OR requested_by = auth.uid());

-- ---------- cleanup: drop the temporary source-reader helper ----------
DROP FUNCTION IF EXISTS public.__temp_get_source(text);
