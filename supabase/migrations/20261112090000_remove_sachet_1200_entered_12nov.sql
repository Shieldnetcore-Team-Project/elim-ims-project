-- ============================================================================
-- Remove the 1,200 Sachet Water batch entered on the morning of 12 Nov
-- ----------------------------------------------------------------------------
-- User (2026-11-12): "clear the 1200 sachet water entered now, clear it from
-- the system -- production sheet entry. In the products report of yesterday
-- we are having 1,977 after entering the night shift."
--
-- Before noon the Production form suggests last night's shift, so the batch
-- went onto 11 Nov: the Products Report for 11 Nov reads
--   1,271 + 6,177 - 4,271 = 3,177   (with it)
--   1,271 + 4,977 - 4,271 = 1,977   (without it -- the right figure)
--
-- Removes exactly one batch: Sachet Water, 1,200, dated 11 Nov, entered on
-- 12 Nov (Lagos), still in the production hall. Anything else -- none, or more
-- than one such batch -- changes nothing and lists what is there. A full copy
-- of the batch goes to audit_logs. Releases and Warehouse stock are not
-- touched; if the hall would go below zero (part of it already released) it
-- stops and changes nothing.
-- Safe to run again (the second run finds nothing to remove).
-- ============================================================================

DO $$
DECLARE
  v_product uuid;
  v_factory uuid;
  v_batches uuid[];
  v_found text;
  v_removed text;
  v_copy jsonb;
  v_made_before numeric;
  v_made_after numeric;
  v_hall numeric;
BEGIN
  IF EXISTS (SELECT 1 FROM audit_logs WHERE entity = 'production' AND entity_id = 'sachet-1200-entered-12nov') THEN
    RAISE NOTICE 'The 1,200 Sachet Water batch was already removed -- nothing to do';
    RETURN;
  END IF;
  IF (SELECT count(*) FROM products WHERE name ~* '^\s*sachet water\s*$' AND product_type = 'finished') <> 1 THEN
    RAISE NOTICE 'Not exactly one finished "Sachet Water" product here -- nothing to do';
    RETURN;
  END IF;
  v_product := (SELECT id FROM products WHERE name ~* '^\s*sachet water\s*$' AND product_type = 'finished');
  v_factory := (SELECT factory_id FROM products WHERE id = v_product);

  v_batches := ARRAY(
    SELECT id FROM production
     WHERE product_id = v_product
       AND status = 'pending_confirmation'
       AND production_date = '2026-11-11'
       AND quantity_produced = 1200
       AND (created_at AT TIME ZONE 'Africa/Lagos')::date = '2026-11-12');

  v_found := (SELECT string_agg(production_number || ': ' || quantity_produced::text || ' '
                                 || COALESCE(unit, '') || ', ' || COALESCE(shift, 'no shift')
                                 || ', entered ' || to_char(created_at AT TIME ZONE 'Africa/Lagos', 'DD Mon HH24:MI')
                                 || ' by ' || COALESCE(supervisor, '?'), '; ' ORDER BY created_at)
                FROM production
               WHERE product_id = v_product AND production_date = '2026-11-11'
                 AND status = 'pending_confirmation');

  IF cardinality(v_batches) = 0 THEN
    IF v_found IS NULL THEN
      RAISE NOTICE 'No Sachet Water batches on 11 Nov here -- nothing to do';
      RETURN;
    END IF;
    RAISE EXCEPTION 'No 1,200 Sachet Water batch dated 11 Nov and entered on 12 Nov was found -- nothing changed. 11 Nov batches: %', v_found;
  END IF;
  IF cardinality(v_batches) > 1 THEN
    RAISE EXCEPTION '% batches of 1,200 Sachet Water match -- say which one to remove; nothing changed. 11 Nov batches: %',
      cardinality(v_batches), v_found;
  END IF;

  v_made_before := (SELECT COALESCE(sum(quantity_produced - COALESCE(damaged_quantity, 0)), 0) FROM production
                     WHERE product_id = v_product AND production_date = '2026-11-11'
                       AND status IN ('pending_confirmation', 'confirmed', 'posted'));
  v_copy := (SELECT jsonb_agg(to_jsonb(b)) FROM production b WHERE b.id = ANY (v_batches));
  v_removed := (SELECT production_number || ' (' || COALESCE(shift, 'no shift') || ', by ' || COALESCE(supervisor, '?') || ')'
                  FROM production WHERE id = v_batches[1]);

  UPDATE production_requests SET production_id = NULL WHERE production_id = ANY (v_batches);
  DELETE FROM workflow_approval_history WHERE module = 'production' AND entity_id = ANY (v_batches);
  DELETE FROM production WHERE id = ANY (v_batches);

  v_hall := public._production_hall_available(v_factory, v_product);
  IF v_hall < 0 THEN
    RAISE EXCEPTION 'Removing it would leave % bags in the production hall -- some of it was already released. Nothing changed.', v_hall;
  END IF;
  v_made_after := (SELECT COALESCE(sum(quantity_produced - COALESCE(damaged_quantity, 0)), 0) FROM production
                    WHERE product_id = v_product AND production_date = '2026-11-11'
                      AND status IN ('pending_confirmation', 'confirmed', 'posted'));

  INSERT INTO audit_logs(user_id, factory_id, action, entity, entity_id, old_value, new_value)
  VALUES (auth.uid(), v_factory, 'delete', 'production', 'sachet-1200-entered-12nov', v_copy,
          jsonb_build_object('reason',
            '1,200 Sachet Water entered on 12 Nov went onto 11 Nov by mistake; removed at the user''s request so 11 Nov closes at 1,977',
            'produced_11nov_before', v_made_before, 'produced_11nov_after', v_made_after,
            'in_hall_now', v_hall));

  RAISE NOTICE 'Removed %. Sachet Water produced on 11 Nov: % -> % (report balance 3,177 -> 1,977). In the hall now: % bags.',
    v_removed, v_made_before, v_made_after, v_hall;
END $$;
