-- ============================================================================
-- Remove the 31 Oct releases of the hall opening; hall and Warehouse cleared
-- ----------------------------------------------------------------------------
-- The user (2026-10-31): after the hall opening (20261031090000) Production
-- released it to the Warehouse -- 75cl Bottle Water 1,612 Pack (accepted)
-- and 50cl Bottle Water 2,571 Pack (not yet accepted). Clear them all from
-- the system: not back into the Warehouse's stock, not back into the
-- Production hall. The 31 Oct Products Report should then read
--   50cl  Opening 51      Out 10  Balance 41
--   75cl  Opening 13,277  Out 10  Balance 13,267  (with 20261031100000)
--
-- For each product, its 31 Oct releases are removed as if they never
-- happened: an accepted one takes its stock back out (the 'produced' line
-- it posted is deleted, with any damage records it raised), and the release
-- and its audit lines go. The hall opening of 31 Oct is set to 0, so
-- nothing returns to the hall. A copy of everything removed goes to the
-- audit log.
--
-- Only while that day's releases add up to exactly 1,612 / 2,571; anything
-- else changes nothing for that product and says so. Safe to run again.
-- ============================================================================

DO $$
DECLARE
  v_factory uuid := (SELECT id FROM factories WHERE code = 'water');
  v_t record;
  v_pid uuid;
  v_ids uuid[];
  v_nums text[];
  v_total numeric;
  v_back numeric;
  v_stock numeric;
  v_copy jsonb := '[]'::jsonb;
BEGIN
  IF v_factory IS NULL THEN
    RAISE NOTICE 'No Water factory -- nothing changed';
    RETURN;
  END IF;

  FOR v_t IN
    SELECT * FROM (VALUES ('50cl Bottle Water', '50cl bottle water', 2571::numeric),
                          ('75cl Bottle Water', '75cl bottle water', 1612::numeric))
           AS t(label, name, qty)
  LOOP
    v_pid := (SELECT id FROM products
               WHERE factory_id = v_factory AND product_type = 'finished' AND lower(btrim(name)) = v_t.name);
    IF v_pid IS NULL THEN
      RAISE NOTICE '%: not found -- not changed', v_t.label;
      CONTINUE;
    END IF;

    -- Its releases of 31 Oct that still count (pending or accepted).
    v_ids := ARRAY(SELECT id FROM production_releases
                    WHERE factory_id = v_factory AND product_id = v_pid
                      AND status IN ('pending', 'accepted')
                      AND (released_at AT TIME ZONE 'Africa/Lagos')::date = '2026-10-31');
    v_total := COALESCE((SELECT SUM(quantity) FROM production_releases WHERE id = ANY (v_ids)), 0);
    -- Other releases since (e.g. a new batch released later that day) stay:
    -- then only the one release of exactly that quantity goes.
    IF v_total <> v_t.qty
       AND (SELECT count(*) FROM production_releases WHERE id = ANY (v_ids) AND quantity = v_t.qty) = 1 THEN
      v_ids := ARRAY(SELECT id FROM production_releases WHERE id = ANY (v_ids) AND quantity = v_t.qty);
      v_total := v_t.qty;
    END IF;
    IF cardinality(v_ids) = 0 THEN
      RAISE NOTICE '%: no release of 31 Oct left -- nothing to remove', v_t.label;
    ELSIF v_total <> v_t.qty THEN
      RAISE NOTICE '%: 31 Oct releases add up to % (expected %) -- not changed; say which to remove',
        v_t.label, v_total, v_t.qty;
      CONTINUE;
    ELSE
      v_nums := ARRAY(SELECT release_number FROM production_releases WHERE id = ANY (v_ids));
      PERFORM 1 FROM products WHERE id = v_pid FOR UPDATE;
      v_stock := (SELECT current_stock FROM products WHERE id = v_pid);
      -- What the accepted ones added to the Warehouse's stock.
      v_back := COALESCE((SELECT SUM(COALESCE(quantity_after - quantity_before, quantity))
                            FROM inventory_movements
                           WHERE product_id = v_pid AND movement_type = 'produced'
                             AND reference = ANY (v_nums)), 0);
      IF v_stock - v_back < 0 THEN
        RAISE NOTICE '%: stock % is below the % accepted -- not changed', v_t.label, v_stock, v_back;
        CONTINUE;
      END IF;

      v_copy := v_copy || jsonb_build_object(
        'product', v_t.label,
        'releases', (SELECT jsonb_agg(to_jsonb(r)) FROM production_releases r WHERE r.id = ANY (v_ids)),
        'stock_lines', (SELECT jsonb_agg(to_jsonb(m)) FROM inventory_movements m
                         WHERE m.product_id = v_pid AND m.reference = ANY (v_nums)),
        'damage_records', (SELECT jsonb_agg(to_jsonb(d)) FROM damage_records d
                            WHERE d.source_type = 'PRODUCTION' AND d.source_reference = ANY (v_nums)),
        'stock_before', v_stock, 'stock_after', v_stock - v_back);

      UPDATE products SET current_stock = current_stock - v_back, updated_at = now() WHERE id = v_pid;
      DELETE FROM inventory_movements WHERE product_id = v_pid AND reference = ANY (v_nums);
      DELETE FROM damage_records WHERE source_type = 'PRODUCTION' AND source_reference = ANY (v_nums);
      DELETE FROM audit_logs WHERE entity = 'production_releases' AND entity_id = ANY (ARRAY(SELECT x::text FROM unnest(v_ids) x));
      DELETE FROM production_releases WHERE id = ANY (v_ids);
      RAISE NOTICE '%: % release(s) of % removed (%); Warehouse stock % -> %',
        v_t.label, cardinality(v_ids), v_total, array_to_string(v_nums, ', '), v_stock, v_stock - v_back;
    END IF;

    -- Nothing goes back to the hall: its 31 Oct opening becomes 0.
    IF EXISTS (SELECT 1 FROM production_hall_openings
                WHERE factory_id = v_factory AND product_id = v_pid AND opening_date = '2026-10-31' AND quantity <> 0) THEN
      UPDATE production_hall_openings
         SET quantity = 0,
             reason = reason || ' -- set to 0: released and cleared from the system (user, 31 Oct 2026)'
       WHERE factory_id = v_factory AND product_id = v_pid AND opening_date = '2026-10-31';
      RAISE NOTICE '%: hall opening of 31 Oct set to 0', v_t.label;
    END IF;
    RAISE NOTICE '%: in hall now %', v_t.label, public._production_hall_available(v_factory, v_pid);
  END LOOP;

  IF jsonb_array_length(v_copy) > 0 THEN
    INSERT INTO audit_logs(user_id, factory_id, action, entity, entity_id, old_value, new_value)
    VALUES (auth.uid(), v_factory, 'delete', 'production_releases', 'hall-releases-cleared-2026-10-31', v_copy,
            jsonb_build_object('reason',
              '31 Oct releases of the hall opening (75cl 1,612, 50cl 2,571) cleared from the system: not in Warehouse stock, not back in the hall'));
  END IF;
END $$;
