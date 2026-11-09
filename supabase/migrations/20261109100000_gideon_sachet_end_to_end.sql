-- ============================================================================
-- Gideon: Sachet Water from Production through to posting, on his own
-- ----------------------------------------------------------------------------
-- User (2026-11-09): "enable Gideon to post sachet from production, release
-- and accept in warehouse to post to retail shop, marketers and distributors".
--
-- What stopped him: accept_production_release refuses whoever released the
-- goods, and he both releases and accepts sachet. Now the person who released
-- a release may accept it when the product is Sachet Water AND they are
-- assigned Sachet Water by their own user_product_rules row (Gideon today).
-- Everyone else, and every other product, still needs a second person --
-- Gideon's Dispenser Water included.
--
-- His rights are also set again, in case an earlier migration was not run on
-- the live system or was changed in the Admin Panel: Production (record,
-- release), accept / refuse releases, post to marketers and the Retail Shop
-- (distribution), post to distributors (sales, customers) and the pages for
-- them. His products stay Dispenser / Jug Water and Sachet Water.
--
-- Isolation (user, 2026-11-09): "Kemi should not be seeing products that are
-- not assigned to her ... kemi should be seeing only all bottles type and
-- gideon should be in charge of sachet and dispenser". Accepting or refusing
-- a Production release, and restocking, now refuse a product the officer is
-- not assigned (_user_may_handle_product), as postings and returns already
-- did. Kemi's "bottle water" rule is set again. Someone with no rule, and
-- Admin / Chairman, are not limited.
--
-- Needs 20261101140000 (user_product_rules). Matches
-- gideonsunday24@gmail.com and arogundadeoluwakemi613@gmail.com, exactly one
-- account each; otherwise that person is skipped with a notice. Safe to run
-- again.
-- ============================================================================

DO $$
BEGIN
  IF to_regclass('public.user_product_rules') IS NULL THEN
    RAISE EXCEPTION 'Run 20261101140000_warehouse_product_assignments.sql first (it creates user_product_rules), then this again';
  END IF;
END $$;

-- Sachet Water only, and only someone assigned to it by name: a person with
-- no product rules (not limited to any product) doesn't count.
CREATE OR REPLACE FUNCTION public._may_accept_own_release(p_user uuid, p_product uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (
    SELECT 1 FROM user_product_rules r JOIN products p ON p.id = p_product
     WHERE r.user_id = p_user
       AND p.name ~* '(sachet|satchet)'
       AND p.name ~* r.name_pattern);
$$;
REVOKE ALL ON FUNCTION public._may_accept_own_release(uuid, uuid) FROM PUBLIC, anon, authenticated;

-- Body as 20261014190000; only the self-acceptance check changes.
CREATE OR REPLACE FUNCTION public.accept_production_release(
  p_id uuid, p_received numeric, p_damaged numeric DEFAULT 0, p_rejected numeric DEFAULT 0,
  p_comment text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_row production_releases%ROWTYPE;
  v_damaged numeric := COALESCE(p_damaged, 0);
  v_rejected numeric := COALESCE(p_rejected, 0);
  v_accepted numeric;
  v_short numeric;
  v_before numeric;
  v_cost numeric;
BEGIN
  SELECT * INTO v_row FROM production_releases WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Release not found'; END IF;
  IF NOT public.has_permission(v_uid, 'production'::module_key, 'confirm'::action_key) THEN
    RAISE EXCEPTION 'Insufficient permissions';
  END IF;
  IF v_row.released_by = v_uid
     AND NOT (public.has_role(v_uid, 'super_admin') OR public.has_role(v_uid, 'chairman')
              OR public._may_accept_own_release(v_uid, v_row.product_id)) THEN
    RAISE EXCEPTION 'Warehouse acceptance must be done by someone other than who released the goods';
  END IF;
  IF NOT public._user_may_handle_product(v_uid, v_row.product_id) THEN
    RAISE EXCEPTION '% is not one of your products -- it is handled by another Warehouse officer',
      (SELECT name FROM products WHERE id = v_row.product_id);
  END IF;
  IF v_row.status <> 'pending' THEN RAISE EXCEPTION 'This release is already %', v_row.status; END IF;
  IF p_received IS NULL OR p_received < 0 THEN RAISE EXCEPTION 'Quantity received must be >= 0'; END IF;
  IF p_received > v_row.quantity THEN
    RAISE EXCEPTION 'Received (%) cannot be more than was released (%)', p_received, v_row.quantity;
  END IF;
  IF v_damaged < 0 OR v_rejected < 0 THEN RAISE EXCEPTION 'Damaged/rejected quantities cannot be negative'; END IF;
  IF v_damaged + v_rejected > p_received THEN RAISE EXCEPTION 'Damaged + rejected cannot exceed quantity received'; END IF;

  v_accepted := p_received - v_damaged - v_rejected;
  v_short := v_row.quantity - p_received;

  UPDATE production_releases SET
    status = 'accepted', received_quantity = p_received, accepted_quantity = v_accepted,
    damaged_quantity = v_damaged, rejected_quantity = v_rejected,
    accepted_by = v_uid, accepted_at = now(), reject_reason = p_comment
  WHERE id = p_id;

  SELECT current_stock, cost_price INTO v_before, v_cost FROM products WHERE id = v_row.product_id FOR UPDATE;
  IF v_accepted > 0 THEN
    UPDATE products SET current_stock = current_stock + v_accepted, updated_at = now() WHERE id = v_row.product_id;
    INSERT INTO inventory_movements (factory_id, product_id, movement_type, quantity, reference, reason, user_id, quantity_before, quantity_after)
    VALUES (v_row.factory_id, v_row.product_id, 'produced', v_accepted, v_row.release_number,
            'Production release accepted by Warehouse', v_uid, v_before, v_before + v_accepted);
  END IF;

  IF v_damaged > 0 THEN
    INSERT INTO damage_records (factory_id, reference_number, source_type, source_reference, product_id, quantity, unit, unit_cost, reason, reported_by, status)
    VALUES (v_row.factory_id, 'DMG-' || to_char(now(),'YYYYMMDD') || '-' || lpad(((floor(random()*99999))::int)::text, 5, '0'),
            'PRODUCTION', v_row.release_number, v_row.product_id, v_damaged, v_row.unit, v_cost,
            'Damaged on Warehouse acceptance', v_uid, 'posted');
  END IF;
  IF v_rejected > 0 THEN
    INSERT INTO damage_records (factory_id, reference_number, source_type, source_reference, product_id, quantity, unit, unit_cost, reason, reported_by, status)
    VALUES (v_row.factory_id, 'DMG-' || to_char(now(),'YYYYMMDD') || '-' || lpad(((floor(random()*99999))::int)::text, 5, '0'),
            'PRODUCTION', v_row.release_number, v_row.product_id, v_rejected, v_row.unit, v_cost,
            'Rejected on Warehouse acceptance', v_uid, 'posted');
  END IF;
  IF v_short > 0 THEN
    INSERT INTO damage_records (factory_id, reference_number, source_type, source_reference, product_id, quantity, unit, unit_cost, reason, reported_by, status)
    VALUES (v_row.factory_id, 'DMG-' || to_char(now(),'YYYYMMDD') || '-' || lpad(((floor(random()*99999))::int)::text, 5, '0'),
            'PRODUCTION', v_row.release_number, v_row.product_id, v_short, v_row.unit, v_cost,
            'Short on release: released but not received by Warehouse', v_uid, 'posted');
  END IF;

  INSERT INTO audit_logs (user_id, factory_id, action, entity, entity_id, old_value, new_value)
  VALUES (v_uid, v_row.factory_id, 'accept_production_release', 'production_releases', p_id::text,
          jsonb_build_object('current_stock', v_before),
          jsonb_build_object('current_stock', v_before + v_accepted, 'accepted_quantity', v_accepted,
                             'damaged', v_damaged, 'rejected', v_rejected, 'short', v_short,
                             'accepted_own_release', v_row.released_by = v_uid));

  RETURN jsonb_build_object('accepted_quantity', v_accepted, 'short', v_short);
END;
$$;
REVOKE ALL ON FUNCTION public.accept_production_release(uuid, numeric, numeric, numeric, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.accept_production_release(uuid, numeric, numeric, numeric, text) TO authenticated;

-- Body as 20261014190000, plus the product check.
CREATE OR REPLACE FUNCTION public.reject_production_release(p_id uuid, p_reason text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_uid uuid := auth.uid(); v_row production_releases%ROWTYPE;
BEGIN
  SELECT * INTO v_row FROM production_releases WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Release not found'; END IF;
  IF NOT public.has_permission(v_uid, 'production'::module_key, 'reject'::action_key) THEN
    RAISE EXCEPTION 'Insufficient permissions';
  END IF;
  IF NOT public._user_may_handle_product(v_uid, v_row.product_id) THEN
    RAISE EXCEPTION '% is not one of your products -- it is handled by another Warehouse officer',
      (SELECT name FROM products WHERE id = v_row.product_id);
  END IF;
  IF v_row.status <> 'pending' THEN RAISE EXCEPTION 'This release is already %', v_row.status; END IF;
  IF p_reason IS NULL OR btrim(p_reason) = '' THEN RAISE EXCEPTION 'A reason is required'; END IF;
  UPDATE production_releases
     SET status = 'rejected', reject_reason = p_reason, accepted_by = v_uid, accepted_at = now()
   WHERE id = p_id;
  INSERT INTO audit_logs (user_id, factory_id, action, entity, entity_id, new_value)
  VALUES (v_uid, v_row.factory_id, 'reject_production_release', 'production_releases', p_id::text,
          jsonb_build_object('reason', p_reason));
  RETURN jsonb_build_object('rejected', true);
END;
$$;

-- Body as 20261028170000, plus the product check.
CREATE OR REPLACE FUNCTION public.warehouse_restock(payload jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_factory uuid := (payload->>'factory_id')::uuid;
  v_qty numeric := NULLIF(payload->>'quantity', '')::numeric;
  v_notes text := NULLIF(btrim(payload->>'notes'), '');
  v_product products%ROWTYPE;
  v_category text;
  v_number text;
BEGIN
  IF NOT public.has_permission(v_uid, 'finished-goods'::module_key, 'create'::action_key) THEN
    RAISE EXCEPTION 'Insufficient permissions';
  END IF;
  IF v_qty IS NULL OR v_qty <= 0 THEN RAISE EXCEPTION 'Quantity must be more than 0'; END IF;
  SELECT * INTO v_product FROM products WHERE id = (payload->>'product_id')::uuid FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Product not found'; END IF;
  IF v_product.factory_id <> v_factory THEN RAISE EXCEPTION 'Product does not belong to this factory'; END IF;
  IF v_product.product_type <> 'finished' OR NOT v_product.active THEN
    RAISE EXCEPTION '% can''t be restocked here', v_product.name;
  END IF;
  IF NOT public._user_may_handle_product(v_uid, v_product.id) THEN
    RAISE EXCEPTION '% is not one of your products -- it is handled by another Warehouse officer', v_product.name;
  END IF;
  SELECT name INTO v_category FROM product_categories WHERE id = v_product.category_id;
  IF NOT (v_product.name ~* '(sachet|satchet)' OR lower(COALESCE(v_category, '')) = 'sachet water') THEN
    RAISE EXCEPTION 'Only Sachet Water is restocked in the Warehouse -- % comes in another way (Production Releases, marketer returns, or the Store)', v_product.name;
  END IF;

  v_number := 'RST-' || to_char(now(), 'YYYYMMDD') || '-' || lpad(((floor(random() * 99999))::int)::text, 5, '0');
  UPDATE products SET current_stock = current_stock + v_qty, updated_at = now() WHERE id = v_product.id;
  INSERT INTO inventory_movements(factory_id, product_id, movement_type, quantity, reference, reason, user_id, quantity_before, quantity_after)
  VALUES (v_factory, v_product.id, 'received', v_qty, v_number,
          COALESCE('Restocked: ' || v_notes, 'Restocked'), v_uid,
          v_product.current_stock, v_product.current_stock + v_qty);
  INSERT INTO audit_logs(user_id, factory_id, action, entity, entity_id, new_value)
  VALUES (v_uid, v_factory, 'warehouse_restock', 'products', v_product.id::text,
          jsonb_build_object('reference', v_number, 'product', v_product.name, 'quantity', v_qty,
                             'unit', v_product.unit, 'notes', v_notes));
  RETURN jsonb_build_object('reference', v_number, 'stock', v_product.current_stock + v_qty);
END;
$$;

-- ---- Kemi: every bottle type, and nothing else ----
DO $$
DECLARE v_user uuid;
BEGIN
  IF (SELECT count(*) FROM profiles WHERE lower(btrim(email)) = 'arogundadeoluwakemi613@gmail.com') <> 1 THEN
    RAISE NOTICE 'Kemi skipped: not exactly one account has arogundadeoluwakemi613@gmail.com';
    RETURN;
  END IF;
  v_user := (SELECT id FROM profiles WHERE lower(btrim(email)) = 'arogundadeoluwakemi613@gmail.com');
  DELETE FROM user_product_rules WHERE user_id = v_user AND name_pattern <> 'bottle water';
  INSERT INTO user_product_rules (user_id, name_pattern, label)
  VALUES (v_user, 'bottle water', 'Bottle Water (all sizes)')
  ON CONFLICT (user_id, name_pattern) DO NOTHING;
END $$;

-- ---- Gideon's rights, set again ----
DO $$
DECLARE
  v_count int;
  v_user uuid;
  v_name text;
  v_factory uuid;
BEGIN
  v_count := (SELECT count(*) FROM profiles WHERE lower(btrim(email)) = 'gideonsunday24@gmail.com');
  IF v_count <> 1 THEN
    RAISE NOTICE 'Gideon skipped: % accounts have gideonsunday24@gmail.com', v_count;
    RETURN;
  END IF;
  v_user := (SELECT id FROM profiles WHERE lower(btrim(email)) = 'gideonsunday24@gmail.com');
  v_name := (SELECT COALESCE(full_name, email) FROM profiles WHERE id = v_user);

  INSERT INTO permission_overrides (user_id, module, action, granted)
  SELECT v_user, m::module_key, a::action_key, true
    FROM (VALUES ('production', 'view'), ('production', 'create'), ('production', 'submit'),
                 ('production', 'confirm'), ('production', 'reject'),
                 ('distribution', 'view'), ('distribution', 'create'), ('distribution', 'submit'),
                 ('distribution', 'print'), ('distribution', 'export'),
                 ('sales', 'view'), ('sales', 'create'), ('sales', 'submit'), ('sales', 'print'), ('sales', 'export'),
                 ('customers', 'view'), ('customers', 'create'), ('customers', 'edit'),
                 ('finished-goods', 'view'), ('finished-goods', 'create')) AS t(m, a)
  ON CONFLICT (user_id, module, action) DO UPDATE SET granted = true, granted_at = now();

  INSERT INTO user_page_access (user_id, page_id, granted)
  SELECT v_user, p, true
    FROM unnest(ARRAY['Production › Production', 'Warehouse › Finished Products', 'Warehouse › Stock']) AS p
  ON CONFLICT (user_id, page_id) DO UPDATE SET granted = true, granted_at = now();

  INSERT INTO user_product_rules (user_id, name_pattern, label) VALUES
    (v_user, 'dispenser|jug water', 'Dispenser / Jug Water'),
    (v_user, 'sachet', 'Sachet Water')
  ON CONFLICT (user_id, name_pattern) DO NOTHING;

  v_factory := (SELECT factory_id FROM user_roles WHERE user_id = v_user AND factory_id IS NOT NULL LIMIT 1);
  INSERT INTO audit_logs (user_id, factory_id, action, entity, entity_id, new_value)
  VALUES (auth.uid(), v_factory, 'grant', 'permission_overrides', v_user::text,
          jsonb_build_object('reason', format('%s records, releases, accepts and posts Sachet Water (2026-11-09)', v_name)));
  RAISE NOTICE '% can now record, release, accept and post Sachet Water', v_name;
END $$;

NOTIFY pgrst, 'reload schema';
