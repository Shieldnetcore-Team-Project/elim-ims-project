-- ============================================================================
-- Production -> Products Report -> QC Reports, for the production manager (Retshak)
-- ----------------------------------------------------------------------------
-- User (2026-11-04): "assign this tab in qc [Reports] to retshak too, he
-- should have it in production page to be able to print all reports".
--
-- A "QC Reports" section on Production -> Products Report, given person by person: the
-- menu page "Production › QC Reports" shows only for someone ticked for it
-- (Admin Panel -> Users -> Pages), never by default. The reports behind it
-- accept that tick as well as their usual rights:
--   qc_preform_report, qc_bottle_report   (bodies as 20261023210000)
--   _jug_can_view -> jug_accountability_report, jug_locations
-- Retshak (Wetpring Retshak) is ticked here.
-- ============================================================================

CREATE OR REPLACE FUNCTION public._qc_reports_granted()
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (SELECT 1 FROM user_page_access
                  WHERE user_id = auth.uid() AND page_id = 'Production › QC Reports' AND granted);
$$;
REVOKE ALL ON FUNCTION public._qc_reports_granted() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public._qc_reports_granted() TO authenticated;

CREATE OR REPLACE FUNCTION public._jug_can_view()
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT public._can_view_containers()
      OR public.has_permission(auth.uid(), 'marketer-accounts'::module_key, 'view'::action_key)
      OR public._qc_reports_granted();
$$;
REVOKE ALL ON FUNCTION public._jug_can_view() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public._jug_can_view() TO authenticated;

CREATE OR REPLACE FUNCTION public.qc_preform_report(p_factory uuid, p_from date, p_to date)
RETURNS TABLE (
  material_id uuid, material text, brand text, grammage text, pieces_per_bag numeric,
  received numeric, received_bags numeric, opening numeric, total numeric, blown numeric,
  damages numeric, expected_bottles numeric, balance numeric
) LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
#variable_conflict use_column
BEGIN
  IF NOT (public._pf_can('view')
          OR public.has_permission(auth.uid(), 'goods-receiving'::module_key, 'view'::action_key)
          OR public._qc_reports_granted()) THEN
    RAISE EXCEPTION 'Insufficient permissions';
  END IF;
  IF p_from IS NULL OR p_to IS NULL OR p_from > p_to THEN RAISE EXCEPTION 'Pick a valid date range'; END IF;
  RETURN QUERY
  WITH mv AS (
    SELECT x.material_id,
           SUM(x.quantity) FILTER (WHERE x.effective_date < p_from) AS opening,
           SUM(x.quantity) FILTER (WHERE x.effective_date BETWEEN p_from AND p_to
                                     AND x.movement_type IN ('issue_in', 'issue_reversed')) AS received,
           -SUM(x.quantity) FILTER (WHERE x.effective_date BETWEEN p_from AND p_to
                                      AND x.movement_type IN ('good_bottles', 'damaged_preforms', 'damaged_bottles',
                                                              'other_losses', 'usage_reversed')) AS blown,
           -SUM(x.quantity) FILTER (WHERE x.effective_date BETWEEN p_from AND p_to
                                      AND x.movement_type IN ('damaged_preforms', 'damaged_bottles', 'other_losses')) AS damages
      FROM preform_movements x
     WHERE x.factory_id = p_factory AND x.effective_date <= p_to
     GROUP BY x.material_id
  )
  SELECT m.id, m.name, b.name, b.grammage, m.pieces_per_bag,
         COALESCE(mv.received, 0),
         CASE WHEN m.pieces_per_bag > 0 THEN round(COALESCE(mv.received, 0) / m.pieces_per_bag, 2) END,
         COALESCE(mv.opening, 0),
         COALESCE(mv.opening, 0) + COALESCE(mv.received, 0),
         COALESCE(mv.blown, 0),
         COALESCE(mv.damages, 0),
         COALESCE(mv.blown, 0) - COALESCE(mv.damages, 0),
         COALESCE(mv.opening, 0) + COALESCE(mv.received, 0) - COALESCE(mv.blown, 0)
    FROM mv
    JOIN raw_materials m ON m.id = mv.material_id
    LEFT JOIN brands b ON b.id = m.brand_id
   ORDER BY m.name, b.name NULLS LAST;
END;
$$;
REVOKE ALL ON FUNCTION public.qc_preform_report(uuid, date, date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.qc_preform_report(uuid, date, date) TO authenticated;

-- ---------- 2b. Bottles report ----------
-- In = good bottles stocked (accepted stockings); Released = sent to
-- production (transfers not cancelled or reversed). Dates are Nigeria time.
CREATE OR REPLACE FUNCTION public.qc_bottle_report(p_factory uuid, p_from date, p_to date)
RETURNS TABLE (
  product_id uuid, product text, opening numeric, quantity_in numeric, total numeric, released numeric, balance numeric
) LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
#variable_conflict use_column
BEGIN
  IF NOT (public._pf_can('view')
          OR public.has_permission(auth.uid(), 'goods-receiving'::module_key, 'view'::action_key)
          OR public._qc_reports_granted()) THEN
    RAISE EXCEPTION 'Insufficient permissions';
  END IF;
  IF p_from IS NULL OR p_to IS NULL OR p_from > p_to THEN RAISE EXCEPTION 'Pick a valid date range'; END IF;
  RETURN QUERY
  WITH moves AS (
    SELECT s.product_id, (COALESCE(s.received_at, s.sent_at) AT TIME ZONE 'Africa/Lagos')::date AS d,
           COALESCE(s.accepted_qty, 0) AS qty
      FROM preform_stockings s
     WHERE s.factory_id = p_factory AND s.status = 'accepted'
    UNION ALL
    SELECT t.product_id, (t.sent_at AT TIME ZONE 'Africa/Lagos')::date, -t.quantity_sent
      FROM bottle_transfers t
     WHERE t.factory_id = p_factory AND t.status NOT IN ('cancelled', 'reversed')
  ), agg AS (
    SELECT mo.product_id,
           COALESCE(SUM(mo.qty) FILTER (WHERE mo.d < p_from), 0) AS opening,
           COALESCE(SUM(mo.qty) FILTER (WHERE mo.d BETWEEN p_from AND p_to AND mo.qty > 0), 0) AS qty_in,
           COALESCE(-SUM(mo.qty) FILTER (WHERE mo.d BETWEEN p_from AND p_to AND mo.qty < 0), 0) AS released
      FROM moves mo
     WHERE mo.d <= p_to
     GROUP BY mo.product_id
  )
  SELECT p.id, p.name, a.opening, a.qty_in, a.opening + a.qty_in, a.released, a.opening + a.qty_in - a.released
    FROM agg a JOIN products p ON p.id = a.product_id
   ORDER BY p.name;
END;
$$;
REVOKE ALL ON FUNCTION public.qc_bottle_report(uuid, date, date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.qc_bottle_report(uuid, date, date) TO authenticated;

-- ---------- Confirm only what is still waiting ----------

-- Retshak: the QC Reports tab.
DO $$
DECLARE v_n int; v_user uuid; v_name text;
BEGIN
  v_n := (SELECT count(*) FROM profiles
           WHERE full_name ILIKE '%retshak%' OR full_name ILIKE '%ranshak%'
              OR email ILIKE '%retshak%' OR email ILIKE '%ranshak%');
  IF v_n <> 1 THEN
    RAISE NOTICE '% accounts match "retshak" -- tick Production › QC Reports for him in Admin Panel -> Users -> Pages', v_n;
    RETURN;
  END IF;
  SELECT id, COALESCE(full_name, email) INTO v_user, v_name FROM profiles
   WHERE full_name ILIKE '%retshak%' OR full_name ILIKE '%ranshak%'
      OR email ILIKE '%retshak%' OR email ILIKE '%ranshak%';
  INSERT INTO user_page_access (user_id, page_id, granted)
  VALUES (v_user, 'Production › QC Reports', true)
  ON CONFLICT (user_id, page_id) DO UPDATE SET granted = true, granted_at = now();
  INSERT INTO audit_logs(user_id, factory_id, action, entity, entity_id, new_value)
  VALUES (auth.uid(), NULL, 'grant', 'user_page_access', v_user::text,
          jsonb_build_object('who', v_name, 'page', 'Production › QC Reports',
                             'reason', 'Production manager prints the QC reports (2026-11-04)'));
  RAISE NOTICE '% sees QC Reports on Production -> Products Report', v_name;
END $$;

NOTIFY pgrst, 'reload schema';
