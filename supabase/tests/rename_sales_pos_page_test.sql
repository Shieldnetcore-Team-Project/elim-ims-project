-- ============================================================================
-- Acceptance tests: Retail › Sales & POS renamed Retail › POS
-- (20261029280000_rename_sales_pos_page.sql)
-- Runs against a database with every migration applied -- see
-- supabase/tests/pglite/README.md.
-- ============================================================================

INSERT INTO auth.users(id, email) VALUES ('ad100000-0000-0000-0000-000000000001', 'blocked@pos');
INSERT INTO user_page_access(user_id, page_id, granted)
VALUES ('ad100000-0000-0000-0000-000000000001', 'Retail › Sales & POS', false);

CREATE OR REPLACE FUNCTION pg_temp.check(p_ok boolean, p_msg text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN IF p_ok IS NOT TRUE THEN RAISE EXCEPTION 'ASSERTION FAILED: %', p_msg; END IF; END;
$$;

-- @@ Test 1: a block on the old name moves to the new name
DO $$
BEGIN
  DELETE FROM public.user_page_access o
   WHERE o.page_id = 'Retail › Sales & POS'
     AND EXISTS (SELECT 1 FROM public.user_page_access n WHERE n.user_id = o.user_id AND n.page_id = 'Retail › POS');
  UPDATE public.user_page_access SET page_id = 'Retail › POS' WHERE page_id = 'Retail › Sales & POS';
  PERFORM pg_temp.check(EXISTS (SELECT 1 FROM user_page_access WHERE user_id = 'ad100000-0000-0000-0000-000000000001'
                                   AND page_id = 'Retail › POS' AND NOT granted), 'still blocked under POS');
  PERFORM pg_temp.check(NOT EXISTS (SELECT 1 FROM user_page_access WHERE page_id = 'Retail › Sales & POS'), 'old name gone');
END $$;
