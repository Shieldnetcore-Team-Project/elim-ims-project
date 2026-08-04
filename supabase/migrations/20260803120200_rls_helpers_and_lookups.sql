-- =============================================================================
-- 20260803120200_rls_helpers_and_lookups.sql
-- RLS helper functions, plus RLS for every open-ended lookup table (0002)
-- and structural/junction table these policies themselves depend on.
-- =============================================================================

-- ---- Helpers ----------------------------------------------------------------
-- SECURITY DEFINER + fixed search_path, same reasoning as current_app_user_id()
-- (20260803120000) — a policy that calls these must not recurse back through
-- RLS on the tables they read.
CREATE OR REPLACE FUNCTION is_super_admin()
RETURNS BOOLEAN
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT COALESCE(
    (SELECT r.is_super_admin FROM users u JOIN app_roles r ON r.id = u.role_id
     WHERE u.id = current_app_user_id()),
    false
  );
$$;
REVOKE ALL ON FUNCTION is_super_admin() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION is_super_admin() TO authenticated, anon;

-- Reuses v_effective_page_access (20260101000013) — the role-baseline ∪
-- per-user-grant union already defined there — rather than reimplementing it.
CREATE OR REPLACE FUNCTION has_page_access(p_page_key TEXT)
RETURNS BOOLEAN
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT is_super_admin() OR EXISTS (
    SELECT 1 FROM v_effective_page_access
    WHERE user_id = current_app_user_id() AND page_key = p_page_key
  );
$$;
REVOKE ALL ON FUNCTION has_page_access(TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION has_page_access(TEXT) TO authenticated, anon;

-- ---- Lookup tables: read-open to any authenticated session, writes admin-only
-- Same policy shape repeated per table — no DELETE policy anywhere in this
-- migration set; hard delete should never succeed through a normal session.
DO $$
DECLARE
  t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'departments', 'locations', 'warehouse_locations', 'item_categories', 'uoms',
    'job_titles', 'production_lines', 'shifts', 'water_sources', 'treatment_stages',
    'chart_of_accounts', 'pages', 'deletable_entities'
  ]
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY %I ON %I FOR SELECT TO authenticated USING (true)',
      t || '_select', t
    );
    EXECUTE format(
      'CREATE POLICY %I ON %I FOR INSERT TO authenticated WITH CHECK (is_super_admin() OR has_page_access(''control-panel''))',
      t || '_insert', t
    );
    EXECUTE format(
      'CREATE POLICY %I ON %I FOR UPDATE TO authenticated USING (is_super_admin() OR has_page_access(''control-panel'')) WITH CHECK (is_super_admin() OR has_page_access(''control-panel''))',
      t || '_update', t
    );
  END LOOP;
END $$;

-- code_sequences: written only by fn_next_code (SECURITY INVOKER by default —
-- it runs as whatever role called it, so callers still need write access here).
-- Same lookup shape, but INSERT/UPDATE gated to any authenticated user rather
-- than admin-only, since fn_next_code's ON CONFLICT DO UPDATE is how every
-- module's create action gets its code — restricting it to admins would break
-- every "create X" flow.
ALTER TABLE code_sequences ENABLE ROW LEVEL SECURITY;
ALTER TABLE code_sequences FORCE ROW LEVEL SECURITY;
CREATE POLICY code_sequences_select ON code_sequences FOR SELECT TO authenticated USING (true);
CREATE POLICY code_sequences_insert ON code_sequences FOR INSERT TO authenticated WITH CHECK (true);
CREATE POLICY code_sequences_update ON code_sequences FOR UPDATE TO authenticated USING (true) WITH CHECK (true);

-- role_page_access / user_page_access: read open to any authenticated user
-- (a user needs to read their own effective access to render a nav menu),
-- writes admin-only via the 'roles'/'users' pages respectively.
ALTER TABLE role_page_access ENABLE ROW LEVEL SECURITY;
ALTER TABLE role_page_access FORCE ROW LEVEL SECURITY;
CREATE POLICY role_page_access_select ON role_page_access FOR SELECT TO authenticated USING (true);
CREATE POLICY role_page_access_insert ON role_page_access FOR INSERT TO authenticated WITH CHECK (is_super_admin() OR has_page_access('roles'));
CREATE POLICY role_page_access_update ON role_page_access FOR UPDATE TO authenticated USING (is_super_admin() OR has_page_access('roles')) WITH CHECK (is_super_admin() OR has_page_access('roles'));

ALTER TABLE user_page_access ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_page_access FORCE ROW LEVEL SECURITY;
CREATE POLICY user_page_access_select ON user_page_access FOR SELECT TO authenticated USING (true);
CREATE POLICY user_page_access_insert ON user_page_access FOR INSERT TO authenticated WITH CHECK (is_super_admin() OR has_page_access('users'));
CREATE POLICY user_page_access_update ON user_page_access FOR UPDATE TO authenticated USING (is_super_admin() OR has_page_access('users')) WITH CHECK (is_super_admin() OR has_page_access('users'));
