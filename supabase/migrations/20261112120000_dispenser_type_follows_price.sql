-- ============================================================================
-- The price decides the dispenser type: N4,200 Jug + Water, N1,200 Dispenser
-- Water, N3,000 Empty Jug
-- ----------------------------------------------------------------------------
-- User (2026-11-12), on 20261112110000's repair list: "for Emeka Orji -- 1200
-- is Dispenser Water not Jug + Water, please adjust it. Every Jug + Water is
-- 4,200, then Dispenser Water is 1,200, Empty Jug 3,000 ... from the posting
-- page, retail shop to accountant page, it should reflect to avoid confusion."
--
-- The repair took Emeka Orji's 7 @ N1,200 (and MSF Holland's 35 @ N1,200) as
-- Jug + Water because the posting they corrected had a Jug + Water line. Now
-- the price decides, using the prices on Costing (Dispenser Water + its Empty
-- Jug = Jug + Water):
--   price = Jug + Water's  -> Jug + Water        (jug bought, nothing owed)
--   price = Dispenser Water's, saved as Jug + Water -> Dispenser Water with the
--          empty handed in (the posting page's "Dispenser Water")
-- Empty Jug is its own product at its own price and is not affected.
--
-- 1. Every sale line from now on (Warehouse posting to a distributor, the
--    Retail Shop's POS, Accounts' marketer-customer sale, a correction) is
--    typed by its price when it is saved.
-- 2. A correction that doesn't send a line's type: price first, then the old
--    line's Dispenser Water type, never Jug + Water at N1,200.
-- 3. The repair of corrected postings (20261112110000) decides by price too.
-- 4. Existing sale lines whose type contradicts their price are put right,
--    with their jugs: Jug + Water -> Dispenser Water takes back the "jug sold"
--    entry; Dispenser Water / no type -> Jug + Water cancels any "owed back"
--    entry and records the jug as sold. Amounts, stock and payments are not
--    touched; nothing is deleted; each change is audit-logged.
-- Marketer postings are only listed (their jug credit is worked out from the
-- type), not changed.
--
-- Results: the lines put right, then any marketer posting lines whose type
-- and price disagree. Safe to run again.
-- Paste into the Supabase SQL Editor (run without RLS).
-- ============================================================================

-- ---- The type a price stands for ----
-- 'permanent' at Jug + Water's price, 'swap' at the water-only price, NULL
-- for any other price or a product without a jug.
CREATE OR REPLACE FUNCTION public._jug_type_for_price(p_product uuid, p_price numeric)
RETURNS text LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT CASE
    WHEN j.with_jar_price IS NULL OR p_price IS NULL THEN NULL
    WHEN p_price = j.with_jar_price * j.per_unit THEN 'permanent'
    WHEN j.jar_price IS NOT NULL AND p_price = (j.with_jar_price - j.jar_price) * j.per_unit THEN 'swap'
  END
  FROM public._product_jug(p_product) j;
$$;
REVOKE ALL ON FUNCTION public._jug_type_for_price(uuid, numeric) FROM PUBLIC, anon, authenticated;

-- ---- 1. New sale lines are typed by their price ----
-- On insert only: the jug ledger is written when the sale posts, from these
-- lines, so it follows. Later repricing never changes a line's type.
CREATE OR REPLACE FUNCTION public._sale_item_type_from_price()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_by_price text := public._jug_type_for_price(NEW.product_id, NEW.unit_price);
BEGIN
  IF v_by_price = 'permanent' AND NEW.jar_mode IS DISTINCT FROM 'permanent' THEN
    NEW.jar_mode := 'permanent';
    NEW.jar_unit_price := COALESCE((SELECT j.jar_price * j.per_unit FROM public._product_jug(NEW.product_id) j), 0);
  ELSIF v_by_price = 'swap' AND NEW.jar_mode = 'permanent' THEN
    NEW.jar_mode := 'swap';
    NEW.jar_unit_price := 0;
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_sale_item_type_from_price ON public.sale_items;
CREATE TRIGGER trg_sale_item_type_from_price BEFORE INSERT ON public.sale_items
  FOR EACH ROW EXECUTE FUNCTION public._sale_item_type_from_price();

-- ---- 2. Corrections: price first ----
-- Body as 20261112110000; only the type a line without one gets changes.
CREATE OR REPLACE FUNCTION public.correct_warehouse_posting(p_id uuid, payload jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_old sales%ROWTYPE;
  v_reason text := NULLIF(btrim(COALESCE(payload->>'reason', '')), '');
  v_items jsonb := payload->'items';
  v_new jsonb;
BEGIN
  IF NOT public.has_permission(v_uid, 'sales'::module_key, 'write'::action_key) THEN
    RAISE EXCEPTION 'Insufficient permissions';
  END IF;
  SELECT * INTO v_old FROM sales WHERE id = p_id AND deleted_at IS NULL FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Posting not found'; END IF;
  IF NOT public._works_in_factory(v_uid, v_old.factory_id) THEN RAISE EXCEPTION 'Insufficient permissions'; END IF;
  IF NOT public.is_warehouse_posting(v_old) THEN
    RAISE EXCEPTION '% isn''t a Warehouse posting to a distributor', v_old.invoice_number;
  END IF;
  IF v_old.status <> 'posted' THEN
    RAISE EXCEPTION '% is %, not posted -- only a posted one is corrected here', v_old.invoice_number,
      replace(v_old.status::text, '_', ' ');
  END IF;
  v_reason := COALESCE(v_reason, 'figures corrected');
  IF v_items IS NULL OR jsonb_array_length(v_items) = 0 THEN RAISE EXCEPTION 'Add at least one product line'; END IF;

  -- A dispenser line sent without its type: Jug + Water at Jug + Water's
  -- price; otherwise the old posting's Dispenser Water type for that product
  -- (same price first); otherwise Dispenser Water at the water price.
  v_items := (
    SELECT jsonb_agg(
             CASE WHEN NULLIF(t.it->>'jar_mode', '') IS NULL
                   AND EXISTS (SELECT 1 FROM public._product_jug((t.it->>'product_id')::uuid))
                  THEN t.it || COALESCE(
                         CASE WHEN public._jug_type_for_price((t.it->>'product_id')::uuid,
                                                              NULLIF(t.it->>'unit_price', '')::numeric) = 'permanent'
                              THEN jsonb_build_object('jar_mode', 'permanent') END,
                         (SELECT jsonb_build_object('jar_mode', si.jar_mode)
                            FROM sale_items si
                           WHERE si.sale_id = p_id AND si.jar_mode IN ('swap', 'return_later')
                             AND si.product_id = (t.it->>'product_id')::uuid
                           ORDER BY (si.unit_price = NULLIF(t.it->>'unit_price', '')::numeric) DESC NULLS LAST,
                                    si.quantity DESC
                           LIMIT 1),
                         CASE WHEN public._jug_type_for_price((t.it->>'product_id')::uuid,
                                                              NULLIF(t.it->>'unit_price', '')::numeric) = 'swap'
                              THEN jsonb_build_object('jar_mode', 'swap') END,
                         '{}'::jsonb)
                  ELSE t.it END
             ORDER BY t.ord)
      FROM jsonb_array_elements(v_items) WITH ORDINALITY AS t(it, ord));

  PERFORM public._reverse_posted_sale(p_id, 'Corrected: ' || v_reason);

  v_new := public.create_sale(jsonb_build_object(
    'factory_id', v_old.factory_id,
    'sale_date', COALESCE(NULLIF(payload->>'sale_date', ''), v_old.sale_date::text),
    'customer_id', v_old.customer_id,
    'customer_name', v_old.customer_name,
    'customer_phone', v_old.customer_phone,
    'customer_address', v_old.customer_address,
    'discount', COALESCE(NULLIF(payload->>'discount', '')::numeric, v_old.discount),
    'vat', v_old.vat,
    'amount_paid', 0,
    'sales_person', v_old.sales_person,
    'remarks', 'Correction of ' || v_old.invoice_number || ': ' || v_reason,
    'items', v_items));

  IF v_new->>'status' = 'pending_approval' THEN
    PERFORM public._post_sale((v_new->>'sale_id')::uuid, 'Corrected Warehouse posting - posted at once');
    v_new := v_new || jsonb_build_object('status', 'posted');
  END IF;

  INSERT INTO audit_logs(user_id, factory_id, action, entity, entity_id, old_value, new_value)
  VALUES (v_uid, v_old.factory_id, 'correct_warehouse_posting', 'sales', p_id::text,
          jsonb_build_object('invoice_number', v_old.invoice_number, 'grand_total', v_old.grand_total,
                             'items', (SELECT jsonb_agg(jsonb_build_object('product_id', product_id, 'quantity', quantity,
                                                                          'unit_price', unit_price, 'jar_mode', jar_mode))
                                         FROM sale_items WHERE sale_id = p_id)),
          jsonb_build_object('reason', v_reason, 'new', v_new));
  RETURN v_new || jsonb_build_object('replaced', v_old.invoice_number);
END;
$$;
REVOKE ALL ON FUNCTION public.correct_warehouse_posting(uuid, jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.correct_warehouse_posting(uuid, jsonb) TO authenticated;

-- ---- 4. Put right a sale line's type, with its jugs ----
-- Moves one line to p_mode and makes the jug ledger match; returns a short
-- note of what changed in the ledger. Used below and by 3.
CREATE OR REPLACE FUNCTION public._set_sale_line_jug_type(p_item uuid, p_mode text, p_reason text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_item sale_items%ROWTYPE;
  v_sale sales%ROWTYPE;
  v_jug_type uuid;
  v_jug_per numeric;
  v_jug_price numeric;
  v_need numeric;
  v_net numeric;
  v_cancel numeric := 0;
  v_sold numeric := 0;
  v_unsold numeric := 0;
  v_row record;
BEGIN
  v_item := (SELECT si FROM sale_items si WHERE si.id = p_item);
  IF v_item.id IS NULL THEN RETURN NULL; END IF;
  v_sale := (SELECT s FROM sales s WHERE s.id = v_item.sale_id);
  v_jug_type := (SELECT j.container_type_id FROM public._product_jug(v_item.product_id) j);
  v_jug_per := (SELECT j.per_unit FROM public._product_jug(v_item.product_id) j);
  v_jug_price := (SELECT j.jar_price FROM public._product_jug(v_item.product_id) j);
  IF v_jug_type IS NULL OR p_mode IS NOT DISTINCT FROM v_item.jar_mode THEN RETURN NULL; END IF;

  UPDATE sale_items
     SET jar_mode = p_mode,
         jar_unit_price = CASE WHEN p_mode = 'permanent' THEN COALESCE(v_jug_price * v_jug_per, 0) ELSE 0 END
   WHERE id = p_item;

  -- The ledger was written when the sale posted.
  IF v_sale.status::text = 'posted' AND v_sale.deleted_at IS NULL THEN
    v_need := v_item.quantity * v_jug_per;
    -- Leaving Jug + Water: the jug was not sold after all.
    IF v_item.jar_mode = 'permanent' THEN
      v_net := COALESCE((SELECT sum(CASE WHEN m.to_type = 'external' THEN m.quantity
                                         WHEN m.from_type = 'external' THEN -m.quantity ELSE 0 END)
                           FROM container_movements m
                          WHERE m.sale_id = v_sale.id AND m.product_id = v_item.product_id
                            AND m.container_type_id = v_jug_type AND m.source = 'jar_sold'), 0);
      IF v_net >= v_need THEN
        INSERT INTO container_movements(factory_id, container_type_id, from_type, from_id, to_type, to_id, quantity,
                                        source, reference, sale_id, created_by, product_id, notes)
        SELECT m.factory_id, m.container_type_id, m.to_type, m.to_id, m.from_type, m.from_id, v_need,
               'jar_sold', m.reference, m.sale_id, auth.uid(), m.product_id, 'Not Jug + Water: jug not sold'
          FROM container_movements m
         WHERE m.sale_id = v_sale.id AND m.product_id = v_item.product_id
           AND m.container_type_id = v_jug_type AND m.source = 'jar_sold' AND m.to_type = 'external'
         ORDER BY m.created_at LIMIT 1;
        v_unsold := v_need;
      END IF;
    END IF;
    -- Leaving "no type" / "empty owed": the jug is not owed back.
    IF (v_item.jar_mode IS NULL OR v_item.jar_mode = 'return_later') AND p_mode IN ('swap', 'permanent') THEN
      v_net := COALESCE((SELECT sum(CASE WHEN m.to_type IN ('customer', 'walk_in') THEN m.quantity
                                         WHEN m.from_type IN ('customer', 'walk_in') THEN -m.quantity ELSE 0 END)
                           FROM container_movements m
                          WHERE m.sale_id = v_sale.id AND m.product_id = v_item.product_id
                            AND m.container_type_id = v_jug_type AND m.source = 'sale'), 0);
      IF v_net >= v_need THEN
        INSERT INTO container_movements(factory_id, container_type_id, from_type, from_id, to_type, to_id, quantity,
                                        source, reference, sale_id, created_by, product_id, notes)
        SELECT m.factory_id, m.container_type_id, m.to_type, m.to_id, m.from_type, m.from_id, v_need,
               'sale', m.reference, m.sale_id, auth.uid(), m.product_id, 'Jug type put right: not owed back'
          FROM container_movements m
         WHERE m.sale_id = v_sale.id AND m.product_id = v_item.product_id
           AND m.container_type_id = v_jug_type AND m.source = 'sale' AND m.to_type IN ('customer', 'walk_in')
         ORDER BY m.created_at LIMIT 1;
        v_cancel := v_need;
      END IF;
    END IF;
    -- Becoming Jug + Water: the jug is sold with the water.
    IF p_mode = 'permanent' THEN
      INSERT INTO container_movements(factory_id, container_type_id, from_type, from_id, to_type, to_id, quantity,
                                      source, reference, sale_id, created_by, product_id, notes)
      VALUES (v_sale.factory_id, v_jug_type,
              CASE WHEN v_sale.sales_rep_id IS NOT NULL THEN 'sales_rep' ELSE 'warehouse' END, v_sale.sales_rep_id,
              'external', NULL, v_need, 'jar_sold', v_sale.invoice_number, v_sale.id,
              auth.uid(), v_item.product_id, 'Jar sold with the water');
      v_sold := v_need;
    END IF;
  END IF;

  INSERT INTO audit_logs(user_id, factory_id, action, entity, entity_id, old_value, new_value)
  VALUES (auth.uid(), v_sale.factory_id, 'set_jug_type', 'sale_items', p_item::text,
          jsonb_build_object('invoice_number', v_sale.invoice_number, 'jar_mode', v_item.jar_mode),
          jsonb_build_object('jar_mode', p_mode, 'reason', p_reason, 'jugs_owed_cancelled', v_cancel,
                             'jugs_sold', v_sold, 'jug_sale_taken_back', v_unsold));
  RETURN jsonb_build_object('owed_cancelled', v_cancel, 'sold', v_sold, 'sale_taken_back', v_unsold);
END;
$$;
REVOKE ALL ON FUNCTION public._set_sale_line_jug_type(uuid, text, text) FROM PUBLIC, anon, authenticated;

-- ---- 3. The corrected-postings repair decides by price ----
-- As 20261112110000, but a line's price is looked at first; a type copied
-- from the old posting must agree with the price. The ledger work is
-- _set_sale_line_jug_type.
CREATE OR REPLACE FUNCTION public._restore_corrected_jug_types()
RETURNS int LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  r record;
  v_ref text;
  v_orig_id uuid;
  v_mode text;
  v_by_price text;
  v_how text;
  v_hops int;
  v_res jsonb;
  v_done int := 0;
BEGIN
  FOR r IN
    SELECT si.id AS item_id, si.product_id, si.quantity, si.unit_price,
           s.factory_id, s.invoice_number, s.remarks, s.sale_date,
           COALESCE(NULLIF(btrim(s.customer_name), ''), '-') AS customer, p.name AS product
      FROM sales s
      JOIN sale_items si ON si.sale_id = s.id
      JOIN products p ON p.id = si.product_id
     WHERE s.deleted_at IS NULL
       AND s.remarks LIKE 'Correction of %'
       AND si.jar_mode IS NULL
       AND EXISTS (SELECT 1 FROM public._product_jug(si.product_id))
       AND NOT EXISTS (SELECT 1 FROM public._jug_type_repair_20261112 x WHERE x.sale_item_id = si.id)
     ORDER BY s.created_at
  LOOP
    v_by_price := public._jug_type_for_price(r.product_id, r.unit_price);
    v_mode := NULL; v_how := NULL; v_hops := 0;
    IF v_by_price = 'permanent' THEN
      v_mode := 'permanent'; v_how := 'priced as Jug + Water';
    ELSE
      -- A Dispenser Water type from the posting it replaced.
      v_ref := substring(r.remarks FROM '^Correction of (\S+?):');
      WHILE v_ref IS NOT NULL AND v_mode IS NULL AND v_hops < 20 LOOP
        v_hops := v_hops + 1;
        v_orig_id := (SELECT id FROM sales WHERE invoice_number = v_ref AND factory_id = r.factory_id
                       ORDER BY created_at DESC LIMIT 1);
        EXIT WHEN v_orig_id IS NULL;
        v_mode := (SELECT si.jar_mode FROM sale_items si
                    WHERE si.sale_id = v_orig_id AND si.product_id = r.product_id
                      AND si.jar_mode IN ('swap', 'return_later')
                    ORDER BY (si.unit_price = r.unit_price) DESC, si.quantity DESC LIMIT 1);
        IF v_mode IS NOT NULL THEN
          v_how := 'from ' || v_ref;
        ELSE
          v_ref := substring((SELECT remarks FROM sales WHERE id = v_orig_id) FROM '^Correction of (\S+?):');
        END IF;
      END LOOP;
      IF v_mode IS NULL AND v_by_price = 'swap' THEN
        v_mode := 'swap'; v_how := 'priced as Dispenser Water';
      END IF;
    END IF;

    IF v_mode IS NULL THEN
      INSERT INTO public._jug_type_repair_20261112(sale_item_id, invoice_number, customer, sale_date, product,
                                                   quantity, unit_price, type_set, how)
      VALUES (r.item_id, r.invoice_number, r.customer, r.sale_date, r.product, r.quantity, r.unit_price,
              NULL, 'left as it is: type could not be told');
      CONTINUE;
    END IF;

    v_res := public._set_sale_line_jug_type(r.item_id, v_mode,
               'Corrected posting had lost its Jug + Water / Dispenser Water type (2026-11-12)');
    v_done := v_done + 1;
    INSERT INTO public._jug_type_repair_20261112(sale_item_id, invoice_number, customer, sale_date, product,
                                                 quantity, unit_price, type_set, how, jugs_owed_cancelled, jugs_sold)
    VALUES (r.item_id, r.invoice_number, r.customer, r.sale_date, r.product, r.quantity, r.unit_price,
            v_mode, v_how, COALESCE((v_res->>'owed_cancelled')::numeric, 0), COALESCE((v_res->>'sold')::numeric, 0));
  END LOOP;
  RETURN v_done;
END;
$$;
REVOKE ALL ON FUNCTION public._restore_corrected_jug_types() FROM PUBLIC, anon, authenticated;

-- ---- 4. Every sale line whose type contradicts its price ----
CREATE TABLE IF NOT EXISTS public._jug_price_type_fix_20261112 (
  sale_item_id uuid PRIMARY KEY,
  invoice_number text,
  customer text,
  sale_date date,
  quantity numeric,
  unit_price numeric,
  was text,
  now_is text,
  jugs_owed_cancelled numeric,
  jugs_sold numeric,
  jug_sale_taken_back numeric,
  done_at timestamptz DEFAULT now()
);
ALTER TABLE public._jug_price_type_fix_20261112 ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public._jug_price_type_fix_20261112 FROM anon, authenticated;

CREATE OR REPLACE FUNCTION public._fix_sale_types_by_price()
RETURNS int LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  r record;
  v_res jsonb;
  v_done int := 0;
BEGIN
  FOR r IN
    SELECT si.id, si.jar_mode, si.quantity, si.unit_price, s.invoice_number, s.sale_date,
           COALESCE(NULLIF(btrim(s.customer_name), ''), '-') AS customer,
           public._jug_type_for_price(si.product_id, si.unit_price) AS by_price
      FROM sale_items si
      JOIN sales s ON s.id = si.sale_id
     WHERE s.deleted_at IS NULL
       AND s.status::text NOT IN ('rejected', 'cancelled')
       AND (   (public._jug_type_for_price(si.product_id, si.unit_price) = 'permanent'
                AND si.jar_mode IS DISTINCT FROM 'permanent')
            OR (public._jug_type_for_price(si.product_id, si.unit_price) = 'swap'
                AND si.jar_mode = 'permanent'))
     ORDER BY s.created_at
  LOOP
    v_res := public._set_sale_line_jug_type(r.id, r.by_price,
               'Type follows the price: Jug + Water N4,200, Dispenser Water N1,200 (user, 2026-11-12)');
    INSERT INTO public._jug_price_type_fix_20261112(sale_item_id, invoice_number, customer, sale_date, quantity,
                                                    unit_price, was, now_is, jugs_owed_cancelled, jugs_sold,
                                                    jug_sale_taken_back)
    VALUES (r.id, r.invoice_number, r.customer, r.sale_date, r.quantity, r.unit_price,
            COALESCE(r.jar_mode, 'no type'), r.by_price,
            COALESCE((v_res->>'owed_cancelled')::numeric, 0), COALESCE((v_res->>'sold')::numeric, 0),
            COALESCE((v_res->>'sale_taken_back')::numeric, 0))
    ON CONFLICT (sale_item_id) DO NOTHING;
    v_done := v_done + 1;
  END LOOP;
  RETURN v_done;
END;
$$;
REVOKE ALL ON FUNCTION public._fix_sale_types_by_price() FROM PUBLIC, anon, authenticated;

SELECT public._fix_sale_types_by_price() AS sale_lines_put_right;

NOTIFY pgrst, 'reload schema';

-- Marketer posting lines whose type and price disagree (listed, not changed).
SELECT d.dispatch_date, d.dispatch_number, r.full_name AS marketer_or_shop,
       public._sale_line_name(p.name, i.jar_mode) AS shows_as, i.quantity, i.unit_price
  FROM stock_dispatch_items i
  JOIN stock_dispatches d ON d.id = i.dispatch_id
  JOIN products p ON p.id = i.product_id
  LEFT JOIN sales_reps r ON r.id = d.sales_rep_id
 WHERE d.status::text <> 'reversed'
   AND (   (public._jug_type_for_price(i.product_id, i.unit_price) = 'permanent' AND i.jar_mode IS NULL)
        OR (public._jug_type_for_price(i.product_id, i.unit_price) = 'swap' AND i.jar_mode = 'permanent'))
 ORDER BY d.dispatch_date DESC;

-- The sale lines put right (Emeka Orji's and MSF Holland's 1,200 lines among them).
SELECT sale_date, invoice_number, customer, quantity, unit_price,
       CASE was WHEN 'permanent' THEN 'Jug + Water' WHEN 'swap' THEN 'Dispenser Water (empty in)'
                WHEN 'return_later' THEN 'Dispenser Water (empty owed)' ELSE was END AS was,
       CASE now_is WHEN 'permanent' THEN 'Jug + Water' ELSE 'Dispenser Water' END AS now_shows,
       jugs_owed_cancelled, jugs_sold, jug_sale_taken_back
  FROM public._jug_price_type_fix_20261112
 ORDER BY sale_date DESC, invoice_number;
