-- ============================================================================
-- A corrected distributor posting keeps Jug + Water / Dispenser Water
-- ----------------------------------------------------------------------------
-- User (2026-11-12), H MEDIX invoice INV20261112-27151: "is still showing
-- Dispenser Water for 4,200 which is supposed to be Jug + Water 4,200 ...
-- fix it in the entire system".
--
-- Cause: Correct on a distributor posting (correct_warehouse_posting) reposts
-- the lines it is sent, and the correction window never sent a line's jug
-- type (sale_items.jar_mode). Every corrected dispenser line lost it:
--   * Jug + Water became plain "Dispenser Water" at N4,200 on every invoice,
--     list and total;
--   * the jug ledger then counted those jugs as owed back by the customer
--     (a line with no type = jug to come back), for Jug + Water (jug bought)
--     and for Dispenser Water with the empty handed in (swap) alike.
--
-- 1. correct_warehouse_posting: a dispenser line sent without a type takes
--    the type of the posting it corrects (same product, same price first) --
--    so even an app page opened before today's update keeps it. The window
--    itself now loads, shows and sends the type.
-- 2. Repair, every corrected posting in the system: a dispenser line with no
--    type gets the type of the posting it replaced, following a chain of
--    corrections back to the first; failing that, a line priced at exactly
--    Jug + Water's price is Jug + Water. Then its jugs: the "owed back" entry
--    is cancelled by an equal entry the other way (nothing is deleted), and a
--    Jug + Water line records its jugs as sold. Amounts, stock and payments are
--    not touched. A line whose type can't be told stays as it is and is listed.
--
-- The last result lists every line repaired or left, to check.
-- Safe to run again (a repaired line has its type and is skipped).
-- Paste into the Supabase SQL Editor (run without RLS).
-- ============================================================================

-- ---- 1. Corrections keep the type ----
-- Body as 20261029170000; only v_items gains the old lines' types.
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

  -- A dispenser line sent without its jug type keeps the old posting's
  -- (same product; the same price first).
  v_items := (
    SELECT jsonb_agg(
             CASE WHEN NULLIF(t.it->>'jar_mode', '') IS NULL
                   AND EXISTS (SELECT 1 FROM public._product_jug((t.it->>'product_id')::uuid))
                  THEN t.it || COALESCE(
                         (SELECT jsonb_build_object('jar_mode', si.jar_mode)
                            FROM sale_items si
                           WHERE si.sale_id = p_id AND si.jar_mode IS NOT NULL
                             AND si.product_id = (t.it->>'product_id')::uuid
                           ORDER BY (si.unit_price = NULLIF(t.it->>'unit_price', '')::numeric) DESC NULLS LAST,
                                    si.quantity DESC
                           LIMIT 1),
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

-- ---- 2. Repair the corrected postings ----
CREATE TABLE IF NOT EXISTS public._jug_type_repair_20261112 (
  sale_item_id uuid PRIMARY KEY,
  invoice_number text,
  customer text,
  sale_date date,
  product text,
  quantity numeric,
  unit_price numeric,
  type_set text,
  how text,
  jugs_owed_cancelled numeric,
  jugs_sold numeric,
  done_at timestamptz DEFAULT now()
);
ALTER TABLE public._jug_type_repair_20261112 ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public._jug_type_repair_20261112 FROM anon, authenticated;

CREATE OR REPLACE FUNCTION public._restore_corrected_jug_types()
RETURNS int LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  r record;
  v_ref text;
  v_orig_id uuid;
  v_mode text;
  v_how text;
  v_hops int;
  v_jug_type uuid;
  v_jug_per numeric;
  v_jug_price numeric;
  v_with_price numeric;
  v_per numeric;
  v_need numeric;
  v_net numeric;
  v_row record;
  v_cancel numeric;
  v_sold numeric;
  v_done int := 0;
BEGIN
  FOR r IN
    SELECT si.id AS item_id, si.product_id, si.quantity, si.unit_price,
           s.id AS sale_id, s.factory_id, s.invoice_number, s.remarks, s.sale_date, s.status::text AS status,
           s.sales_rep_id, COALESCE(NULLIF(btrim(s.customer_name), ''), '-') AS customer, p.name AS product
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
    v_mode := NULL; v_how := NULL; v_hops := 0;
    v_ref := substring(r.remarks FROM '^Correction of (\S+?):');
    -- Back along the corrections to a posting that still has the type.
    WHILE v_ref IS NOT NULL AND v_mode IS NULL AND v_hops < 20 LOOP
      v_hops := v_hops + 1;
      v_orig_id := (SELECT id FROM sales WHERE invoice_number = v_ref AND factory_id = r.factory_id
                     ORDER BY created_at DESC LIMIT 1);
      EXIT WHEN v_orig_id IS NULL;
      v_mode := (SELECT si.jar_mode FROM sale_items si
                  WHERE si.sale_id = v_orig_id AND si.product_id = r.product_id
                    AND si.jar_mode IS NOT NULL AND si.unit_price = r.unit_price
                  ORDER BY si.quantity DESC LIMIT 1);
      IF v_mode IS NULL
         AND (SELECT count(*) FROM sale_items si
               WHERE si.sale_id = v_orig_id AND si.product_id = r.product_id AND si.jar_mode IS NOT NULL) = 1
         AND NOT EXISTS (SELECT 1 FROM sale_items si
                          WHERE si.sale_id = v_orig_id AND si.product_id = r.product_id AND si.jar_mode IS NULL) THEN
        v_mode := (SELECT si.jar_mode FROM sale_items si
                    WHERE si.sale_id = v_orig_id AND si.product_id = r.product_id AND si.jar_mode IS NOT NULL);
      END IF;
      IF v_mode IS NOT NULL THEN
        v_how := 'from ' || v_ref;
      ELSE
        v_ref := substring((SELECT remarks FROM sales WHERE id = v_orig_id) FROM '^Correction of (\S+?):');
      END IF;
    END LOOP;

    v_jug_type := (SELECT j.container_type_id FROM public._product_jug(r.product_id) j);
    v_jug_per := (SELECT j.per_unit FROM public._product_jug(r.product_id) j);
    v_jug_price := (SELECT j.jar_price FROM public._product_jug(r.product_id) j);
    v_with_price := (SELECT j.with_jar_price FROM public._product_jug(r.product_id) j);
    IF v_mode IS NULL AND v_with_price IS NOT NULL
       AND r.unit_price = v_with_price * v_jug_per THEN
      v_mode := 'permanent';
      v_how := 'priced as Jug + Water';
    END IF;

    IF v_mode IS NULL THEN
      INSERT INTO public._jug_type_repair_20261112(sale_item_id, invoice_number, customer, sale_date, product,
                                                   quantity, unit_price, type_set, how)
      VALUES (r.item_id, r.invoice_number, r.customer, r.sale_date, r.product, r.quantity, r.unit_price,
              NULL, 'left as it is: type could not be told');
      CONTINUE;
    END IF;

    UPDATE sale_items
       SET jar_mode = v_mode,
           jar_unit_price = CASE WHEN v_mode = 'permanent' THEN COALESCE(v_jug_price * v_jug_per, 0) ELSE 0 END
     WHERE id = r.item_id;

    v_cancel := 0; v_sold := 0;
    -- The jug ledger, only for a posted sale (that is when it was written).
    IF r.status = 'posted' AND v_mode IN ('swap', 'permanent') THEN
      FOR v_row IN
        SELECT pc.container_type_id, pc.quantity_per_unit
          FROM product_containers pc
          JOIN container_types ct ON ct.id = pc.container_type_id AND ct.active
         WHERE pc.product_id = r.product_id
           AND NOT (pc.jug_role IS NOT DISTINCT FROM 'refill')
      LOOP
        v_need := r.quantity * v_row.quantity_per_unit;
        -- What this sale still has out to the customer for this product as "owed".
        v_net := COALESCE((SELECT sum(CASE WHEN m.to_type IN ('customer', 'walk_in') THEN m.quantity
                                           WHEN m.from_type IN ('customer', 'walk_in') THEN -m.quantity ELSE 0 END)
                             FROM container_movements m
                            WHERE m.sale_id = r.sale_id AND m.product_id = r.product_id
                              AND m.container_type_id = v_row.container_type_id AND m.source = 'sale'), 0);
        IF v_net >= v_need THEN
          -- Cancel it with an equal "sale" entry the other way, so a later
          -- reversal of the sale still nets to nothing.
          INSERT INTO container_movements(factory_id, container_type_id, from_type, from_id, to_type, to_id, quantity,
                                          source, reference, sale_id, created_by, product_id, notes)
          SELECT m.factory_id, m.container_type_id, m.to_type, m.to_id, m.from_type, m.from_id, v_need,
                 'sale', m.reference, m.sale_id, auth.uid(), m.product_id,
                 'Jug type restored (' || CASE WHEN v_mode = 'permanent' THEN 'Jug + Water' ELSE 'empty handed in' END
                   || '): not owed back'
            FROM container_movements m
           WHERE m.sale_id = r.sale_id AND m.product_id = r.product_id
             AND m.container_type_id = v_row.container_type_id AND m.source = 'sale'
             AND m.to_type IN ('customer', 'walk_in')
           ORDER BY m.created_at LIMIT 1;
          v_cancel := v_cancel + v_need;
        END IF;
        IF v_mode = 'permanent' AND v_row.container_type_id = v_jug_type THEN
          INSERT INTO container_movements(factory_id, container_type_id, from_type, from_id, to_type, to_id, quantity,
                                          source, reference, sale_id, created_by, product_id, notes)
          VALUES (r.factory_id, v_row.container_type_id,
                  CASE WHEN r.sales_rep_id IS NOT NULL THEN 'sales_rep' ELSE 'warehouse' END, r.sales_rep_id,
                  'external', NULL, r.quantity * v_jug_per, 'jar_sold', r.invoice_number, r.sale_id,
                  auth.uid(), r.product_id, 'Jar sold with the water');
          v_sold := v_sold + r.quantity * v_jug_per;
        END IF;
      END LOOP;
    END IF;

    v_done := v_done + 1;
    INSERT INTO public._jug_type_repair_20261112(sale_item_id, invoice_number, customer, sale_date, product,
                                                 quantity, unit_price, type_set, how, jugs_owed_cancelled, jugs_sold)
    VALUES (r.item_id, r.invoice_number, r.customer, r.sale_date, r.product, r.quantity, r.unit_price,
            v_mode, v_how, v_cancel, v_sold);
    INSERT INTO audit_logs(user_id, factory_id, action, entity, entity_id, old_value, new_value)
    VALUES (auth.uid(), r.factory_id, 'restore_jug_type', 'sale_items', r.item_id::text,
            jsonb_build_object('invoice_number', r.invoice_number, 'jar_mode', NULL),
            jsonb_build_object('jar_mode', v_mode, 'how', v_how, 'jugs_owed_cancelled', v_cancel,
                               'jugs_sold', v_sold,
                               'reason', 'Corrected posting had lost its Jug + Water / Dispenser Water type (2026-11-12)'));
  END LOOP;
  RETURN v_done;
END;
$$;
REVOKE ALL ON FUNCTION public._restore_corrected_jug_types() FROM PUBLIC, anon, authenticated;
SELECT public._restore_corrected_jug_types() AS dispenser_lines_repaired;

NOTIFY pgrst, 'reload schema';

-- Every corrected dispenser line looked at: the type it now has, and its jugs.
SELECT sale_date, invoice_number, customer, product, quantity, unit_price,
       CASE type_set WHEN 'permanent' THEN 'Jug + Water' WHEN 'swap' THEN 'Dispenser Water (empty in)'
                     WHEN 'return_later' THEN 'Dispenser Water (empty owed)' ELSE '-- unchanged --' END AS now_shows,
       how, jugs_owed_cancelled, jugs_sold
  FROM public._jug_type_repair_20261112
 ORDER BY sale_date DESC, invoice_number;
