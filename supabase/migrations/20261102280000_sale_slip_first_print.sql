-- ============================================================================
-- Shop sale slips: the first print is always the two copies
-- ----------------------------------------------------------------------------
-- User (2026-11-02): "if sales has not been printed, any time retail need to
-- print, it should come with customers receipt and sales rep receipt, until
-- she print that first, any other one should be reprint".
--
-- Until now the app assumed the two slips (Sales-Rep Copy, Customer Copy)
-- printed when the sale was saved, so every later print was a Reprint --
-- even when the first print never happened. Now it is recorded:
--   sale_slip_prints        one row per sale whose two slips have printed
--   claim_sale_slips(ids)   true when this print is the sale's first (rows
--                           added now) -- print the two copies; false when
--                           they printed before -- print a Reprint.
-- Sales made before this migration printed their slips when they were saved,
-- so they are recorded as printed. Safe to run again.
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.sale_slip_prints (
  sale_id uuid PRIMARY KEY REFERENCES public.sales(id) ON DELETE CASCADE,
  printed_at timestamptz NOT NULL DEFAULT now(),
  printed_by uuid REFERENCES auth.users(id)
);
GRANT SELECT ON public.sale_slip_prints TO authenticated;
GRANT ALL ON public.sale_slip_prints TO service_role;
ALTER TABLE public.sale_slip_prints ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "sale slip prints read" ON public.sale_slip_prints;
CREATE POLICY "sale slip prints read" ON public.sale_slip_prints FOR SELECT TO authenticated USING (true);

-- Earlier sales: printed when they were saved.
INSERT INTO public.sale_slip_prints(sale_id, printed_at)
SELECT s.id, s.created_at FROM public.sales s
ON CONFLICT (sale_id) DO NOTHING;

CREATE OR REPLACE FUNCTION public.claim_sale_slips(p_sales uuid[])
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_n int;
BEGIN
  IF NOT public.has_permission(auth.uid(), 'sales'::module_key, 'view'::action_key) THEN
    RAISE EXCEPTION 'Insufficient permissions';
  END IF;
  INSERT INTO sale_slip_prints(sale_id, printed_by)
  SELECT s.id, auth.uid() FROM sales s
   WHERE s.id = ANY(p_sales) AND public._works_in_factory(auth.uid(), s.factory_id)
  ON CONFLICT (sale_id) DO NOTHING;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n > 0;
END;
$$;
REVOKE ALL ON FUNCTION public.claim_sale_slips(uuid[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.claim_sale_slips(uuid[]) TO authenticated;

NOTIFY pgrst, 'reload schema';
