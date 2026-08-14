
-- ============ PROFILES: registration + approval fields ============
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS username text;
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS department text;
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS role_requested public.app_role;
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS requested_factory_id uuid REFERENCES public.factories(id);
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'pending';
ALTER TABLE public.profiles ADD CONSTRAINT profiles_status_check
  CHECK (status IN ('pending','approved','suspended','rejected','disabled'));
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS approved_by uuid REFERENCES auth.users(id);
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS approved_at timestamptz;
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS rejected_by uuid REFERENCES auth.users(id);
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS rejected_reason text;
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS rejected_at timestamptz;

CREATE UNIQUE INDEX IF NOT EXISTS profiles_username_key ON public.profiles (lower(username)) WHERE username IS NOT NULL;

-- ============ REGISTRATION: first user auto-approved as super_admin, everyone else pending ============
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  user_count int;
  is_first boolean;
  default_factory uuid;
  requested_factory uuid;
BEGIN
  SELECT count(*) INTO user_count FROM auth.users;
  is_first := user_count <= 1;

  SELECT id INTO default_factory FROM public.factories WHERE code = 'water' LIMIT 1;
  requested_factory := NULLIF(NEW.raw_user_meta_data->>'requested_factory_id','')::uuid;

  INSERT INTO public.profiles (
    id, full_name, email, phone, username, department, role_requested,
    requested_factory_id, active_factory_id, status, approved_by, approved_at
  )
  VALUES (
    NEW.id,
    COALESCE(NEW.raw_user_meta_data->>'full_name', NEW.email),
    NEW.email,
    NEW.raw_user_meta_data->>'phone',
    NEW.raw_user_meta_data->>'username',
    NEW.raw_user_meta_data->>'department',
    NULLIF(NEW.raw_user_meta_data->>'role_requested','')::app_role,
    requested_factory,
    COALESCE(requested_factory, default_factory),
    CASE WHEN is_first THEN 'approved' ELSE 'pending' END,
    CASE WHEN is_first THEN NEW.id ELSE NULL END,
    CASE WHEN is_first THEN now() ELSE NULL END
  );

  IF is_first THEN
    INSERT INTO public.user_roles (user_id, role) VALUES (NEW.id, 'super_admin');
  END IF;

  RETURN NEW;
END;
$$;

-- ============ APPROVAL ACTIONS ============
CREATE OR REPLACE FUNCTION public.approve_user(target_id uuid, granted_role public.app_role DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_profile profiles%ROWTYPE;
  v_role app_role;
BEGIN
  SELECT * INTO v_profile FROM profiles WHERE id = target_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Account not found'; END IF;

  v_role := COALESCE(granted_role, v_profile.role_requested, 'viewer'::app_role);

  UPDATE profiles SET
    status = 'approved',
    approved_by = v_uid,
    approved_at = now(),
    rejected_by = NULL, rejected_reason = NULL, rejected_at = NULL
  WHERE id = target_id;

  INSERT INTO user_roles (user_id, role, factory_id)
  VALUES (target_id, v_role, v_profile.requested_factory_id)
  ON CONFLICT (user_id, role, factory_id) DO NOTHING;

  INSERT INTO notifications (user_id, factory_id, title, body)
  VALUES (target_id, v_profile.requested_factory_id, 'Account approved', 'Your account has been approved. You can now log in.');

  INSERT INTO audit_logs(user_id, factory_id, action, entity, entity_id, old_value, new_value)
  VALUES (v_uid, v_profile.requested_factory_id, 'approve_user', 'profiles', target_id::text,
          jsonb_build_object('status', v_profile.status),
          jsonb_build_object('status', 'approved', 'role', v_role));

  RETURN jsonb_build_object('status', 'approved', 'role', v_role);
END;
$$;
GRANT EXECUTE ON FUNCTION public.approve_user(uuid, public.app_role) TO anon, authenticated;

CREATE OR REPLACE FUNCTION public.reject_user(target_id uuid, reason text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_profile profiles%ROWTYPE;
BEGIN
  IF reason IS NULL OR trim(reason) = '' THEN RAISE EXCEPTION 'A rejection reason is required'; END IF;
  SELECT * INTO v_profile FROM profiles WHERE id = target_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Account not found'; END IF;

  UPDATE profiles SET
    status = 'rejected',
    rejected_by = v_uid,
    rejected_reason = reason,
    rejected_at = now()
  WHERE id = target_id;

  DELETE FROM user_roles WHERE user_id = target_id;

  INSERT INTO notifications (user_id, factory_id, title, body)
  VALUES (target_id, v_profile.requested_factory_id, 'Account registration declined',
          'Your account registration has been declined. Please contact your administrator.');

  INSERT INTO audit_logs(user_id, factory_id, action, entity, entity_id, old_value, new_value)
  VALUES (v_uid, v_profile.requested_factory_id, 'reject_user', 'profiles', target_id::text,
          jsonb_build_object('status', v_profile.status),
          jsonb_build_object('status', 'rejected', 'reason', reason));

  RETURN jsonb_build_object('status', 'rejected');
END;
$$;
GRANT EXECUTE ON FUNCTION public.reject_user(uuid, text) TO anon, authenticated;

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
  IF new_status NOT IN ('suspended','disabled','approved') THEN
    RAISE EXCEPTION 'Invalid status transition';
  END IF;
  SELECT * INTO v_profile FROM profiles WHERE id = target_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Account not found'; END IF;

  UPDATE profiles SET status = new_status WHERE id = target_id;

  INSERT INTO notifications (user_id, factory_id, title, body)
  VALUES (target_id, v_profile.requested_factory_id,
          CASE new_status
            WHEN 'suspended' THEN 'Account suspended'
            WHEN 'disabled' THEN 'Account disabled'
            ELSE 'Account reinstated'
          END,
          CASE new_status
            WHEN 'suspended' THEN 'Your account has been suspended. Please contact your administrator.'
            WHEN 'disabled' THEN 'Your account has been disabled. Please contact your administrator.'
            ELSE 'Your account is active again. You can now log in.'
          END);

  INSERT INTO audit_logs(user_id, factory_id, action, entity, entity_id, old_value, new_value)
  VALUES (v_uid, v_profile.requested_factory_id, 'set_user_status', 'profiles', target_id::text,
          jsonb_build_object('status', v_profile.status), jsonb_build_object('status', new_status));

  RETURN jsonb_build_object('status', new_status);
END;
$$;
GRANT EXECUTE ON FUNCTION public.set_user_status(uuid, text) TO anon, authenticated;

-- Deleting the auth.users row itself needs the Admin API (service-role key), which this
-- app doesn't have. This removes everything we CAN remove client-side (profile, roles) so
-- the account disappears from every list the app shows. The underlying login credential in
-- auth.users is untouched until a service-role-backed admin delete can also purge it; the
-- client's post-login check treats "no profile found" the same as a disabled account.
CREATE OR REPLACE FUNCTION public.delete_user_account(target_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
BEGIN
  INSERT INTO audit_logs(user_id, factory_id, action, entity, entity_id, old_value, new_value)
  SELECT v_uid, requested_factory_id, 'delete_user', 'profiles', target_id::text, to_jsonb(p), NULL
  FROM profiles p WHERE p.id = target_id;

  DELETE FROM user_roles WHERE user_id = target_id;
  DELETE FROM profiles WHERE id = target_id;

  RETURN jsonb_build_object('deleted', true);
END;
$$;
GRANT EXECUTE ON FUNCTION public.delete_user_account(uuid) TO anon, authenticated;
