-- =============================================================================
-- 20260803120100_actor_columns.sql
-- Generic created_by/updated_by, added only where no equivalent semantic
-- actor column already exists (see supabase/migrations/README.md and the
-- plan this migration set implements). Every table below already has
-- created_at/updated_at (or, for the "created_by only" group, at least one
-- timestamp) from the copied 0001-0016 migrations.
-- =============================================================================

-- ---- Both columns: has timestamps, zero actor column today -----------------
ALTER TABLE employees ADD COLUMN IF NOT EXISTS created_by UUID REFERENCES users(id);
ALTER TABLE employees ADD COLUMN IF NOT EXISTS updated_by UUID REFERENCES users(id);

ALTER TABLE app_roles ADD COLUMN IF NOT EXISTS created_by UUID REFERENCES users(id);
ALTER TABLE app_roles ADD COLUMN IF NOT EXISTS updated_by UUID REFERENCES users(id);

ALTER TABLE users ADD COLUMN IF NOT EXISTS created_by UUID REFERENCES users(id);
ALTER TABLE users ADD COLUMN IF NOT EXISTS updated_by UUID REFERENCES users(id);

ALTER TABLE items ADD COLUMN IF NOT EXISTS created_by UUID REFERENCES users(id);
ALTER TABLE items ADD COLUMN IF NOT EXISTS updated_by UUID REFERENCES users(id);

ALTER TABLE suppliers ADD COLUMN IF NOT EXISTS created_by UUID REFERENCES users(id);
ALTER TABLE suppliers ADD COLUMN IF NOT EXISTS updated_by UUID REFERENCES users(id);

ALTER TABLE customers ADD COLUMN IF NOT EXISTS created_by UUID REFERENCES users(id);
ALTER TABLE customers ADD COLUMN IF NOT EXISTS updated_by UUID REFERENCES users(id);

ALTER TABLE vehicles ADD COLUMN IF NOT EXISTS created_by UUID REFERENCES users(id);
ALTER TABLE vehicles ADD COLUMN IF NOT EXISTS updated_by UUID REFERENCES users(id);

ALTER TABLE assets ADD COLUMN IF NOT EXISTS created_by UUID REFERENCES users(id);
ALTER TABLE assets ADD COLUMN IF NOT EXISTS updated_by UUID REFERENCES users(id);

-- ---- updated_by only: already has a create-actor, no update-actor ----------
ALTER TABLE purchase_orders ADD COLUMN IF NOT EXISTS updated_by UUID REFERENCES users(id);
ALTER TABLE warehouse_requisitions ADD COLUMN IF NOT EXISTS updated_by UUID REFERENCES users(id);
ALTER TABLE material_requests ADD COLUMN IF NOT EXISTS updated_by UUID REFERENCES users(id);
ALTER TABLE sales_orders ADD COLUMN IF NOT EXISTS updated_by UUID REFERENCES users(id);

-- ---- created_by only: genuinely zero actor tracking today (a real gap) -----
ALTER TABLE ledger_entries ADD COLUMN IF NOT EXISTS created_by UUID REFERENCES users(id);
ALTER TABLE payments ADD COLUMN IF NOT EXISTS created_by UUID REFERENCES users(id);
ALTER TABLE receipts ADD COLUMN IF NOT EXISTS created_by UUID REFERENCES users(id);
ALTER TABLE payroll_runs ADD COLUMN IF NOT EXISTS created_by UUID REFERENCES users(id);

-- One shared trigger function; wired per-table below via explicit CREATE
-- TRIGGER statements — matches 20260101000012_triggers.sql's own convention
-- of individually-named updated_at triggers rather than a generated loop.
-- mode is TG_ARGV[0], fixed per CREATE TRIGGER call below, not per-row —
-- it exists so this one function is safe to point at tables that don't all
-- share the same two columns: a 'created_only' table (ledger_entries,
-- payments, receipts, payroll_runs) has no updated_by column at all, so
-- unconditionally touching NEW.updated_by there would fail at runtime with
-- "record has no field updated_by".
CREATE OR REPLACE FUNCTION fn_stamp_actor()
RETURNS TRIGGER
LANGUAGE plpgsql AS $$
DECLARE
  v_mode TEXT := TG_ARGV[0];
BEGIN
  IF v_mode = 'both' THEN
    IF TG_OP = 'INSERT' THEN
      NEW.created_by := current_app_user_id();
    END IF;
    NEW.updated_by := current_app_user_id();
  ELSIF v_mode = 'updated_only' THEN
    NEW.updated_by := current_app_user_id();
  ELSIF v_mode = 'created_only' THEN
    NEW.created_by := current_app_user_id();
  END IF;
  RETURN NEW;
END;
$$;

-- "Both" group: stamp on INSERT (both columns) and UPDATE (updated_by).
CREATE TRIGGER trg_employees_stamp_actor BEFORE INSERT OR UPDATE ON employees FOR EACH ROW EXECUTE FUNCTION fn_stamp_actor('both');
CREATE TRIGGER trg_app_roles_stamp_actor BEFORE INSERT OR UPDATE ON app_roles FOR EACH ROW EXECUTE FUNCTION fn_stamp_actor('both');
CREATE TRIGGER trg_users_stamp_actor BEFORE INSERT OR UPDATE ON users FOR EACH ROW EXECUTE FUNCTION fn_stamp_actor('both');
CREATE TRIGGER trg_items_stamp_actor BEFORE INSERT OR UPDATE ON items FOR EACH ROW EXECUTE FUNCTION fn_stamp_actor('both');
CREATE TRIGGER trg_suppliers_stamp_actor BEFORE INSERT OR UPDATE ON suppliers FOR EACH ROW EXECUTE FUNCTION fn_stamp_actor('both');
CREATE TRIGGER trg_customers_stamp_actor BEFORE INSERT OR UPDATE ON customers FOR EACH ROW EXECUTE FUNCTION fn_stamp_actor('both');
CREATE TRIGGER trg_vehicles_stamp_actor BEFORE INSERT OR UPDATE ON vehicles FOR EACH ROW EXECUTE FUNCTION fn_stamp_actor('both');
CREATE TRIGGER trg_assets_stamp_actor BEFORE INSERT OR UPDATE ON assets FOR EACH ROW EXECUTE FUNCTION fn_stamp_actor('both');

-- "updated_by only" group: UPDATE only — the existing semantic *_employee_id
-- column already records who created the row.
CREATE TRIGGER trg_purchase_orders_stamp_actor BEFORE UPDATE ON purchase_orders FOR EACH ROW EXECUTE FUNCTION fn_stamp_actor('updated_only');
CREATE TRIGGER trg_warehouse_requisitions_stamp_actor BEFORE UPDATE ON warehouse_requisitions FOR EACH ROW EXECUTE FUNCTION fn_stamp_actor('updated_only');
CREATE TRIGGER trg_material_requests_stamp_actor BEFORE UPDATE ON material_requests FOR EACH ROW EXECUTE FUNCTION fn_stamp_actor('updated_only');
CREATE TRIGGER trg_sales_orders_stamp_actor BEFORE UPDATE ON sales_orders FOR EACH ROW EXECUTE FUNCTION fn_stamp_actor('updated_only');

-- "created_by only" group: INSERT only — these are append-only or single-
-- event tables with no update path and no updated_at column to pair with.
CREATE TRIGGER trg_ledger_entries_stamp_actor BEFORE INSERT ON ledger_entries FOR EACH ROW EXECUTE FUNCTION fn_stamp_actor('created_only');
CREATE TRIGGER trg_payments_stamp_actor BEFORE INSERT ON payments FOR EACH ROW EXECUTE FUNCTION fn_stamp_actor('created_only');
CREATE TRIGGER trg_receipts_stamp_actor BEFORE INSERT ON receipts FOR EACH ROW EXECUTE FUNCTION fn_stamp_actor('created_only');
CREATE TRIGGER trg_payroll_runs_stamp_actor BEFORE INSERT ON payroll_runs FOR EACH ROW EXECUTE FUNCTION fn_stamp_actor('created_only');
