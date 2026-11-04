-- ============================================================================
-- Discount / payment rights for two Accounts staff
-- ----------------------------------------------------------------------------
-- User (2026-11-04): "please return the enter discount for accountant to
-- enter when entering payment before printing invoice for
-- donoralemmanuel@gmail.com and majose1558@gmail.com".
--
-- The Discount (per product) and Pay buttons -- on distributor invoices, on
-- marketers' and the shop's postings, on shop sales -- show to whoever may
-- write Payments or Debts, the same right adjust_sale_lines and
-- set_posting_discount check. Both accounts get Payments and Debts view and
-- create on their own account (permission_overrides). Safe to run again.
-- ============================================================================

DO $$
DECLARE r record;
BEGIN
  FOR r IN SELECT id, COALESCE(full_name, email) AS who FROM profiles
            WHERE lower(btrim(email)) IN ('donoralemmanuel@gmail.com', 'majose1558@gmail.com') LOOP
    INSERT INTO permission_overrides (user_id, module, action, granted)
    SELECT r.id, m::module_key, a::action_key, true
      FROM unnest(ARRAY['payments', 'debts']) m, unnest(ARRAY['view', 'create']) a
    ON CONFLICT (user_id, module, action) DO UPDATE SET granted = true, granted_at = now();
    INSERT INTO audit_logs(user_id, factory_id, action, entity, entity_id, new_value)
    VALUES (auth.uid(), NULL, 'grant', 'permission_overrides', r.id::text,
            jsonb_build_object('who', r.who, 'modules', jsonb_build_array('payments', 'debts'),
                               'actions', jsonb_build_array('view', 'create'),
                               'reason', 'Accounts enter discounts and payments before printing (2026-11-04)'));
    RAISE NOTICE '% can give discounts and take payments', r.who;
  END LOOP;
  IF NOT FOUND THEN RAISE NOTICE 'Neither email has an account -- nothing changed'; END IF;
END $$;
