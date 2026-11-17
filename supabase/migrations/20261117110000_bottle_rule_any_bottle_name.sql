-- ============================================================================
-- Kemi (Warehouse) and Ruth (Production): see the bottles again
-- ----------------------------------------------------------------------------
-- User (2026-11-17): Kemi's Warehouse shows 0 products and Ruth's pages show
-- no data. Both are limited to products whose name contains "bottle water"
-- (20261101140000, 20261104190000). When a bottle product is named without
-- those words (e.g. "75CL", "1.5Ltr") the rule matches nothing and every list
-- is empty. The rule now matches any bottle: a name with "bottle", or a size
-- in cl / ml / ltr / litre / l. Dispenser, jug and sachet names carry no size,
-- so they stay with Gideon. The pattern works in Postgres and in the browser.
-- Safe to run again. The last SELECT shows what each of them now sees.
-- ============================================================================

DO $$
DECLARE
  v_email text;
  v_user uuid;
  v_name text;
  v_pattern constant text := 'bottle|[0-9] ?(cl|ml|ltr|litre|l)( |$)';
BEGIN
  FOREACH v_email IN ARRAY ARRAY['arogundadeoluwakemi613@gmail.com', 'ruthyebom@gmail.com'] LOOP
    SELECT id, COALESCE(full_name, email) INTO v_user, v_name FROM profiles
     WHERE lower(btrim(email)) = v_email;
    IF v_user IS NULL THEN
      RAISE NOTICE 'No account with % -- nothing changed', v_email;
      CONTINUE;
    END IF;
    DELETE FROM user_product_rules WHERE user_id = v_user;
    INSERT INTO user_product_rules(user_id, name_pattern, label)
    VALUES (v_user, v_pattern, 'Bottle Water (all sizes)');
    INSERT INTO audit_logs(user_id, factory_id, action, entity, entity_id, new_value)
    VALUES (auth.uid(), NULL, 'set_product_rules', 'user_product_rules', v_user::text,
            jsonb_build_object('who', v_name, 'patterns', jsonb_build_array(v_pattern),
                               'reason', 'Bottle rule matches any bottle name (2026-11-17)'));
    v_user := NULL;
  END LOOP;
END $$;

NOTIFY pgrst, 'reload schema';

-- What Kemi and Ruth now see: their roles, their rule, and the finished
-- products it lets through. An empty "products_seen" means something else is
-- wrong -- send this result back.
SELECT p.email,
       (SELECT string_agg(ur.role::text, ', ') FROM user_roles ur WHERE ur.user_id = p.id) AS roles,
       (SELECT string_agg(r.name_pattern, ' | ') FROM user_product_rules r WHERE r.user_id = p.id) AS rule,
       (SELECT string_agg(pr.name, ', ' ORDER BY pr.name) FROM products pr
         WHERE pr.active AND pr.product_type = 'finished'
           AND EXISTS (SELECT 1 FROM user_product_rules r
                        WHERE r.user_id = p.id AND pr.name ~* r.name_pattern)) AS products_seen,
       (SELECT string_agg(pr.name, ', ' ORDER BY pr.name) FROM products pr
         WHERE pr.active AND pr.product_type = 'finished') AS all_finished_products
  FROM profiles p
 WHERE lower(btrim(p.email)) IN ('arogundadeoluwakemi613@gmail.com', 'ruthyebom@gmail.com');
