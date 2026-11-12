-- ============================================================================
-- A marketer's dispensers: how many went as Jug + Water and as Dispenser Water
-- ----------------------------------------------------------------------------
-- User (2026-11-12): "warehouse is posting Dispenser Water to the marketer ...
-- when customers now bought Jug + Water the accountant can not know how many
-- jugs were sold out of what was posted. Assuming 100 dispensers were posted
-- and the marketer sold 20 Jug + Water and returns 80 empty jugs, QC accepts
-- the 80 ... and the accountant will now know how many jugs were sold and get
-- the account balanced with the 20 at 4,200 and [the 80 at] 1,200."
--
-- The balance already works this way (Rule A, 2026-11-03): Dispenser Water is
-- posted at N1,200 and every jug not back -- as an empty QC took in, or in an
-- unsold dispenser -- is charged at the Empty Jug price (N3,000). For the
-- example: 100 x 1,200 + 20 x 3,000 = 180,000 = 20 x 4,200 + 80 x 1,200.
-- What Accounts couldn't see is that split. This function gives it, from the
-- same figures as rep_account_summary:
--
--   posted          Dispenser Water posted to them (no type)
--   unsold_back     of it, returned unsold to the Warehouse
--   on_van          dispensers on their van now (not sold yet)
--   sold            posted - unsold_back - on_van
--   empties_back    empty jugs returned (QC's count / Record movement)
--   jug_water_sold  sold - empties_back: the customer kept the jug
--   water_sold      sold - jug_water_sold: the empty came back
--   jw_posted / jw_back  Jug + Water posted as such (already at N4,200) and
--                   returned unsold -- outside the split
-- with the prices: water, jug, Jug + Water. Read-only; changes nothing.
-- Paste into the Supabase SQL Editor.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.rep_dispenser_breakdown(p_rep uuid, p_from date DEFAULT NULL, p_to date DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $fn$
DECLARE
  v_posted numeric;
  v_unsold numeric;
  v_jw_posted numeric;
  v_jw_back numeric;
  v_empties numeric;
  v_on_van numeric;
  v_sold numeric;
  v_jw_sold numeric;
  v_water_price numeric;
  v_jug_price numeric;
BEGIN
  IF NOT (public.has_permission(auth.uid(), 'distribution'::module_key, 'view'::action_key)
       OR public.has_permission(auth.uid(), 'finance'::module_key, 'view'::action_key)
       OR public.has_permission(auth.uid(), 'marketer-accounts'::module_key, 'view'::action_key)) THEN
    RAISE EXCEPTION 'Insufficient permissions';
  END IF;

  -- Dispensers, counted in jugs (one per dispenser today).
  v_posted := COALESCE((
    SELECT sum(sdi.quantity * pj.per_unit)
      FROM stock_dispatch_items sdi
      JOIN stock_dispatches sd ON sd.id = sdi.dispatch_id
      CROSS JOIN LATERAL public._product_jug(sdi.product_id) pj
     WHERE sd.sales_rep_id = p_rep AND sd.status = 'posted' AND sdi.jar_mode IS NULL
       AND (p_from IS NULL OR sd.dispatch_date >= p_from)
       AND (p_to   IS NULL OR sd.dispatch_date <= p_to)), 0);
  v_jw_posted := COALESCE((
    SELECT sum(sdi.quantity * pj.per_unit)
      FROM stock_dispatch_items sdi
      JOIN stock_dispatches sd ON sd.id = sdi.dispatch_id
      CROSS JOIN LATERAL public._product_jug(sdi.product_id) pj
     WHERE sd.sales_rep_id = p_rep AND sd.status = 'posted' AND sdi.jar_mode = 'permanent'
       AND (p_from IS NULL OR sd.dispatch_date >= p_from)
       AND (p_to   IS NULL OR sd.dispatch_date <= p_to)), 0);
  v_unsold := COALESCE((
    SELECT sum(COALESCE(rri.accepted_quantity, 0) * pj.per_unit)
      FROM rep_return_items rri
      JOIN rep_returns rr ON rr.id = rri.rep_return_id
      CROSS JOIN LATERAL public._product_jug(rri.product_id) pj
     WHERE rr.sales_rep_id = p_rep AND rr.status = 'completed' AND rri.jar_mode IS NULL
       AND (p_from IS NULL OR rr.return_date >= p_from)
       AND (p_to   IS NULL OR rr.return_date <= p_to)), 0);
  v_jw_back := COALESCE((
    SELECT sum(COALESCE(rri.accepted_quantity, 0) * pj.per_unit)
      FROM rep_return_items rri
      JOIN rep_returns rr ON rr.id = rri.rep_return_id
      CROSS JOIN LATERAL public._product_jug(rri.product_id) pj
     WHERE rr.sales_rep_id = p_rep AND rr.status = 'completed' AND rri.jar_mode = 'permanent'
       AND (p_from IS NULL OR rr.return_date >= p_from)
       AND (p_to   IS NULL OR rr.return_date <= p_to)), 0);
  -- Every empty jug they returned, however it was entered (as Rule A).
  v_empties := COALESCE((
    SELECT sum(m.quantity)
      FROM container_movements m
      JOIN container_types ct ON ct.id = m.container_type_id
     WHERE m.from_type = 'sales_rep' AND m.from_id = p_rep AND m.source = 'return'
       AND ct.name ~* 'jug|dispenser'
       AND (p_from IS NULL OR public._jug_day(m.created_at) >= p_from)
       AND (p_to   IS NULL OR public._jug_day(m.created_at) <= p_to)), 0);
  -- On the van now: the Jug + Water posted as such comes off first.
  v_on_van := COALESCE((
    SELECT sum(rs.quantity * pj.per_unit)
      FROM rep_stock rs
      CROSS JOIN LATERAL public._product_jug(rs.product_id) pj
     WHERE rs.sales_rep_id = p_rep), 0);
  v_on_van := LEAST(GREATEST(v_on_van - GREATEST(v_jw_posted - v_jw_back, 0), 0),
                    GREATEST(v_posted - v_unsold, 0));

  v_sold := GREATEST(v_posted - v_unsold - v_on_van, 0);
  v_jw_sold := GREATEST(v_sold - v_empties, 0);

  SELECT p.unit_price / NULLIF(pj.per_unit, 0), pj.jar_price
    INTO v_water_price, v_jug_price
    FROM stock_dispatch_items sdi
    JOIN stock_dispatches sd ON sd.id = sdi.dispatch_id
    JOIN products p ON p.id = sdi.product_id
    CROSS JOIN LATERAL public._product_jug(sdi.product_id) pj
   WHERE sd.sales_rep_id = p_rep
   ORDER BY sd.dispatch_date DESC
   LIMIT 1;

  RETURN jsonb_build_object(
    'posted', v_posted,
    'unsold_back', v_unsold,
    'on_van', v_on_van,
    'sold', v_sold,
    'empties_back', v_empties,
    'jug_water_sold', v_jw_sold,
    'water_sold', v_sold - v_jw_sold,
    'jw_posted', v_jw_posted,
    'jw_back', v_jw_back,
    'water_price', v_water_price,
    'jug_price', v_jug_price,
    'jug_water_price', COALESCE(v_water_price, 0) + COALESCE(v_jug_price, 0));
END;
$fn$;
REVOKE ALL ON FUNCTION public.rep_dispenser_breakdown(uuid, date, date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.rep_dispenser_breakdown(uuid, date, date) TO authenticated;

NOTIFY pgrst, 'reload schema';
