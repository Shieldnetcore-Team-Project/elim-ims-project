-- ============================================================================
-- Gideon: post to distributors, and the Finished Products page
-- ----------------------------------------------------------------------------
-- Factory decision (user, 2026-10-28): Gideon (gideonsunday24@gmail.com,
-- Warehouse Manager) posts to distributors too, and works from Warehouse →
-- Finished Products (Post, Restock, Add Product, the stock table) like the
-- Warehouse role does. A distributor posting is a sale on the distributor's
-- account, and a new distributor is a registered customer, so for his
-- account only (his role is not changed):
--   * sales      view, create, submit, print, export  -- Post → Distributors
--   * customers  view, create, edit                   -- pick / add a distributor
--   * pages: Warehouse › Finished Products and Warehouse › Stock allowed.
-- Restocking (finished-goods:create) and accepting Production Releases came
-- with 20261028130000. Nothing changes unless exactly one account has his
-- email. Safe to run again.
-- ============================================================================

DO $$
DECLARE
  v_count int;
  v_user uuid;
  v_name text;
  v_factory uuid;
BEGIN
  SELECT count(*) INTO v_count FROM profiles WHERE lower(btrim(email)) = 'gideonsunday24@gmail.com';
  IF v_count <> 1 THEN
    RAISE NOTICE 'Skipped: % accounts have gideonsunday24@gmail.com -- give the rights in Admin Panel → Users', v_count;
    RETURN;
  END IF;
  SELECT id, COALESCE(full_name, email) INTO v_user, v_name FROM profiles
   WHERE lower(btrim(email)) = 'gideonsunday24@gmail.com';

  INSERT INTO permission_overrides (user_id, module, action, granted)
  SELECT v_user, m::module_key, a::action_key, true
    FROM (VALUES ('sales', 'view'), ('sales', 'create'), ('sales', 'submit'), ('sales', 'print'), ('sales', 'export'),
                 ('customers', 'view'), ('customers', 'create'), ('customers', 'edit'),
                 ('finished-goods', 'create')) AS t(m, a)
  ON CONFLICT (user_id, module, action) DO UPDATE SET granted = true, granted_at = now();

  INSERT INTO user_page_access (user_id, page_id, granted)
  SELECT v_user, p, true FROM unnest(ARRAY['Warehouse › Finished Products', 'Warehouse › Stock']) AS p
  ON CONFLICT (user_id, page_id) DO UPDATE SET granted = true, granted_at = now();

  SELECT factory_id INTO v_factory FROM user_roles WHERE user_id = v_user AND factory_id IS NOT NULL LIMIT 1;
  INSERT INTO audit_logs(user_id, factory_id, action, entity, entity_id, new_value)
  VALUES (auth.uid(), v_factory, 'grant_permission', 'permission_overrides', v_user::text,
          jsonb_build_object('rights', jsonb_build_array('sales: view/create/submit/print/export',
                                                         'customers: view/create/edit', 'finished-goods: create'),
                             'pages', jsonb_build_array('Warehouse › Finished Products', 'Warehouse › Stock'),
                             'reason', format('%s posts to distributors from Finished Products (2026-10-28)', v_name)));
  RAISE NOTICE '% can now post to distributors from Warehouse → Finished Products', v_name;
END $$;
