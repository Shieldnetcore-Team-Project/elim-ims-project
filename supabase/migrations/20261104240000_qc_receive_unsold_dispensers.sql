-- ============================================================================
-- QC receives unsold dispensers from marketers and distributors
-- ----------------------------------------------------------------------------
-- User (2026-11-04): "add receiving returned dispensers to all marketers and
-- distributors in warehouse and qc page". The QC page's Dispenser tab now has
-- "Receive unsold dispensers" (the Warehouse's form: from a marketer --
-- create_rep_return -- or from a distributor/customer --
-- warehouse_customer_returnable / warehouse_receive_customer_return). Those
-- need distribution submit or sales-returns submit; every QC officer gets
-- both on their own account (permission_overrides). Pages are unchanged --
-- page access still decides what they see. Safe to run again.
-- ============================================================================

DO $$
DECLARE r record; n int := 0;
BEGIN
  FOR r IN SELECT DISTINCT p.id, COALESCE(p.full_name, p.email) AS who
             FROM user_roles ur JOIN profiles p ON p.id = ur.user_id
            WHERE ur.role = 'qc_officer'
              AND NOT (public.has_role(p.id, 'super_admin') OR public.has_role(p.id, 'chairman')) LOOP
    INSERT INTO permission_overrides (user_id, module, action, granted)
    SELECT r.id, m::module_key, 'submit'::action_key, true
      FROM unnest(ARRAY['distribution', 'sales-returns']) m
    ON CONFLICT (user_id, module, action) DO UPDATE SET granted = true, granted_at = now();
    INSERT INTO audit_logs(user_id, factory_id, action, entity, entity_id, new_value)
    VALUES (auth.uid(), NULL, 'grant', 'permission_overrides', r.id::text,
            jsonb_build_object('who', r.who, 'modules', jsonb_build_array('distribution', 'sales-returns'),
                               'action', 'submit',
                               'reason', 'QC receives unsold dispensers (2026-11-04)'));
    RAISE NOTICE '% can receive unsold dispensers', r.who;
    n := n + 1;
  END LOOP;
  RAISE NOTICE '% QC account(s) updated', n;
END $$;
