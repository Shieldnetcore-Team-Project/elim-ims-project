-- ============================================================================
-- Data correction: take the retired H-Medix duplicate off the system
-- ----------------------------------------------------------------------------
-- "H MEDIX (duplicate of H-Medix - do not use)" was retired by
-- 20261017170000_h_medix_correction.sql. It still shows on the Customers
-- page. Its account history (the duplicate cheque, rejected, and the entry
-- that took its credit back) is append-only, so it can't be deleted; it is
-- marked removed, as remove_customer does, which hides it from every
-- customer list and picker (Customers → "Show removed" still finds it).
-- Only acts while it owes nothing and holds no advance; safe to re-run.
-- ============================================================================
DO $$
DECLARE v_c customers%ROWTYPE;
BEGIN
  SELECT * INTO v_c FROM customers
   WHERE name = 'H MEDIX (duplicate of H-Medix - do not use)' AND removed_at IS NULL
     AND COALESCE(outstanding_balance, 0) = 0 AND COALESCE(credit_balance, 0) = 0
     AND NOT EXISTS (SELECT 1 FROM sales s WHERE s.customer_id = customers.id AND s.deleted_at IS NULL);
  IF NOT FOUND THEN RETURN; END IF;

  UPDATE customers
     SET removed_at = now(), removed_reason = 'Duplicate of H-Medix (data correction)',
         registered = false, updated_at = now()
   WHERE id = v_c.id;
  INSERT INTO audit_logs(user_id, factory_id, action, entity, entity_id, old_value, new_value)
  VALUES (NULL, v_c.factory_id, 'data_correction', 'customers', v_c.id::text,
          jsonb_build_object('name', v_c.name, 'removed_at', NULL),
          jsonb_build_object('removed', true, 'reason', 'Duplicate of H-Medix'));
END;
$$;
