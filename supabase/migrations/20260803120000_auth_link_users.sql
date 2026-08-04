-- =============================================================================
-- 20260803120000_auth_link_users.sql
-- Links public.users to Supabase Auth (auth.users). New work — not part of
-- the original database/postgres/ design, which predates any Supabase
-- integration; see supabase/migrations/README.md.
-- =============================================================================

-- A real boolean flag instead of string-matching a role name in every RLS
-- policy in 20260803120200+ — matching against `app_roles.name` directly
-- would silently stop working the moment someone renames the role.
ALTER TABLE app_roles ADD COLUMN IF NOT EXISTS is_super_admin BOOLEAN NOT NULL DEFAULT false;

-- Idempotent structural seeding — this must not depend on database/postgres/seed/seed.sql
-- (demo data, not run in production per its own README) ever having run. A
-- production deploy with zero rows in app_roles would have no super-admin
-- role and no default role for handle_new_user() below to assign.
INSERT INTO app_roles (name, description, scope, status, is_super_admin)
VALUES ('System administrator', 'Full access to every module and setting', 'Global', 'ACTIVE', true)
ON CONFLICT (name) DO UPDATE SET is_super_admin = true;

INSERT INTO app_roles (name, description, scope, status, is_super_admin)
VALUES ('Unassigned', 'No module access until granted a real role by an administrator', NULL, 'ACTIVE', false)
ON CONFLICT (name) DO NOTHING;

-- Nullable: existing/seed users predate Supabase Auth entirely and have no
-- auth.users row to point at. ON DELETE CASCADE — deleting the Auth identity
-- deletes the app profile with it (soft-delete-by-approval doesn't apply to
-- an identity that no longer exists to log in with).
ALTER TABLE users ADD COLUMN IF NOT EXISTS auth_user_id UUID UNIQUE REFERENCES auth.users(id) ON DELETE CASCADE;

-- The one function every RLS policy and every actor-stamping trigger in this
-- migration set builds on: "which public.users row is the currently
-- authenticated request?" SECURITY DEFINER + fixed search_path is required
-- here (and for is_super_admin()/has_page_access() in 20260803120200) — the
-- standard Supabase RLS-helper pattern, specifically so a policy on `users`
-- calling this function doesn't recurse back into RLS on `users` itself.
CREATE OR REPLACE FUNCTION current_app_user_id()
RETURNS UUID
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT id FROM users WHERE auth_user_id = auth.uid() LIMIT 1;
$$;
REVOKE ALL ON FUNCTION current_app_user_id() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION current_app_user_id() TO authenticated, anon;

-- Provisions a public.users row the moment someone signs up in Supabase
-- Auth. Defaults to the zero-permission 'Unassigned' role — secure by
-- default; nothing beyond a bare login exists until an administrator
-- explicitly grants a real role (see supabase/functions/admin-provision-user).
-- Reuses fn_next_code (0011/20260101000011) rather than a new counter.
CREATE OR REPLACE FUNCTION handle_new_user()
RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  INSERT INTO users (code, full_name, email, role_id, status, auth_user_id)
  VALUES (
    fn_next_code('USR-'),
    COALESCE(NEW.raw_user_meta_data ->> 'full_name', NEW.email),
    NEW.email,
    (SELECT id FROM app_roles WHERE name = 'Unassigned'),
    'ACTIVE',
    NEW.id
  );
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION handle_new_user();
