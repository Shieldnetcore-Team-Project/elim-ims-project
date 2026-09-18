-- ============================================================================
-- TEMPORARY: a super_admin-only helper to read back a function's exact live
-- source via pg_get_functiondef(), so the upcoming chairman-parity patch can
-- be built by editing the real current text instead of retyping ~40
-- multi-branch PL/pgSQL functions by hand (no local Docker/pg_dump available
-- in this environment). Dropped by a follow-up migration once used.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.__temp_get_source(p_signature text)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
BEGIN
  IF v_uid IS NOT NULL AND NOT public.has_role(v_uid, 'super_admin') THEN
    RAISE EXCEPTION 'Insufficient permissions';
  END IF;
  RETURN pg_get_functiondef(p_signature::regprocedure);
END;
$$;
GRANT EXECUTE ON FUNCTION public.__temp_get_source(text) TO authenticated;
