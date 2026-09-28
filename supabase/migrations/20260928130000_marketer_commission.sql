-- ============================================================================
-- Marketer (sales rep) commission: a fixed amount per unit, set per product
-- ----------------------------------------------------------------------------
-- Backs Warehouse -> "Performance & commission".
--
--   product_commission_rates   the current rate per unit for each product
--                              (no row = no commission). Written only by
--                              set_product_commission() (distribution:approve),
--                              each change audited.
--   sale_items.commission_per_unit
--                              the rate captured on a rep sale's lines when the
--                              sale is approved, so changing a rate later never
--                              rewrites commission already earned.
--   marketer_performance()     per rep for a period: sales, units, value,
--                              commission earned, commission lost to customer
--                              returns, net commission, cash remitted.
--
-- Commission is earned on approved (posted) sales made through a rep
-- (sales.sales_rep_id). A sale deleted afterwards (approve_delete reverses it)
-- drops out; an accepted customer return on a rep sale takes back the
-- commission on the returned units, at the rate captured on that sale.
-- Paying commission out is not recorded here (use Payroll or Expenses).
-- ============================================================================

-- ============ 1. Rates ============
CREATE TABLE public.product_commission_rates (
  product_id uuid PRIMARY KEY REFERENCES public.products(id) ON DELETE CASCADE,
  factory_id uuid NOT NULL REFERENCES public.factories(id) ON DELETE CASCADE,
  amount_per_unit numeric(14,2) NOT NULL CHECK (amount_per_unit >= 0),
  updated_by uuid REFERENCES auth.users(id),
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.product_commission_rates ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.product_commission_rates FROM anon, authenticated;
GRANT SELECT ON public.product_commission_rates TO authenticated;
GRANT ALL ON public.product_commission_rates TO service_role;
CREATE POLICY "commission rates read" ON public.product_commission_rates FOR SELECT TO authenticated
  USING (public.has_permission(auth.uid(), 'distribution'::module_key, 'view'::action_key));

-- ============ 2. Rate captured on the sale ============
-- sale_items is already write-once via RPC (no client INSERT/UPDATE), so
-- this column can't be edited from the browser.
ALTER TABLE public.sale_items
  ADD COLUMN commission_per_unit numeric(14,2) NOT NULL DEFAULT 0 CHECK (commission_per_unit >= 0);

-- Stamped when a rep sale is approved. A trigger rather than another copy of
-- approve_sale(), which only ever moves a sale to 'posted' once.
CREATE OR REPLACE FUNCTION public._sales_capture_commission()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NEW.status = 'posted' AND OLD.status IS DISTINCT FROM 'posted' AND NEW.sales_rep_id IS NOT NULL
     AND NOT COALESCE(NEW.is_pr, false) THEN
    UPDATE sale_items si
       SET commission_per_unit = COALESCE(
             (SELECT r.amount_per_unit FROM product_commission_rates r WHERE r.product_id = si.product_id), 0)
     WHERE si.sale_id = NEW.id;
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_sales_capture_commission ON public.sales;
CREATE TRIGGER trg_sales_capture_commission
  AFTER UPDATE OF status ON public.sales
  FOR EACH ROW EXECUTE FUNCTION public._sales_capture_commission();

-- ============ 3. Setting a rate ============
CREATE OR REPLACE FUNCTION public.set_product_commission(p_product uuid, p_amount numeric, p_reason text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_product products%ROWTYPE;
  v_old numeric;
BEGIN
  IF NOT public.has_permission(v_uid, 'distribution'::module_key, 'approve'::action_key) THEN
    RAISE EXCEPTION 'Insufficient permissions';
  END IF;
  IF p_amount IS NULL OR p_amount < 0 THEN RAISE EXCEPTION 'Commission must be 0 or more'; END IF;
  SELECT * INTO v_product FROM products WHERE id = p_product;
  IF NOT FOUND THEN RAISE EXCEPTION 'Product not found'; END IF;

  SELECT amount_per_unit INTO v_old FROM product_commission_rates WHERE product_id = p_product FOR UPDATE;

  INSERT INTO product_commission_rates(product_id, factory_id, amount_per_unit, updated_by, updated_at)
  VALUES (p_product, v_product.factory_id, round(p_amount, 2), v_uid, now())
  ON CONFLICT (product_id) DO UPDATE
    SET amount_per_unit = EXCLUDED.amount_per_unit, updated_by = EXCLUDED.updated_by, updated_at = now();

  INSERT INTO audit_logs(user_id, factory_id, action, entity, entity_id, old_value, new_value)
  VALUES (v_uid, v_product.factory_id, 'set_product_commission', 'products', p_product::text,
          jsonb_build_object('commission_per_unit', COALESCE(v_old, 0)),
          jsonb_build_object('commission_per_unit', round(p_amount, 2), 'reason', p_reason));

  RETURN jsonb_build_object('product_id', p_product, 'commission_per_unit', round(p_amount, 2));
END;
$$;
REVOKE ALL ON FUNCTION public.set_product_commission(uuid, numeric, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.set_product_commission(uuid, numeric, text) TO authenticated;

-- ============ 4. Performance per marketer ============
-- Sales are counted by sale date and remittances by remittance date, both
-- within [p_from, p_to]. Returns count against the sale they came from, so a
-- return belongs to the same period as the commission it takes back.
CREATE OR REPLACE FUNCTION public.marketer_performance(p_factory uuid, p_from date, p_to date)
RETURNS TABLE(
  sales_rep_id uuid, full_name text, rep_status text,
  sales_count bigint, units_sold numeric, sales_value numeric,
  commission_earned numeric, units_returned numeric, commission_reversed numeric,
  net_commission numeric, cash_remitted numeric
)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NOT public.has_permission(auth.uid(), 'distribution'::module_key, 'view'::action_key) THEN
    RAISE EXCEPTION 'Insufficient permissions';
  END IF;
  RETURN QUERY
  WITH s AS (
    SELECT sa.id, sa.sales_rep_id
      FROM sales sa
     WHERE sa.factory_id = p_factory AND sa.sales_rep_id IS NOT NULL
       AND sa.status = 'posted' AND sa.deleted_at IS NULL AND NOT COALESCE(sa.is_pr, false)
       AND sa.sale_date BETWEEN p_from AND p_to
  ), lines AS (
    SELECT s.sales_rep_id, count(DISTINCT s.id) AS n,
           SUM(si.quantity) AS units, SUM(si.line_total) AS value,
           SUM(si.quantity * si.commission_per_unit) AS commission
      FROM s JOIN sale_items si ON si.sale_id = s.id
     GROUP BY s.sales_rep_id
  ), ret AS (
    SELECT s.sales_rep_id,
           SUM(sr.accepted_quantity) AS units,
           SUM(sr.accepted_quantity * COALESCE(
                 (SELECT max(si.commission_per_unit) FROM sale_items si
                   WHERE si.sale_id = sr.sale_id AND si.product_id = sr.product_id), 0)) AS commission
      FROM sales_returns sr JOIN s ON s.id = sr.sale_id
     WHERE sr.status = 'completed' AND COALESCE(sr.accepted_quantity, 0) > 0
     GROUP BY s.sales_rep_id
  ), rem AS (
    SELECT rr.sales_rep_id, SUM(rr.amount) AS amount
      FROM rep_remittances rr
     WHERE rr.factory_id = p_factory AND rr.remittance_date BETWEEN p_from AND p_to
     GROUP BY rr.sales_rep_id
  )
  SELECT r.id, r.full_name, r.status,
         COALESCE(l.n, 0), COALESCE(l.units, 0), COALESCE(l.value, 0),
         round(COALESCE(l.commission, 0), 2), COALESCE(t.units, 0), round(COALESCE(t.commission, 0), 2),
         round(GREATEST(COALESCE(l.commission, 0) - COALESCE(t.commission, 0), 0), 2),
         COALESCE(m.amount, 0)
    FROM sales_reps r
    LEFT JOIN lines l ON l.sales_rep_id = r.id
    LEFT JOIN ret t ON t.sales_rep_id = r.id
    LEFT JOIN rem m ON m.sales_rep_id = r.id
   WHERE r.factory_id = p_factory
     AND (r.status = 'active' OR l.n IS NOT NULL OR m.amount IS NOT NULL)
   ORDER BY COALESCE(l.value, 0) DESC, r.full_name;
END;
$$;
REVOKE ALL ON FUNCTION public.marketer_performance(uuid, date, date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.marketer_performance(uuid, date, date) TO authenticated;
