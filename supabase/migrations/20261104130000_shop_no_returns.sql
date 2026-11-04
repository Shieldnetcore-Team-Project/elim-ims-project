-- ============================================================================
-- The Retail Shop no longer returns unsold products
-- ----------------------------------------------------------------------------
-- User (2026-11-04): "remove the return for retail, retail no longer return
-- unsold products, just only post monies sold for the day".
--
-- The app no longer offers it (Retail Outlet "Return unsold to Warehouse",
-- the unsold column of Post Balance, the returns box on Post to Retail Shop,
-- Return products in the shop's Warehouse window). Here the database refuses
-- a new return from a retail outlet, whichever way it comes
-- (return_shop_stock_to_warehouse, close_shop_day with unsold, create_rep_return).
-- Returns already recorded are left as they are. Marketers still return.
-- ============================================================================

CREATE OR REPLACE FUNCTION public._no_shop_returns()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM sales_reps WHERE id = NEW.sales_rep_id AND kind = 'outlet') THEN
    RAISE EXCEPTION 'The Retail Shop no longer returns unsold products -- they stay at the shop; post only the day''s money';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_no_shop_returns ON public.rep_returns;
CREATE TRIGGER trg_no_shop_returns BEFORE INSERT ON public.rep_returns
  FOR EACH ROW EXECUTE FUNCTION public._no_shop_returns();
