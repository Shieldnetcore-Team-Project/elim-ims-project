-- Quality Control → Preforms: every preform, from the Store to the good
-- bottles, in one line each. For each preform (every preform material, even
-- one not issued yet) with its brand, grammage, supplier and pieces per bag:
--   in_store   -- still in the Store
--   issued     -- pieces the Store has issued for blowing (waiting + accepted)
--   waiting    -- issued but not yet accepted by QC
--   received   -- accepted by QC
--   blown      -- bottles blown, good and bad (one preform each)
--   damages    -- the bad ones (damaged preforms, damaged bottles, losses)
--   good       -- blown - damages, the good bottles that went into stock
--   qc_holds   -- preforms QC holds now, not yet blown
--   last_issue -- when the Store last issued it
-- Reversed issues and blowing entries don't count; drafts aren't blown yet.

CREATE OR REPLACE FUNCTION public.qc_preform_overview(p_factory uuid)
RETURNS TABLE(
  material_id uuid, material text, brand text, grammage text, supplier text,
  pieces_per_bag numeric, in_store numeric, issued numeric, waiting numeric, received numeric,
  blown numeric, damages numeric, good numeric, qc_holds numeric, last_issue date
) LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NOT public._pf_can('view') THEN RAISE EXCEPTION 'Insufficient permissions'; END IF;
  RETURN QUERY
  WITH iss AS (
    SELECT i.material_id,
           SUM(i.pieces) FILTER (WHERE i.status IN ('issued', 'accepted')) AS issued,
           SUM(i.pieces) FILTER (WHERE i.status = 'issued') AS waiting,
           SUM(i.pieces) FILTER (WHERE i.status = 'accepted') AS received,
           MAX(i.issue_date) FILTER (WHERE i.status IN ('issued', 'accepted')) AS last_issue
      FROM preform_issues i WHERE i.factory_id = p_factory GROUP BY i.material_id
  ), blw AS (
    SELECT r.material_id,
           SUM(r.good_bottles + r.damaged_preforms + r.damaged_bottles + r.other_losses) AS blown,
           SUM(r.damaged_preforms + r.damaged_bottles + r.other_losses) AS damages
      FROM preform_shift_records r
     WHERE r.factory_id = p_factory AND r.status NOT IN ('draft', 'reversed')
     GROUP BY r.material_id
  ), held AS (
    SELECT mv.material_id, SUM(mv.quantity) AS qc_holds
      FROM preform_movements mv WHERE mv.factory_id = p_factory GROUP BY mv.material_id
  )
  SELECT m.id, m.name, b.name, b.grammage, s.name, m.pieces_per_bag, m.current_stock,
         COALESCE(iss.issued, 0), COALESCE(iss.waiting, 0), COALESCE(iss.received, 0),
         COALESCE(blw.blown, 0), COALESCE(blw.damages, 0),
         COALESCE(blw.blown, 0) - COALESCE(blw.damages, 0),
         COALESCE(held.qc_holds, 0), iss.last_issue
    FROM raw_materials m
    LEFT JOIN brands b ON b.id = m.brand_id
    LEFT JOIN suppliers s ON s.id = COALESCE(m.supplier_id, b.supplier_id)
    LEFT JOIN iss ON iss.material_id = m.id
    LEFT JOIN blw ON blw.material_id = m.id
    LEFT JOIN held ON held.material_id = m.id
   WHERE m.factory_id = p_factory
     AND (m.is_preform OR m.pieces_per_bag IS NOT NULL OR m.name ILIKE '%preform%'
          OR iss.material_id IS NOT NULL OR blw.material_id IS NOT NULL)
   ORDER BY m.name;
END;
$$;
REVOKE ALL ON FUNCTION public.qc_preform_overview(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.qc_preform_overview(uuid) TO authenticated;
