-- Fix __temp_get_source() so it also works called via the service-role key
-- (auth.uid() is NULL there, not a super_admin's uid) -- see
-- 20260923180000_temp_get_source_helper.sql.
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
