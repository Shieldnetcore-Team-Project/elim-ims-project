-- ============================================================================
-- H-Medix is a distributor, not a marketer
-- ----------------------------------------------------------------------------
-- H-Medix was set up as a marketer (sales_reps). It comes off the marketers
-- list and is a registered customer (distributor) instead.
--
--   * Matched loosely: any spelling that reads "hmedix" once spaces and
--     punctuation are dropped (H-Medix, H MEDIX, HMedix...).
--   * The marketer row is deleted. If it already has history (dispatches,
--     sales, returns, remittances), it can't be deleted without losing that,
--     so it is set inactive and renamed so it no longer reads as a marketer.
--     Customers assigned to it are unassigned either way.
--   * The distributor: the existing customer is marked registered (the seed
--     already lists "H MEDIX"), or one is created.
-- Safe to re-run.
-- ============================================================================

DO $$
DECLARE
  v_factory uuid;
  v_rep record;
BEGIN
  SELECT id INTO v_factory FROM factories WHERE code = 'water';
  IF v_factory IS NULL THEN RETURN; END IF;

  FOR v_rep IN
    SELECT id, full_name FROM sales_reps
     WHERE factory_id = v_factory
       AND regexp_replace(lower(full_name), '[^a-z0-9]', '', 'g') = 'hmedix'
  LOOP
    UPDATE customers SET sales_rep_id = NULL WHERE sales_rep_id = v_rep.id;
    BEGIN
      DELETE FROM rep_stock WHERE sales_rep_id = v_rep.id AND quantity = 0;
      DELETE FROM sales_reps WHERE id = v_rep.id;
    EXCEPTION WHEN foreign_key_violation THEN
      UPDATE sales_reps
         SET status = 'inactive',
             full_name = v_rep.full_name || ' (moved to distributors)',
             updated_at = now()
       WHERE id = v_rep.id;
    END;
  END LOOP;

  IF EXISTS (SELECT 1 FROM customers
              WHERE factory_id = v_factory
                AND regexp_replace(lower(name), '[^a-z0-9]', '', 'g') = 'hmedix') THEN
    UPDATE customers SET registered = true
     WHERE factory_id = v_factory
       AND regexp_replace(lower(name), '[^a-z0-9]', '', 'g') = 'hmedix';
  ELSE
    INSERT INTO customers (factory_id, name, registered) VALUES (v_factory, 'H-Medix', true);
  END IF;
END;
$$;
