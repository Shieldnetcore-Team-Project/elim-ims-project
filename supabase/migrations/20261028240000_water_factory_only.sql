-- ============================================================================
-- One factory: the Water Factory
-- ----------------------------------------------------------------------------
-- The user's rule (2026-10-28): the system is for the Water Factory only --
-- remove everything about any other factory. The app already works only in
-- the Water Factory (src/lib/factory-store.ts); this removes what is left in
-- the database:
--   * staff first: a role or a profile tied to another factory moves to the
--     Water Factory, so nobody loses access when that factory goes;
--   * every other factory (the original "Nylon Factory") is deleted, and with
--     it whatever was filed under it (products, settings, records -- the
--     foreign keys cascade). An audit row lists how much of each went;
--   * production scope: every account becomes WATER (no NYLON / BOTH), and
--     production types set to BOTH become WATER; any set to NYLON are
--     switched off.
-- The customer ledger and jug movements are append-only (their guards refuse
-- any delete); the guards are paused only while the other factory's rows are
-- removed, and switched back on straight after, in the same transaction.
-- Its records are removed table by table first (every table with a
-- factory_id, repeated until the foreign keys allow it), then the factory.
-- If it still can't be deleted, it is left with a notice naming the reason.
-- Safe to run again.
-- ============================================================================

DO $$
DECLARE
  v_water uuid;
  v_f record;
  v_counts jsonb;
  v_t record;
  v_pass int;
  v_n bigint;
  v_progress boolean;
BEGIN
  SELECT id INTO v_water FROM factories WHERE code = 'water';
  IF v_water IS NULL THEN
    RAISE EXCEPTION 'No Water factory found -- nothing changed';
  END IF;

  -- Staff: roles and profiles move to the Water Factory.
  DELETE FROM user_roles ur
   WHERE ur.factory_id IS NOT NULL AND ur.factory_id <> v_water
     AND EXISTS (SELECT 1 FROM user_roles w
                  WHERE w.user_id = ur.user_id AND w.role = ur.role AND w.factory_id = v_water);
  UPDATE user_roles SET factory_id = v_water WHERE factory_id IS NOT NULL AND factory_id <> v_water;
  UPDATE profiles SET active_factory_id = v_water WHERE active_factory_id IS DISTINCT FROM v_water;

  -- Production scope: Water only.
  UPDATE profiles SET production_scope = 'WATER' WHERE production_scope IS DISTINCT FROM 'WATER';
  UPDATE production_types SET production_scope = 'WATER' WHERE production_scope = 'BOTH';
  UPDATE production_types SET active = false WHERE production_scope = 'NYLON' AND active;

  -- Every other factory goes (append-only guards paused just for this).
  ALTER TABLE public.customer_account_transactions DISABLE TRIGGER trg_cat_immutable;
  ALTER TABLE public.container_movements DISABLE TRIGGER trg_cm_immutable;
  FOR v_f IN SELECT id, code, name FROM factories WHERE id <> v_water LOOP
    SELECT jsonb_build_object(
             'products', (SELECT count(*) FROM products WHERE factory_id = v_f.id),
             'raw_materials', (SELECT count(*) FROM raw_materials WHERE factory_id = v_f.id),
             'sales', (SELECT count(*) FROM sales WHERE factory_id = v_f.id),
             'production', (SELECT count(*) FROM production WHERE factory_id = v_f.id),
             'customers', (SELECT count(*) FROM customers WHERE factory_id = v_f.id),
             'marketers', (SELECT count(*) FROM sales_reps WHERE factory_id = v_f.id),
             'expenses', (SELECT count(*) FROM expenses WHERE factory_id = v_f.id))
      INTO v_counts;
    -- Its records first, table by table (every public table with a
    -- factory_id), in as many passes as the foreign keys need: a row still
    -- referenced elsewhere fails this pass and goes in a later one.
    -- Production batches and requests point at each other: unlink first.
    UPDATE production_requests SET production_id = NULL WHERE factory_id = v_f.id AND production_id IS NOT NULL;
    UPDATE production SET production_request_id = NULL WHERE factory_id = v_f.id AND production_request_id IS NOT NULL;
    FOR v_pass IN 1..12 LOOP
      v_progress := false;
      FOR v_t IN SELECT c.table_name FROM information_schema.columns c
                   JOIN information_schema.tables t ON t.table_schema = c.table_schema AND t.table_name = c.table_name
                  WHERE c.table_schema = 'public' AND c.column_name = 'factory_id'
                    AND t.table_type = 'BASE TABLE' AND c.table_name <> 'factories' LOOP
        BEGIN
          EXECUTE format('DELETE FROM public.%I WHERE factory_id = $1', v_t.table_name) USING v_f.id;
          GET DIAGNOSTICS v_n = ROW_COUNT;
          IF v_n > 0 THEN v_progress := true; END IF;
        EXCEPTION WHEN OTHERS THEN NULL;  -- referenced still; next pass
        END;
      END LOOP;
      EXIT WHEN NOT v_progress;
    END LOOP;
    BEGIN
      DELETE FROM factories WHERE id = v_f.id;
      INSERT INTO audit_logs(user_id, factory_id, action, entity, entity_id, old_value, new_value)
      VALUES (auth.uid(), v_water, 'delete', 'factories', v_f.id::text,
              jsonb_build_object('code', v_f.code, 'name', v_f.name, 'removed_with_it', v_counts),
              jsonb_build_object('reason', 'Water Factory only (2026-10-28)'));
      RAISE NOTICE 'Removed % (%): %', v_f.name, v_f.code, v_counts;
    EXCEPTION WHEN OTHERS THEN
      RAISE NOTICE 'Could not remove % (%): % -- left as it is', v_f.name, v_f.code, SQLERRM;
    END;
  END LOOP;
  ALTER TABLE public.customer_account_transactions ENABLE TRIGGER trg_cat_immutable;
  ALTER TABLE public.container_movements ENABLE TRIGGER trg_cm_immutable;
END $$;
