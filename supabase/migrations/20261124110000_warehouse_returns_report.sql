CREATE INDEX IF NOT EXISTS rep_returns_factory_day_completed_idx
  ON public.rep_returns(factory_id, return_date) WHERE status = 'completed';
CREATE INDEX IF NOT EXISTS sales_returns_factory_day_completed_idx
  ON public.sales_returns(factory_id, return_date) WHERE status = 'completed';
CREATE INDEX IF NOT EXISTS jug_returns_factory_recorded_idx
  ON public.jug_returns(factory_id, recorded_at) WHERE status <> 'cancelled';

CREATE OR REPLACE FUNCTION public.warehouse_returns_report(
  p_factory uuid, p_from date, p_to date)
RETURNS TABLE(
  return_date date,
  category text,
  return_source text,
  product_id uuid,
  product text,
  unit text,
  reference text,
  party text,
  quantity numeric,
  quantity_received numeric,
  status text,
  received_by text,
  notes text
)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NOT (
    public.has_permission(auth.uid(), 'finished-goods'::module_key, 'view'::action_key)
    OR public.has_permission(auth.uid(), 'distribution'::module_key, 'view'::action_key)
    OR public.has_permission(auth.uid(), 'sales-returns'::module_key, 'view'::action_key)
  ) THEN
    RAISE EXCEPTION 'Insufficient permissions';
  END IF;
  IF p_factory IS NULL THEN RAISE EXCEPTION 'Pick a factory'; END IF;
  IF NOT public._works_in_factory(auth.uid(), p_factory) THEN
    RAISE EXCEPTION 'Insufficient permissions for this factory';
  END IF;
  IF p_from IS NULL OR p_to IS NULL OR p_from > p_to THEN
    RAISE EXCEPTION 'Pick a valid date range';
  END IF;
  IF p_to - p_from > 400 THEN
    RAISE EXCEPTION 'Pick a date range of at most 400 days';
  END IF;

  RETURN QUERY
  WITH goods_returns AS (
    SELECT rr.return_date,
           CASE WHEN p.name ~* '(dispenser|jug)' THEN 'dispenser' ELSE 'bottled_water' END AS category,
           CASE WHEN sr.kind = 'outlet' THEN 'Retail shop' ELSE 'Marketer' END AS return_source,
           p.id AS product_id,
           p.name::text AS product,
           COALESCE(p.unit, '')::text AS unit,
           rr.return_number::text AS reference,
           sr.full_name::text AS party,
           COALESCE(
             ri.accepted_quantity,
             CASE WHEN rr.status = 'completed'
                  THEN GREATEST(ri.quantity_returned - ri.damaged_quantity - ri.rejected_quantity, 0)
                  ELSE 0 END
           ) AS quantity,
           NULL::numeric AS quantity_received,
           rr.status::text AS status,
           COALESCE(NULLIF(u.full_name, ''), u.email)::text AS received_by,
           rr.notes::text AS notes
      FROM rep_returns rr
      JOIN sales_reps sr ON sr.id = rr.sales_rep_id
      JOIN rep_return_items ri ON ri.rep_return_id = rr.id
      JOIN products p ON p.id = ri.product_id
      LEFT JOIN profiles u ON u.id = rr.received_by
     WHERE rr.factory_id = p_factory
       AND rr.status = 'completed'
       AND rr.return_date BETWEEN p_from AND p_to
       AND p.product_type = 'finished'
       AND p.name !~* 'empty'
       AND p.name ~* '(bottle|bottled|dispenser|jug)'
       AND COALESCE(
             ri.accepted_quantity,
             GREATEST(ri.quantity_returned - ri.damaged_quantity - ri.rejected_quantity, 0)
           ) > 0

    UNION ALL

    SELECT r.return_date,
           CASE WHEN p.name ~* '(dispenser|jug)' THEN 'dispenser' ELSE 'bottled_water' END,
           'Customer',
           p.id,
           p.name::text,
           COALESCE(p.unit, '')::text,
           r.return_number::text,
           COALESCE(c.name, s.customer_name, 'Customer')::text,
           COALESCE(
             r.accepted_quantity,
             CASE WHEN r.status = 'completed'
                  THEN GREATEST(r.quantity_returned - r.damaged_quantity - r.rejected_quantity, 0)
                  ELSE 0 END
           ),
           NULL::numeric,
           r.status::text,
           COALESCE(NULLIF(u.full_name, ''), u.email)::text,
           COALESCE(r.notes, r.reason)::text
      FROM sales_returns r
      JOIN products p ON p.id = r.product_id
      LEFT JOIN customers c ON c.id = r.customer_id
      LEFT JOIN sales s ON s.id = r.sale_id
      LEFT JOIN profiles u ON u.id = r.received_by
     WHERE r.factory_id = p_factory
       AND r.sales_rep_id IS NULL
       AND r.status = 'completed'
       AND r.return_date BETWEEN p_from AND p_to
       AND p.product_type = 'finished'
       AND p.name !~* 'empty'
       AND p.name ~* '(bottle|bottled|dispenser|jug)'
       AND COALESCE(
             r.accepted_quantity,
             GREATEST(r.quantity_returned - r.damaged_quantity - r.rejected_quantity, 0)
           ) > 0
  ), empty_jug_returns AS (
    SELECT (jr.recorded_at AT TIME ZONE 'Africa/Lagos')::date AS return_date,
           'empty_jug'::text AS category,
           'Empty jug return'::text AS return_source,
           NULL::uuid AS product_id,
           ct.name::text AS product,
           'Jugs'::text AS unit,
           jr.reference::text AS reference,
           COALESCE(sr.full_name, c.name, 'Unknown')::text AS party,
           jr.quantity_claimed AS quantity,
           jr.quantity_received AS quantity_received,
           jr.status::text AS status,
           COALESCE(NULLIF(u.full_name, ''), u.email)::text AS received_by,
           COALESCE(jr.verify_note, jr.notes)::text AS notes
      FROM jug_returns jr
      JOIN container_types ct ON ct.id = jr.container_type_id
      LEFT JOIN sales_reps sr ON sr.id = jr.sales_rep_id
      LEFT JOIN customers c ON c.id = jr.customer_id
      LEFT JOIN profiles u ON u.id = jr.recorded_by
     WHERE jr.factory_id = p_factory
       AND jr.status <> 'cancelled'
       AND (jr.recorded_at AT TIME ZONE 'Africa/Lagos')::date BETWEEN p_from AND p_to
       AND ct.name ~* '(jug|dispenser)'
  )
  SELECT gr.* FROM goods_returns gr
   WHERE gr.quantity > 0
  UNION ALL
  SELECT * FROM empty_jug_returns
   ORDER BY return_date DESC, category, product, reference;
END;
$$;

REVOKE ALL ON FUNCTION public.warehouse_returns_report(uuid, date, date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.warehouse_returns_report(uuid, date, date) TO authenticated;

NOTIFY pgrst, 'reload schema';
