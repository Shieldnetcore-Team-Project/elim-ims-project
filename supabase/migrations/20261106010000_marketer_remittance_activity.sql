CREATE OR REPLACE FUNCTION public.marketer_remittance_activity(
  p_factory uuid,
  p_from date,
  p_to date
)
RETURNS TABLE(
  id uuid,
  sales_rep_id uuid,
  marketer text,
  remittance_number text,
  remittance_date date,
  created_at timestamptz,
  amount numeric,
  payment_method text,
  remarks text
)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NOT (
    public.has_permission(auth.uid(), 'distribution'::module_key, 'view'::action_key)
    OR public.has_permission(auth.uid(), 'marketer-accounts'::module_key, 'view'::action_key)
    OR public.has_permission(auth.uid(), 'finance'::module_key, 'view'::action_key)
    OR public.has_permission(auth.uid(), 'payments'::module_key, 'view'::action_key)
  ) THEN
    RAISE EXCEPTION 'Insufficient permissions';
  END IF;
  IF NOT public._works_in_factory(auth.uid(), p_factory) THEN
    RAISE EXCEPTION 'Insufficient permissions';
  END IF;
  IF p_from IS NULL OR p_to IS NULL OR p_to < p_from THEN
    RAISE EXCEPTION 'Choose a valid date range';
  END IF;
  IF p_to - p_from > 366 THEN
    RAISE EXCEPTION 'Choose at most one year';
  END IF;

  RETURN QUERY
  SELECT m.id, m.sales_rep_id, r.full_name::text, m.remittance_number,
         m.remittance_date, m.created_at, m.amount, m.payment_method::text, m.remarks
    FROM public.rep_remittances m
    JOIN public.sales_reps r ON r.id = m.sales_rep_id
   WHERE m.factory_id = p_factory
     AND r.kind = 'rep'
     AND m.remittance_date BETWEEN p_from AND p_to
   ORDER BY m.remittance_date DESC, m.created_at DESC, m.remittance_number DESC;
END;
$$;
REVOKE ALL ON FUNCTION public.marketer_remittance_activity(uuid, date, date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.marketer_remittance_activity(uuid, date, date) TO authenticated;

NOTIFY pgrst, 'reload schema';
