-- ============================================================================
-- Warehouse restock: Sachet Water only
-- ----------------------------------------------------------------------------
-- Factory rule (user, 2026-10-28): the Warehouse restocks only Sachet Water.
-- Everything else reaches it another way:
--   Bottle Water, Dispenser/Jug Water   Production Releases (PM posts, the
--                                       Warehouse accepts)
--   unsold dispensers with water        marketer returns at close of business
--   empty jugs                          Store raw material, received by the
--                                       Store and posted to QC
-- warehouse_restock now refuses any product that isn't Sachet Water (by name,
-- or the Sachet Water category). Otherwise unchanged.
-- ============================================================================

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
