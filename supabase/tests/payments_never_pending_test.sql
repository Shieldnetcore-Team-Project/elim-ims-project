-- ============================================================================
-- Acceptance tests: payments never wait for confirmation
-- (20261018100000_payments_recorded_final.sql)
--
-- Runs against a database with every migration applied -- see
-- supabase/tests/pglite/README.md. User (2026-10-29): "remove confirmation
-- from payment, let it go straight, nobody is confirming anything".
-- ============================================================================

CREATE OR REPLACE FUNCTION pg_temp.check(p_ok boolean, p_msg text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN IF p_ok IS NOT TRUE THEN RAISE EXCEPTION 'ASSERTION FAILED: %', p_msg; END IF; END;
$$;

-- @@ Test 1: a payment saved as pending confirmation is stored confirmed and approved
DO $$
DECLARE r record;
BEGIN
  INSERT INTO payments_received(factory_id, receipt_number, payment_date, amount, payment_method, status, review_status)
  SELECT id, 'PNP-1', CURRENT_DATE, 100, 'cash', 'pending_confirmation', 'pending' FROM factories WHERE code = 'water'
  RETURNING * INTO r;
  PERFORM pg_temp.check(r.status = 'confirmed' AND r.review_status = 'approved', 'saved: ' || r.status || '/' || r.review_status);
  INSERT INTO payments_received(factory_id, receipt_number, payment_date, amount, payment_method)
  SELECT id, 'PNP-2', CURRENT_DATE, 100, 'cash' FROM factories WHERE code = 'water'
  RETURNING * INTO r;
  PERFORM pg_temp.check(r.status = 'confirmed' AND r.review_status = 'approved', 'default: ' || r.status || '/' || r.review_status);
END $$;
