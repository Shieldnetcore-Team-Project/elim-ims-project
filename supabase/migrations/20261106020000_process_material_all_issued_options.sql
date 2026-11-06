-- Keep Store-issued raw materials available in Add New Process Material,
-- including materials later deactivated in the Store.
CREATE OR REPLACE FUNCTION public.production_material_options(p_factory uuid)
RETURNS TABLE(material_id uuid, material_name text, unit text, last_balance numeric, detail text,
              kind text, received_since numeric)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NOT public.has_permission(auth.uid(), 'production'::module_key, 'view'::action_key) THEN
    RAISE EXCEPTION 'Insufficient permissions';
  END IF;
  RETURN QUERY
  SELECT x.id, x.name, x.unit, x.last_balance, x.detail, x.kind, x.received_since
    FROM (
      SELECT rm.id, rm.name, rm.unit,
             COALESCE(last.balance, 0) AS last_balance,
             NULLIF(concat_ws(' · ', b.name,
                              CASE WHEN rm.grams_per_piece IS NOT NULL THEN trim(to_char(rm.grams_per_piece, 'FM990.0')) || 'g' END,
                              s.name), '') AS detail,
             'material'::text AS kind,
             COALESCE((SELECT SUM(m.quantity) FROM raw_material_movements m
                        WHERE m.factory_id = p_factory
                          AND m.material_id = rm.id
                          AND m.issued_to_department = 'production'
                          AND (last.created_at IS NULL OR m.created_at > last.created_at)), 0) AS received_since,
             1 AS grp, b.name AS b_name, s.name AS s_name
        FROM raw_materials rm
        LEFT JOIN brands b ON b.id = rm.brand_id
        LEFT JOIN suppliers s ON s.id = rm.supplier_id
        LEFT JOIN LATERAL (SELECT r.balance, r.created_at FROM production_material_reports r
                            WHERE r.factory_id = p_factory AND r.material_id = rm.id
                            ORDER BY r.report_date DESC, r.created_at DESC LIMIT 1) last ON true
       WHERE rm.factory_id = p_factory
         AND (rm.active
              OR EXISTS (SELECT 1 FROM raw_material_movements m
                          WHERE m.factory_id = p_factory
                            AND m.material_id = rm.id
                            AND m.issued_to_department = 'production')
              OR EXISTS (SELECT 1 FROM production_material_reports r
                          WHERE r.factory_id = p_factory AND r.material_id = rm.id))
      UNION ALL
      SELECT p.id, p.name, p.unit,
             COALESCE(last.balance, 0),
             'Blown bottle from QC',
             'bottle'::text,
             COALESCE((SELECT SUM(t.quantity_received) FROM bottle_transfers t
                        WHERE t.product_id = p.id AND t.status IN ('received', 'discrepancy')
                          AND NOT COALESCE(t.test_cleared, false)
                          AND (last.created_at IS NULL OR t.received_at > last.created_at)), 0),
             0, NULL, NULL
        FROM products p
        LEFT JOIN LATERAL (SELECT r.balance, r.created_at FROM production_material_reports r
                            WHERE r.factory_id = p_factory AND r.product_id = p.id
                            ORDER BY r.report_date DESC, r.created_at DESC LIMIT 1) last ON true
       WHERE p.factory_id = p_factory AND p.active AND public._pm_bottle_product(p.id, p_factory)
    ) x
   ORDER BY x.grp, x.name, x.b_name NULLS LAST, x.s_name NULLS LAST;
END;
$$;
REVOKE ALL ON FUNCTION public.production_material_options(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.production_material_options(uuid) TO authenticated;

NOTIFY pgrst, 'reload schema';
