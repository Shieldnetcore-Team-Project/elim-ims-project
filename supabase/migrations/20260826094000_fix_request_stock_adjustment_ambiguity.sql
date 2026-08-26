-- ============================================================================
-- FIX: request_stock_adjustment() missed by 20260826093000's scan
-- ----------------------------------------------------------------------------
-- 20260826093000 excluded any function whose body contained the substring
-- "module_key" anywhere, on the assumption that meant a declared module_key
-- variable made every has_permission() call in it safe. request_stock_
-- adjustment() breaks that assumption: it DOES declare `v_module public.
-- module_key`, but only uses it later for record_workflow_action() -- the
-- actual has_permission() authorization checks still call two literal,
-- uncast module strings ('raw-materials' / 'finished-goods') directly.
-- Confirmed live: calling it throws the same "not unique" error, which means
-- every stock adjustment submission (the entire section 26/27 flow built
-- earlier this session) has been broken since it was written today.
-- Same live-patch technique as 20260826093000, scoped to this one function.
-- ============================================================================

DO $$
DECLARE
  v_oid oid;
  v_def text;
  v_fixed text;
BEGIN
  SELECT p.oid INTO v_oid FROM pg_proc p
  WHERE p.pronamespace = 'public'::regnamespace AND p.proname = 'request_stock_adjustment';
  v_def := pg_get_functiondef(v_oid);
  v_fixed := regexp_replace(v_def, E'(has_permission\\(v_uid, ''[a-z-]+'')', E'\\1::module_key', 'g');
  IF v_fixed = v_def THEN
    RAISE EXCEPTION 'No ambiguous has_permission call found in request_stock_adjustment -- expected at least one substitution';
  END IF;
  EXECUTE v_fixed;
END $$;
