-- Originally authored as database/postgres/migrations/0012_triggers.sql — copied here verbatim as the canonical, Supabase-CLI-managed migration history (see supabase/migrations/README.md).
-- =============================================================================
-- 0012_triggers.sql
-- Trigger functions + the CREATE TRIGGER wiring. Grouped by concern:
--   A. updated_at bookkeeping
--   B. polymorphic reference integrity (the FK Postgres can't express directly)
--   C. append-only ledger enforcement
--   D. derived/cached column maintenance
--   E. the deletion-approval workflow
-- =============================================================================

-- ============================== A. updated_at ===============================
CREATE TRIGGER trg_employees_updated_at            BEFORE UPDATE ON employees            FOR EACH ROW EXECUTE FUNCTION fn_set_updated_at();
CREATE TRIGGER trg_app_roles_updated_at             BEFORE UPDATE ON app_roles             FOR EACH ROW EXECUTE FUNCTION fn_set_updated_at();
CREATE TRIGGER trg_users_updated_at                 BEFORE UPDATE ON users                 FOR EACH ROW EXECUTE FUNCTION fn_set_updated_at();
CREATE TRIGGER trg_items_updated_at                 BEFORE UPDATE ON items                 FOR EACH ROW EXECUTE FUNCTION fn_set_updated_at();
CREATE TRIGGER trg_suppliers_updated_at             BEFORE UPDATE ON suppliers             FOR EACH ROW EXECUTE FUNCTION fn_set_updated_at();
CREATE TRIGGER trg_customers_updated_at             BEFORE UPDATE ON customers             FOR EACH ROW EXECUTE FUNCTION fn_set_updated_at();
CREATE TRIGGER trg_vehicles_updated_at              BEFORE UPDATE ON vehicles              FOR EACH ROW EXECUTE FUNCTION fn_set_updated_at();
CREATE TRIGGER trg_assets_updated_at                BEFORE UPDATE ON assets                FOR EACH ROW EXECUTE FUNCTION fn_set_updated_at();
CREATE TRIGGER trg_purchase_orders_updated_at       BEFORE UPDATE ON purchase_orders       FOR EACH ROW EXECUTE FUNCTION fn_set_updated_at();
CREATE TRIGGER trg_warehouse_requisitions_updated_at BEFORE UPDATE ON warehouse_requisitions FOR EACH ROW EXECUTE FUNCTION fn_set_updated_at();
CREATE TRIGGER trg_material_requests_updated_at     BEFORE UPDATE ON material_requests     FOR EACH ROW EXECUTE FUNCTION fn_set_updated_at();
CREATE TRIGGER trg_sales_orders_updated_at          BEFORE UPDATE ON sales_orders          FOR EACH ROW EXECUTE FUNCTION fn_set_updated_at();

-- Settings uses the same key column across its whole update, but semantically
-- "updated_at" means the same thing here as everywhere else.
CREATE OR REPLACE FUNCTION fn_settings_set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER trg_settings_updated_at BEFORE UPDATE ON settings FOR EACH ROW EXECUTE FUNCTION fn_settings_set_updated_at();

-- ================= B. polymorphic reference integrity =======================

CREATE OR REPLACE FUNCTION fn_quality_control_validate_ref()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.ref_type = 'GOODS_RECEIVED' AND NOT EXISTS (SELECT 1 FROM goods_received WHERE id = NEW.ref_id) THEN
    RAISE EXCEPTION 'quality_control.ref_id % is not a valid goods_received.id', NEW.ref_id;
  ELSIF NEW.ref_type = 'PRODUCTION_BATCH' AND NOT EXISTS (SELECT 1 FROM production_batches WHERE id = NEW.ref_id) THEN
    RAISE EXCEPTION 'quality_control.ref_id % is not a valid production_batches.id', NEW.ref_id;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_quality_control_validate_ref
BEFORE INSERT OR UPDATE OF ref_type, ref_id ON quality_control
FOR EACH ROW EXECUTE FUNCTION fn_quality_control_validate_ref();

CREATE OR REPLACE FUNCTION fn_inventory_validate_source()
RETURNS TRIGGER AS $$
BEGIN
  CASE NEW.source_type
    WHEN 'PURCHASE' THEN
      IF NEW.source_id IS NULL OR NOT EXISTS (SELECT 1 FROM purchase_orders WHERE id = NEW.source_id) THEN
        RAISE EXCEPTION 'inventory_transactions.source_id % is not a valid purchase_orders.id for PURCHASE', NEW.source_id;
      END IF;
    WHEN 'PRODUCTION' THEN
      IF NEW.source_id IS NULL OR NOT EXISTS (SELECT 1 FROM production_batches WHERE id = NEW.source_id) THEN
        RAISE EXCEPTION 'inventory_transactions.source_id % is not a valid production_batches.id for PRODUCTION', NEW.source_id;
      END IF;
    WHEN 'SALES' THEN
      IF NEW.source_id IS NULL OR NOT EXISTS (SELECT 1 FROM sales_orders WHERE id = NEW.source_id) THEN
        RAISE EXCEPTION 'inventory_transactions.source_id % is not a valid sales_orders.id for SALES', NEW.source_id;
      END IF;
    WHEN 'MATERIAL_ISSUE' THEN
      IF NEW.source_id IS NULL OR NOT EXISTS (SELECT 1 FROM material_requests WHERE id = NEW.source_id) THEN
        RAISE EXCEPTION 'inventory_transactions.source_id % is not a valid material_requests.id for MATERIAL_ISSUE', NEW.source_id;
      END IF;
    WHEN 'ADJUSTMENT' THEN
      NULL; -- a manual stock count adjustment has no backing document
  END CASE;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_inventory_validate_source
BEFORE INSERT ON inventory_transactions
FOR EACH ROW EXECUTE FUNCTION fn_inventory_validate_source();

CREATE OR REPLACE FUNCTION fn_finance_validate_reference()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.reference_type IS NULL OR NEW.reference_id IS NULL THEN
    RETURN NEW;
  END IF;
  CASE NEW.reference_type
    WHEN 'PURCHASE_ORDER' THEN
      IF NOT EXISTS (SELECT 1 FROM purchase_orders WHERE id = NEW.reference_id) THEN
        RAISE EXCEPTION '%.reference_id % is not a valid purchase_orders.id', TG_TABLE_NAME, NEW.reference_id;
      END IF;
    WHEN 'SALES_ORDER' THEN
      IF NOT EXISTS (SELECT 1 FROM sales_orders WHERE id = NEW.reference_id) THEN
        RAISE EXCEPTION '%.reference_id % is not a valid sales_orders.id', TG_TABLE_NAME, NEW.reference_id;
      END IF;
    WHEN 'PAYROLL_RUN' THEN
      IF NOT EXISTS (SELECT 1 FROM payroll_runs WHERE id = NEW.reference_id) THEN
        RAISE EXCEPTION '%.reference_id % is not a valid payroll_runs.id', TG_TABLE_NAME, NEW.reference_id;
      END IF;
    WHEN 'GOODS_RECEIVED' THEN
      IF NOT EXISTS (SELECT 1 FROM goods_received WHERE id = NEW.reference_id) THEN
        RAISE EXCEPTION '%.reference_id % is not a valid goods_received.id', TG_TABLE_NAME, NEW.reference_id;
      END IF;
    WHEN 'EXPENSE', 'OTHER' THEN
      NULL; -- no backing document expected
  END CASE;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_ledger_entries_validate_ref BEFORE INSERT OR UPDATE OF reference_type, reference_id ON ledger_entries FOR EACH ROW EXECUTE FUNCTION fn_finance_validate_reference();
CREATE TRIGGER trg_payments_validate_ref       BEFORE INSERT OR UPDATE OF reference_type, reference_id ON payments       FOR EACH ROW EXECUTE FUNCTION fn_finance_validate_reference();
CREATE TRIGGER trg_receipts_validate_ref       BEFORE INSERT OR UPDATE OF reference_type, reference_id ON receipts       FOR EACH ROW EXECUTE FUNCTION fn_finance_validate_reference();

CREATE OR REPLACE FUNCTION fn_finance_validate_counterparty()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.counterparty_id IS NULL THEN
    RETURN NEW;
  END IF;
  CASE NEW.counterparty_type
    WHEN 'SUPPLIER' THEN
      IF NOT EXISTS (SELECT 1 FROM suppliers WHERE id = NEW.counterparty_id) THEN
        RAISE EXCEPTION '%.counterparty_id % is not a valid suppliers.id', TG_TABLE_NAME, NEW.counterparty_id;
      END IF;
    WHEN 'CUSTOMER' THEN
      IF NOT EXISTS (SELECT 1 FROM customers WHERE id = NEW.counterparty_id) THEN
        RAISE EXCEPTION '%.counterparty_id % is not a valid customers.id', TG_TABLE_NAME, NEW.counterparty_id;
      END IF;
    WHEN 'EMPLOYEE' THEN
      IF NOT EXISTS (SELECT 1 FROM employees WHERE id = NEW.counterparty_id) THEN
        RAISE EXCEPTION '%.counterparty_id % is not a valid employees.id', TG_TABLE_NAME, NEW.counterparty_id;
      END IF;
    WHEN 'OTHER' THEN
      NULL;
  END CASE;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_payments_validate_counterparty BEFORE INSERT OR UPDATE OF counterparty_type, counterparty_id ON payments FOR EACH ROW EXECUTE FUNCTION fn_finance_validate_counterparty();
CREATE TRIGGER trg_receipts_validate_counterparty BEFORE INSERT OR UPDATE OF counterparty_type, counterparty_id ON receipts FOR EACH ROW EXECUTE FUNCTION fn_finance_validate_counterparty();

-- ===================== C. append-only ledger enforcement =====================

CREATE OR REPLACE FUNCTION fn_forbid_update_delete()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION '% is append-only — % is not permitted; insert a correcting row instead', TG_TABLE_NAME, TG_OP;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_inventory_transactions_append_only BEFORE UPDATE OR DELETE ON inventory_transactions FOR EACH ROW EXECUTE FUNCTION fn_forbid_update_delete();
CREATE TRIGGER trg_ledger_entries_append_only          BEFORE UPDATE OR DELETE ON ledger_entries          FOR EACH ROW EXECUTE FUNCTION fn_forbid_update_delete();
CREATE TRIGGER trg_activity_log_append_only            BEFORE UPDATE OR DELETE ON activity_log            FOR EACH ROW EXECUTE FUNCTION fn_forbid_update_delete();

-- Stock must never go negative. Runs BEFORE INSERT, so fn_item_balance()
-- here reads the ledger as it stood *before* this row — exactly the balance
-- this OUT movement would be drawn against.
CREATE OR REPLACE FUNCTION fn_inventory_prevent_negative()
RETURNS TRIGGER AS $$
DECLARE
  v_balance NUMERIC;
BEGIN
  IF NEW.direction = 'OUT' THEN
    v_balance := fn_item_balance(NEW.item_id);
    IF v_balance < NEW.quantity THEN
      RAISE EXCEPTION 'insufficient stock for item %: on hand %, requested %', NEW.item_id, v_balance, NEW.quantity;
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_inventory_prevent_negative BEFORE INSERT ON inventory_transactions FOR EACH ROW EXECUTE FUNCTION fn_inventory_prevent_negative();

-- ================ D. derived/cached column maintenance =======================

CREATE OR REPLACE FUNCTION fn_sales_orders_recalc_total()
RETURNS TRIGGER AS $$
DECLARE
  v_order_id UUID := COALESCE(NEW.sales_order_id, OLD.sales_order_id);
BEGIN
  UPDATE sales_orders
  SET total_amount = COALESCE((SELECT SUM(line_total) FROM sales_order_items WHERE sales_order_id = v_order_id), 0)
  WHERE id = v_order_id;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_sales_order_items_recalc_total
AFTER INSERT OR UPDATE OF quantity, unit_price OR DELETE ON sales_order_items
FOR EACH ROW EXECUTE FUNCTION fn_sales_orders_recalc_total();

-- ===================== E. deletion-approval workflow ==========================

-- Auto-stamp reviewed_at the moment a PENDING request is actioned, if the
-- caller didn't set it explicitly.
CREATE OR REPLACE FUNCTION fn_deletion_requests_stamp_review()
RETURNS TRIGGER AS $$
BEGIN
  IF OLD.status = 'PENDING' AND NEW.status <> 'PENDING' AND NEW.reviewed_at IS NULL THEN
    NEW.reviewed_at := now();
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_deletion_requests_stamp_review BEFORE UPDATE OF status ON deletion_requests FOR EACH ROW EXECUTE FUNCTION fn_deletion_requests_stamp_review();

-- Applies the soft-delete once a request is APPROVED, looking up the target
-- table/column generically via deletable_entities (0002) instead of a
-- hardcoded CASE per table. deletable_entities is DBA-managed reference
-- data (never app-writable), so the identifiers it supplies to format(%I)
-- are trusted, not user input.
CREATE OR REPLACE FUNCTION fn_deletion_requests_apply()
RETURNS TRIGGER AS $$
DECLARE
  v_table   TEXT;
  v_id_col  TEXT;
BEGIN
  IF NEW.status = 'APPROVED' AND OLD.status IS DISTINCT FROM 'APPROVED' THEN
    SELECT table_name, id_column INTO v_table, v_id_col
    FROM deletable_entities WHERE entity_type = NEW.entity_type;

    IF v_table IS NULL THEN
      RAISE EXCEPTION 'no deletable_entities mapping for entity_type %', NEW.entity_type;
    END IF;

    EXECUTE format('UPDATE %I SET deleted_at = now() WHERE %I = $1 AND deleted_at IS NULL', v_table, v_id_col)
    USING NEW.entity_id;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_deletion_requests_apply AFTER UPDATE OF status ON deletion_requests FOR EACH ROW EXECUTE FUNCTION fn_deletion_requests_apply();
