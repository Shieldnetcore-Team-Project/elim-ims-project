-- ============================================================================
-- FIX: "function public.has_permission(uuid, unknown, action_key) is not unique"
-- ----------------------------------------------------------------------------
-- Two has_permission overloads exist:
--   has_permission(uuid, module_key, action_key)    -- the real one
--   has_permission(uuid, module_key, access_level)  -- legacy, kept for old
--                                                     RLS policies (20260912110000)
-- module_key, action_key and access_level are all domains over text. A call
-- whose module is a bare string literal -- has_permission(v_uid,
-- 'production-requests', 'approve'::action_key) -- has no exact match, so
-- Postgres resolves on the base types, where both overloads look like
-- (uuid, text, text), and gives up. 20260816110000 fixed this once by casting
-- the module, but later migrations brought the bare-literal form back
-- (approve_production_request, confirm_production_request,
-- create_production_request, confirm_production_batch, confirm_goods_receipt,
-- submit_goods_receipt, create_purchase_order and more).
--
-- Rather than hand-copy ~25 function bodies (some last defined in early
-- migrations and possibly replaced since), patch whatever is actually live:
-- for every public function that calls has_permission, take its current
-- definition, cast a bare-literal module argument to module_key and a
-- bare-literal action argument to action_key, and re-create it. Only those
-- call sites change; CREATE OR REPLACE keeps owners and grants. Functions with
-- nothing to fix are left untouched.
-- ============================================================================

DO $do$
DECLARE
  r record;
  v_def text;
  v_new text;
  -- First argument: anything without a comma, allowing one level of
  -- empty parens such as auth.uid().
  c_arg constant text := '(?:[^,()]|\(\))+';
BEGIN
  FOR r IN
    SELECT p.oid, p.oid::regprocedure AS sig
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.prokind = 'f'
      AND p.proname <> 'has_permission'
      AND p.prosrc ~ 'has_permission\s*\('
  LOOP
    v_def := pg_get_functiondef(r.oid);

    -- has_permission(x, 'module'  ->  has_permission(x, 'module'::public.module_key
    v_new := regexp_replace(
      v_def,
      '(has_permission\s*\(\s*' || c_arg || ',\s*''[A-Za-z_-]+'')(?!\s*::)',
      '\1::public.module_key',
      'g'
    );

    -- has_permission(x, 'module'::module_key, 'action'  ->  ... 'action'::public.action_key
    v_new := regexp_replace(
      v_new,
      '(has_permission\s*\(\s*' || c_arg || ',\s*''[A-Za-z_-]+''::(?:public\.)?module_key\s*,\s*''[A-Za-z_]+'')(?!\s*::)',
      '\1::public.action_key',
      'g'
    );

    IF v_new IS DISTINCT FROM v_def THEN
      EXECUTE v_new;
      RAISE NOTICE 'has_permission casts fixed in %', r.sig;
    END IF;
  END LOOP;
END
$do$;
