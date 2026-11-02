-- ============================================================================
-- "Dispenser Jug" counts as a dispenser on customer returns
-- ----------------------------------------------------------------------------
-- User (2026-11-02): logging 6 returned (of 17 supplied) for NNOLI
-- SUPERMARKET in the Warehouse failed with "Dispenser Jug is not a
-- dispenser".
--
-- On a database without jug tracking (no product_containers -- the live one)
-- _is_dispenser_product (20261102120000) went by name and left out names
-- ending in "Dispenser Jug", meant for the empty jug. But "Dispenser Jug" is
-- a finished product the Warehouse posts and sells to customers, so it can
-- come back. Now: any finished product named "Dispenser..." or "...Jug
-- Water". Empty jugs are container types, not finished products, so they
-- stay out. With jug tracking the jug table still decides.
-- ============================================================================

CREATE OR REPLACE FUNCTION public._is_dispenser_product(p_product uuid)
RETURNS boolean LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE v_found boolean;
BEGIN
  IF to_regclass('public.product_containers') IS NOT NULL THEN
    EXECUTE 'SELECT EXISTS (SELECT 1 FROM product_containers pc
                             WHERE pc.product_id = $1 AND pc.jug_role IS DISTINCT FROM ''empty'')'
       INTO v_found USING p_product;
    IF v_found THEN RETURN true; END IF;
  END IF;
  RETURN EXISTS (SELECT 1 FROM products p WHERE p.id = p_product
                    AND p.product_type = 'finished'
                    AND p.name ~* '(dispenser|jug water)');
END;
$$;
REVOKE ALL ON FUNCTION public._is_dispenser_product(uuid) FROM PUBLIC, anon, authenticated;

NOTIFY pgrst, 'reload schema';
