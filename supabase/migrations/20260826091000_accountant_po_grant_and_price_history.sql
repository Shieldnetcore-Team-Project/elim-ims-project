-- ============================================================================
-- ACCOUNTANT PURCHASE-ORDERS GRANT + PRODUCT PRICE HISTORY
-- ----------------------------------------------------------------------------
-- Closes the remaining two gaps found while auditing spec sections 40/42:
--
-- 1. finance-overview.tsx's "open PO commitment" KPI queries purchase_orders
--    directly, but accountant was never granted anything on that module (only
--    inventory_officer/chairman were, in 20260817092000) -- RLS silently
--    returned zero rows for every accountant. Same class of bug as the
--    accountant/sales grant fixed in 20260822090000.
--
-- 2. products.unit_price had no history -- editing it on the Edit Product
--    form just overwrote the value with no trace of what it used to be, who
--    changed it, or when. sale_items.unit_price already freezes its own
--    price per line item, so past invoices were never actually at risk, but
--    there was no audit trail of the price change itself. A trigger (not an
--    app-level insert) logs every change, so it can't be bypassed by any
--    future direct-update path the way an application-level log could be.
--    No approval gate is added here -- price edits stay a direct, ungated
--    field, same as today -- this only makes the change itself traceable.
-- ============================================================================

-- ============ 1. accountant: purchase-orders view/export/print ============
INSERT INTO public.role_permissions (role, module, action)
SELECT 'accountant','purchase-orders', a FROM unnest(ARRAY['view','export','print']::action_key[]) a
ON CONFLICT DO NOTHING;

-- ============ 2. product_price_history ============
CREATE TABLE public.product_price_history (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id uuid NOT NULL REFERENCES public.products(id) ON DELETE CASCADE,
  price numeric(14,2) NOT NULL,
  previous_price numeric(14,2),
  effective_date timestamptz NOT NULL DEFAULT now(),
  approved_by uuid REFERENCES auth.users(id),
  created_by uuid REFERENCES auth.users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT ON public.product_price_history TO authenticated;
GRANT ALL ON public.product_price_history TO service_role;
ALTER TABLE public.product_price_history ENABLE ROW LEVEL SECURITY;
CREATE POLICY "price history read" ON public.product_price_history FOR SELECT TO authenticated
  USING (public.has_permission(auth.uid(), 'finished-goods'::module_key, 'view'::action_key));
-- No write policy for authenticated: only the trigger below (SECURITY
-- DEFINER, runs as its owner) inserts rows -- a direct client insert can't
-- forge history.

CREATE OR REPLACE FUNCTION public.log_product_price_change()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NEW.unit_price IS DISTINCT FROM OLD.unit_price THEN
    INSERT INTO product_price_history(product_id, price, previous_price, created_by)
    VALUES (NEW.id, NEW.unit_price, OLD.unit_price, auth.uid());
  END IF;
  RETURN NEW;
END; $$;

CREATE TRIGGER products_price_history AFTER UPDATE ON public.products
FOR EACH ROW EXECUTE FUNCTION public.log_product_price_change();

-- Seed one opening row per existing product so history isn't empty for
-- products priced before this migration -- previous_price NULL marks it as
-- the starting point, not a change.
INSERT INTO product_price_history(product_id, price, previous_price, created_by, created_at)
SELECT id, unit_price, NULL, NULL, created_at FROM public.products;
