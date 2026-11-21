-- ============================================================================
-- Two factories: Kubwa Factory and Lugbe Factory
-- ----------------------------------------------------------------------------
-- User (2026-11-21): build a second factory with the same flow of operations,
-- the same pages and the same build. Name the two "Kubwa Factory" (the
-- factory this system has run until now) and "Lugbe Factory" (the new one).
-- Only the Chairman and Admin can switch between them, from the dropdown
-- beside the Dashboard title. Every other account stays in Kubwa until the
-- Admin allows it into Lugbe.
--
--   * Kubwa keeps its internal code 'water', so every function, seed and
--     report that looks the factory up by code keeps working. Only the name
--     changes.
--   * Lugbe ('lugbe') starts with the same setup copied from Kubwa:
--     settings, product/material/expense categories, container types,
--     suppliers, brands, products, raw materials and commission rates. Stock,
--     values and supplier balances start at zero. No records (sales,
--     production, postings, ledgers) are copied. Each table is copied only
--     while Lugbe has none of its own, so running this again changes nothing.
--   * factory_access: which accounts may open which factory besides Kubwa.
--     Chairman and Admin (super_admin) can open every factory. The two
--     Chairman/Admin emails are also listed explicitly.
--   * Production scope: Lugbe is a water factory too, so a WATER scope now
--     covers both factories. It used to match the factory code, which would
--     have locked Production staff out of Lugbe.
-- Safe to run again.
-- ============================================================================

-- 1. The two factories -------------------------------------------------------
UPDATE public.factories SET name = 'Kubwa Factory' WHERE code = 'water';

INSERT INTO public.factories (code, name)
VALUES ('lugbe', 'Lugbe Factory')
ON CONFLICT (code) DO UPDATE SET name = EXCLUDED.name;

-- 2. Lugbe's setup, copied from Kubwa -----------------------------------------
CREATE TEMP TABLE _lugbe_map (old_id uuid PRIMARY KEY, new_id uuid NOT NULL) ON COMMIT DROP;

CREATE OR REPLACE FUNCTION pg_temp._nid(_old uuid) RETURNS uuid
LANGUAGE sql STABLE AS $$ SELECT new_id FROM _lugbe_map WHERE old_id = _old $$;

DO $$
DECLARE
  v_src uuid;
  v_dst uuid;
BEGIN
  SELECT id INTO v_src FROM public.factories WHERE code = 'water';
  SELECT id INTO v_dst FROM public.factories WHERE code = 'lugbe';
  IF v_src IS NULL OR v_dst IS NULL THEN
    RAISE EXCEPTION 'Kubwa (water) or Lugbe factory missing -- nothing copied';
  END IF;

  -- New ids for every row about to be copied, so links can be remapped.
  INSERT INTO _lugbe_map (old_id, new_id)
  SELECT id, gen_random_uuid() FROM (
    SELECT id FROM public.product_categories  WHERE factory_id = v_src
      AND NOT EXISTS (SELECT 1 FROM public.product_categories  WHERE factory_id = v_dst)
    UNION ALL
    SELECT id FROM public.material_categories WHERE factory_id = v_src
      AND NOT EXISTS (SELECT 1 FROM public.material_categories WHERE factory_id = v_dst)
    UNION ALL
    SELECT id FROM public.expense_categories  WHERE factory_id = v_src
      AND NOT EXISTS (SELECT 1 FROM public.expense_categories  WHERE factory_id = v_dst)
    UNION ALL
    SELECT id FROM public.container_types     WHERE factory_id = v_src
      AND NOT EXISTS (SELECT 1 FROM public.container_types     WHERE factory_id = v_dst)
    UNION ALL
    SELECT id FROM public.suppliers           WHERE factory_id = v_src
      AND NOT EXISTS (SELECT 1 FROM public.suppliers           WHERE factory_id = v_dst)
    UNION ALL
    SELECT id FROM public.brands              WHERE factory_id = v_src
      AND NOT EXISTS (SELECT 1 FROM public.brands              WHERE factory_id = v_dst)
    UNION ALL
    SELECT id FROM public.products            WHERE factory_id = v_src
      AND NOT EXISTS (SELECT 1 FROM public.products            WHERE factory_id = v_dst)
    UNION ALL
    SELECT id FROM public.raw_materials       WHERE factory_id = v_src
      AND NOT EXISTS (SELECT 1 FROM public.raw_materials       WHERE factory_id = v_dst)
  ) s;

  -- Settings (invoice prefixes, company details, VAT).
  IF NOT EXISTS (SELECT 1 FROM public.settings WHERE factory_id = v_dst) THEN
    INSERT INTO public.settings
    SELECT (jsonb_populate_record(NULL::public.settings, to_jsonb(r) || jsonb_build_object(
      'id', gen_random_uuid(), 'factory_id', v_dst,
      'created_at', now(), 'updated_at', now()))).*
    FROM public.settings r WHERE r.factory_id = v_src;
  END IF;

  INSERT INTO public.product_categories
  SELECT (jsonb_populate_record(NULL::public.product_categories, to_jsonb(r) || jsonb_build_object(
    'id', pg_temp._nid(r.id), 'factory_id', v_dst, 'created_at', now()))).*
  FROM public.product_categories r
  WHERE r.factory_id = v_src AND pg_temp._nid(r.id) IS NOT NULL;

  INSERT INTO public.material_categories
  SELECT (jsonb_populate_record(NULL::public.material_categories, to_jsonb(r) || jsonb_build_object(
    'id', pg_temp._nid(r.id), 'factory_id', v_dst, 'created_at', now()))).*
  FROM public.material_categories r
  WHERE r.factory_id = v_src AND pg_temp._nid(r.id) IS NOT NULL;

  INSERT INTO public.expense_categories
  SELECT (jsonb_populate_record(NULL::public.expense_categories, to_jsonb(r) || jsonb_build_object(
    'id', pg_temp._nid(r.id), 'factory_id', v_dst, 'created_at', now()))).*
  FROM public.expense_categories r
  WHERE r.factory_id = v_src AND pg_temp._nid(r.id) IS NOT NULL;

  INSERT INTO public.container_types
  SELECT (jsonb_populate_record(NULL::public.container_types, to_jsonb(r) || jsonb_build_object(
    'id', pg_temp._nid(r.id), 'factory_id', v_dst, 'created_at', now()))).*
  FROM public.container_types r
  WHERE r.factory_id = v_src AND pg_temp._nid(r.id) IS NOT NULL;

  INSERT INTO public.suppliers
  SELECT (jsonb_populate_record(NULL::public.suppliers, to_jsonb(r) || jsonb_build_object(
    'id', pg_temp._nid(r.id), 'factory_id', v_dst, 'outstanding_balance', 0,
    'created_at', now(), 'updated_at', now()))).*
  FROM public.suppliers r
  WHERE r.factory_id = v_src AND pg_temp._nid(r.id) IS NOT NULL;

  INSERT INTO public.brands
  SELECT (jsonb_populate_record(NULL::public.brands, to_jsonb(r) || jsonb_build_object(
    'id', pg_temp._nid(r.id), 'factory_id', v_dst, 'supplier_id', pg_temp._nid(r.supplier_id),
    'created_at', now(), 'updated_at', now()))).*
  FROM public.brands r
  WHERE r.factory_id = v_src AND pg_temp._nid(r.id) IS NOT NULL;

  INSERT INTO public.products
  SELECT (jsonb_populate_record(NULL::public.products, to_jsonb(r) || jsonb_build_object(
    'id', pg_temp._nid(r.id), 'factory_id', v_dst, 'category_id', pg_temp._nid(r.category_id),
    'current_stock', 0, 'created_at', now(), 'updated_at', now()))).*
  FROM public.products r
  WHERE r.factory_id = v_src AND pg_temp._nid(r.id) IS NOT NULL;

  INSERT INTO public.raw_materials
  SELECT (jsonb_populate_record(NULL::public.raw_materials, to_jsonb(r) || jsonb_build_object(
    'id', pg_temp._nid(r.id), 'factory_id', v_dst,
    'category_id', pg_temp._nid(r.category_id),
    'brand_id', pg_temp._nid(r.brand_id),
    'supplier_id', pg_temp._nid(r.supplier_id),
    'output_product_id', pg_temp._nid(r.output_product_id),
    'current_stock', 0, 'current_value', 0, 'opening_stock', 0,
    'created_at', now(), 'updated_at', now()))).*
  FROM public.raw_materials r
  WHERE r.factory_id = v_src AND pg_temp._nid(r.id) IS NOT NULL;

  IF NOT EXISTS (SELECT 1 FROM public.product_commission_rates WHERE factory_id = v_dst) THEN
    INSERT INTO public.product_commission_rates
    SELECT (jsonb_populate_record(NULL::public.product_commission_rates, to_jsonb(r) || jsonb_build_object(
      'factory_id', v_dst, 'product_id', pg_temp._nid(r.product_id), 'updated_at', now()))).*
    FROM public.product_commission_rates r
    WHERE r.factory_id = v_src AND pg_temp._nid(r.product_id) IS NOT NULL;
  END IF;
END $$;

-- 3. Who may open which factory --------------------------------------------
CREATE TABLE IF NOT EXISTS public.factory_access (
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  factory_id uuid NOT NULL REFERENCES public.factories(id) ON DELETE CASCADE,
  granted_by uuid REFERENCES auth.users(id),
  granted_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, factory_id)
);
ALTER TABLE public.factory_access ENABLE ROW LEVEL SECURITY;
GRANT SELECT ON public.factory_access TO authenticated;
GRANT ALL ON public.factory_access TO service_role;

DROP POLICY IF EXISTS "factory access read" ON public.factory_access;
CREATE POLICY "factory access read" ON public.factory_access FOR SELECT TO authenticated
  USING (user_id = auth.uid()
         OR public.has_role(auth.uid(), 'super_admin')
         OR public.has_role(auth.uid(), 'chairman'));

-- Chairman / Admin: every factory.
CREATE OR REPLACE FUNCTION public.is_factory_switcher(_user_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT _user_id IS NOT NULL AND (
    public.has_role(_user_id, 'super_admin')
    OR public.has_role(_user_id, 'chairman')
    OR EXISTS (SELECT 1 FROM auth.users u
                WHERE u.id = _user_id
                  AND lower(u.email) IN ('elimwaters09@gmail.com', 'sbjoel160@gmail.com'))
  );
$$;
GRANT EXECUTE ON FUNCTION public.is_factory_switcher(uuid) TO authenticated;

-- The factories the signed-in account may open. Kubwa always; the rest by
-- role or by an Admin's grant.
CREATE OR REPLACE FUNCTION public.my_factories()
RETURNS TABLE (id uuid, code text, name text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT f.id, f.code, f.name
    FROM public.factories f
   WHERE f.code = 'water'
      OR public.is_factory_switcher(auth.uid())
      OR EXISTS (SELECT 1 FROM public.factory_access a
                  WHERE a.user_id = auth.uid() AND a.factory_id = f.id)
   ORDER BY (f.code <> 'water'), f.name;
$$;
GRANT EXECUTE ON FUNCTION public.my_factories() TO authenticated;

-- Admin / Chairman allow or remove an account's access to a factory.
CREATE OR REPLACE FUNCTION public.set_factory_access(_user_id uuid, _factory_id uuid, _granted boolean)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NOT public.is_factory_switcher(auth.uid()) THEN
    RAISE EXCEPTION 'Only the Chairman or Admin can change factory access';
  END IF;
  IF _granted THEN
    INSERT INTO public.factory_access (user_id, factory_id, granted_by)
    VALUES (_user_id, _factory_id, auth.uid())
    ON CONFLICT (user_id, factory_id) DO NOTHING;
  ELSE
    DELETE FROM public.factory_access WHERE user_id = _user_id AND factory_id = _factory_id;
  END IF;
  INSERT INTO public.audit_logs (user_id, factory_id, action, entity, entity_id, new_value)
  VALUES (auth.uid(), _factory_id, CASE WHEN _granted THEN 'grant' ELSE 'revoke' END,
          'factory_access', _user_id::text, jsonb_build_object('granted', _granted));
END;
$$;
GRANT EXECUTE ON FUNCTION public.set_factory_access(uuid, uuid, boolean) TO authenticated;

-- 4. Production scope: WATER covers both water factories --------------------
CREATE OR REPLACE FUNCTION public.has_production_scope_access(_user_id uuid, _factory_id uuid)
 RETURNS boolean
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE v_scope text; v_factory_code text;
BEGIN
  IF _user_id IS NULL THEN RETURN false; END IF;
  IF public.has_role(_user_id, 'super_admin') OR public.has_role(_user_id, 'chairman') THEN RETURN true; END IF;
  IF _factory_id IS NULL THEN RETURN true; END IF;

  SELECT production_scope INTO v_scope FROM profiles WHERE id = _user_id;
  IF v_scope IS NULL OR v_scope = 'BOTH' OR v_scope = 'WATER' THEN RETURN true; END IF;

  SELECT upper(code) INTO v_factory_code FROM factories WHERE id = _factory_id;
  RETURN v_factory_code = v_scope;
END;
$function$;
