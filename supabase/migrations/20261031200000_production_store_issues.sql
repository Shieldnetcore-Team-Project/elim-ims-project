-- ============================================================================
-- Production -> "From Store": what the Store issued to Production
-- ----------------------------------------------------------------------------
-- User request (2026-10-31): a tab where the Production Manager sees the
-- materials the Store issued to Production. The Store records each issue in
-- raw_material_movements with issued_to_department = 'production' and the
-- person who received it (20261020160000). Production staff can't read the
-- Store's tables (raw-materials rights), so this read-only function returns
-- just those issues, newest first, for p_from..p_to (Lagos days): when, the
-- material and unit, quantity, who issued it, who received it, reference
-- and reason. For anyone who can view Production or the Store.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.production_store_issues(p_factory uuid, p_from date, p_to date)
RETURNS TABLE(id uuid, issued_at timestamptz, material text, unit text, quantity numeric,
              issued_by text, received_by text, reference text, reason text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
#variable_conflict use_column
BEGIN
  IF NOT (public.has_permission(auth.uid(), 'production'::module_key, 'view'::action_key)
       OR public.has_permission(auth.uid(), 'raw-materials'::module_key, 'view'::action_key)) THEN
    RAISE EXCEPTION 'Insufficient permissions';
  END IF;
  IF p_from IS NULL OR p_to IS NULL OR p_to < p_from THEN RAISE EXCEPTION 'Choose a valid date range'; END IF;
  IF p_to - p_from > 366 THEN RAISE EXCEPTION 'Choose a range of at most one year'; END IF;
  RETURN QUERY
  SELECT m.id, m.created_at, rm.name::text, rm.unit::text, m.quantity,
         COALESCE(NULLIF(ib.full_name, ''), ib.email)::text,
         COALESCE(NULLIF(rb.full_name, ''), rb.email)::text,
         m.reference, m.reason
    FROM raw_material_movements m
    JOIN raw_materials rm ON rm.id = m.material_id
    LEFT JOIN profiles ib ON ib.id = m.user_id
    LEFT JOIN profiles rb ON rb.id = m.issued_to_user
   WHERE m.factory_id = p_factory
     AND m.issued_to_department = 'production'
     AND (m.created_at AT TIME ZONE 'Africa/Lagos')::date BETWEEN p_from AND p_to
   ORDER BY m.created_at DESC;
END;
$$;
REVOKE ALL ON FUNCTION public.production_store_issues(uuid, date, date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.production_store_issues(uuid, date, date) TO authenticated;

NOTIFY pgrst, 'reload schema';
