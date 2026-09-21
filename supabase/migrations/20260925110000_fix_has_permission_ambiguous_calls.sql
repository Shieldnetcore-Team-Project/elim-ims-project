-- ============================================================================
-- FIX: "function public.has_permission(uuid, unknown, action_key) is not unique"
-- ----------------------------------------------------------------------------
-- has_permission() has two overloads that differ only in the 3rd argument
-- domain: (uuid, module_key, access_level) [legacy, still bound to ~40 RLS
-- policies] and (uuid, module_key, action_key). When an RPC passes the module
-- as a bare string literal, e.g.
--     public.has_permission(v_uid, 'goods-receiving', 'confirm'::action_key)
-- the literal is of unknown type and Postgres cannot pick an overload, so the
-- call raises "is not unique". Confirming a goods receipt / production batch
-- (and other approval actions) failed for every non-admin user, e.g. the
-- inventory officer.
--
-- Fix: rewrite every public function whose body contains such a call so the
-- module literal is cast ('goods-receiving'::public.module_key). Done
-- generically here so it covers every affected function in the live database
-- regardless of which migration last defined it. Already-cast calls and
-- calls that pass a variable are untouched.
-- ============================================================================
DO $$
DECLARE
  r record;
  v_def text;
  v_new text;
  v_count int := 0;
BEGIN
  FOR r IN
    SELECT p.oid
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public'
       AND p.prokind = 'f'
       AND p.prosrc ~ 'has_permission\(\s*[^,()]+,\s*''[a-z-]+''\s*,\s*''[a-z_]+''::(public\.)?action_key'
  LOOP
    v_def := pg_get_functiondef(r.oid);
    v_new := regexp_replace(
      v_def,
      'has_permission\((\s*[^,()]+,\s*)(''[a-z-]+'')(\s*,\s*''[a-z_]+''::(?:public\.)?action_key)',
      'has_permission(\1\2::public.module_key\3',
      'g'
    );
    IF v_new IS DISTINCT FROM v_def THEN
      EXECUTE v_new;
      v_count := v_count + 1;
    END IF;
  END LOOP;
  RAISE NOTICE 'has_permission ambiguity fix: rewrote % function(s)', v_count;
END $$;
