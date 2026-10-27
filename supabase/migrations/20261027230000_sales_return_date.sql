-- ============================================================================
-- Sales returns get a return date that can be set back
-- ----------------------------------------------------------------------------
-- "Log a Sales Return" now has a date, so a return can be logged on the day
-- the goods came back -- e.g. products a marketer returned yesterday, logged
-- this morning, dated yesterday. Marketer returns already took return_date
-- (create_rep_return); customer returns now do too:
--   * sales_returns.return_date (date, default today; existing rows take the
--     day they were logged);
--   * create_sales_return takes an optional payload.return_date.
-- A return can't be dated in the future.
-- ============================================================================

ALTER TABLE public.sales_returns ADD COLUMN IF NOT EXISTS return_date date;
UPDATE public.sales_returns SET return_date = received_at::date WHERE return_date IS NULL;
ALTER TABLE public.sales_returns ALTER COLUMN return_date SET DEFAULT CURRENT_DATE;
ALTER TABLE public.sales_returns ALTER COLUMN return_date SET NOT NULL;

CREATE OR REPLACE FUNCTION public.create_sales_return(payload jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_factory uuid := (payload->>'factory_id')::uuid;
  v_sale_id uuid := NULLIF(payload->>'sale_id','')::uuid;
  v_customer_id uuid := NULLIF(payload->>'customer_id','')::uuid;
  v_product_id uuid := (payload->>'product_id')::uuid;
  v_qty numeric := (payload->>'quantity_returned')::numeric;
  v_reason text := payload->>'reason';
  v_date date := COALESCE(NULLIF(payload->>'return_date','')::date, CURRENT_DATE);
  v_product products%ROWTYPE;
  v_number text; v_id uuid;
BEGIN
  IF NOT public.has_permission(v_uid, 'sales-returns'::module_key, 'submit'::action_key) THEN RAISE EXCEPTION 'Insufficient permissions'; END IF;
  IF v_factory IS NULL THEN RAISE EXCEPTION 'factory_id required'; END IF;
  IF v_qty IS NULL OR v_qty <= 0 THEN RAISE EXCEPTION 'Quantity returned must be > 0'; END IF;
  IF v_date > CURRENT_DATE THEN RAISE EXCEPTION 'A return can''t be dated in the future'; END IF;

  SELECT * INTO v_product FROM products WHERE id = v_product_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Product not found'; END IF;
  IF v_product.factory_id <> v_factory THEN RAISE EXCEPTION 'Product does not belong to factory'; END IF;

  IF v_sale_id IS NOT NULL THEN
    IF NOT EXISTS (SELECT 1 FROM sales WHERE id = v_sale_id AND factory_id = v_factory) THEN
      RAISE EXCEPTION 'Sale not found for this factory';
    END IF;
  END IF;

  v_number := 'SR-' || to_char(now(),'YYYYMMDD') || '-' || lpad(((floor(random()*99999))::int)::text, 5, '0');

  INSERT INTO sales_returns(factory_id, return_number, sale_id, customer_id, product_id, quantity_returned, unit, reason, received_by, return_date)
  VALUES (v_factory, v_number, v_sale_id, v_customer_id, v_product_id, v_qty, v_product.unit, v_reason, v_uid, v_date)
  RETURNING id INTO v_id;

  RETURN jsonb_build_object('id', v_id, 'return_number', v_number);
END; $$;
GRANT EXECUTE ON FUNCTION public.create_sales_return(jsonb) TO authenticated;
