-- ============================================================================
-- profiles.status VOCABULARY RENAME (approved->active, disabled->deactivated)
-- + set_user_department() RPC
-- ----------------------------------------------------------------------------
-- Matches the spec's PENDING/ACTIVE/SUSPENDED/DEACTIVATED vocabulary.
-- 'rejected' stays as-is (real, valuable state with a reason attached -- not
-- part of the spec's 4 but not something to silently drop either).
--
-- SCOPE GUARDRAIL: 'approved' is also a value of the unrelated
-- workflow_status domain used by expenses.status, payroll.status,
-- role_grant_requests.status, debts.writeoff_status, etc. This migration
-- touches ONLY public.profiles.status and the two functions below -- not a
-- project-wide rename.
--
-- The CHECK constraint is dropped BEFORE the UPDATE that writes the new
-- values, not after (writing 'active' while the old constraint -- which only
-- allows 'approved' -- is still in effect would fail, same class of bug
-- fixed in 20260815095000_flow_status_columns.sql earlier today).
-- ============================================================================

ALTER TABLE public.profiles DROP CONSTRAINT IF EXISTS profiles_status_check;

UPDATE public.profiles SET status = 'active' WHERE status = 'approved';
UPDATE public.profiles SET status = 'deactivated' WHERE status = 'disabled';

ALTER TABLE public.profiles ADD CONSTRAINT profiles_status_check
  CHECK (status IN ('pending','active','suspended','rejected','deactivated'));

-- set_user_status(): no signature change (still uuid, text) -- plain replace,
-- just the status-literal vocabulary inside the body.
CREATE OR REPLACE FUNCTION public.set_user_status(target_id uuid, new_status text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_profile profiles%ROWTYPE;
BEGIN
  IF NOT public.has_permission(v_uid, 'account-approvals', 'write') THEN RAISE EXCEPTION 'Insufficient permissions'; END IF;
  IF new_status NOT IN ('suspended','deactivated','active') THEN
    RAISE EXCEPTION 'Invalid status transition';
  END IF;
  SELECT * INTO v_profile FROM profiles WHERE id = target_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Account not found'; END IF;

  UPDATE profiles SET status = new_status WHERE id = target_id;

  IF new_status IN ('suspended', 'deactivated') THEN
    DELETE FROM user_roles WHERE user_id = target_id;
  END IF;

  INSERT INTO notifications (user_id, factory_id, title, body)
  VALUES (target_id, v_profile.requested_factory_id,
          CASE new_status
            WHEN 'suspended' THEN 'Account suspended'
            WHEN 'deactivated' THEN 'Account deactivated'
            ELSE 'Account reinstated'
          END,
          CASE new_status
            WHEN 'suspended' THEN 'Your account has been suspended. Please contact your administrator.'
            WHEN 'deactivated' THEN 'Your account has been deactivated. Please contact your administrator.'
            ELSE 'Your account is active again. Please ask an administrator to re-assign your role.'
          END);

  INSERT INTO audit_logs(user_id, factory_id, action, entity, entity_id, old_value, new_value)
  VALUES (v_uid, v_profile.requested_factory_id, 'set_user_status', 'profiles', target_id::text,
          jsonb_build_object('status', v_profile.status), jsonb_build_object('status', new_status));

  RETURN jsonb_build_object('status', new_status);
END;
$$;
GRANT EXECUTE ON FUNCTION public.set_user_status(uuid, text) TO authenticated;

-- New: edit department after the initial approval (approve_user sets it
-- at approval time; this covers later changes), same guard pattern.
CREATE OR REPLACE FUNCTION public.set_user_department(target_id uuid, new_department text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_old text;
BEGIN
  IF NOT public.has_permission(v_uid, 'account-approvals', 'write') THEN RAISE EXCEPTION 'Insufficient permissions'; END IF;
  SELECT department INTO v_old FROM profiles WHERE id = target_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Account not found'; END IF;

  UPDATE profiles SET department = new_department WHERE id = target_id;

  INSERT INTO audit_logs(user_id, factory_id, action, entity, entity_id, old_value, new_value)
  SELECT v_uid, requested_factory_id, 'set_user_department', 'profiles', target_id::text,
         jsonb_build_object('department', v_old), jsonb_build_object('department', new_department)
  FROM profiles WHERE id = target_id;

  RETURN jsonb_build_object('department', new_department);
END;
$$;
GRANT EXECUTE ON FUNCTION public.set_user_department(uuid, text) TO authenticated;
