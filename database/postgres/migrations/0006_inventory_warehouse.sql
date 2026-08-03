-- =============================================================================
-- 0006_inventory_warehouse.sql
-- Append-only stock ledger. The on-hand balance is never stored — it is
-- always SUM(IN) - SUM(OUT), exposed via v_inventory_status (0013). This is
-- the same append-only-ledger pattern as ledger_entries (0010): the balance
-- is a derived fact, so there is nothing to keep in sync and nothing that
-- can drift.
-- =============================================================================

CREATE TABLE inventory_transactions (
  id                   BIGSERIAL PRIMARY KEY,
  item_id              UUID NOT NULL REFERENCES items(id),
  direction            inventory_direction_enum NOT NULL,
  quantity             NUMERIC(14,3) NOT NULL CHECK (quantity > 0),
  unit_cost            NUMERIC(14,2) NOT NULL DEFAULT 0 CHECK (unit_cost >= 0),
  source_type          inventory_source_enum NOT NULL,
  -- Polymorphic: points at purchase_orders / production_batches / sales_orders
  -- / material_requests depending on source_type, or NULL for ADJUSTMENT.
  -- Enforced by trg_inventory_validate_source (0012).
  source_id            UUID,
  note                 TEXT,
  actor_employee_id    UUID REFERENCES employees(id),
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE warehouse_requisitions (
  id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code                     TEXT NOT NULL UNIQUE,        -- e.g. 'WR-0001'
  item_id                  UUID NOT NULL REFERENCES items(id),
  quantity                 NUMERIC(14,3) NOT NULL DEFAULT 0 CHECK (quantity >= 0),
  expected_delivery        DATE,
  priority                 priority_enum NOT NULL DEFAULT 'MEDIUM',
  reason                   TEXT,
  department_id            UUID REFERENCES departments(id),
  requested_by_employee_id UUID REFERENCES employees(id),
  status                   requisition_status_enum NOT NULL DEFAULT 'PENDING',
  deleted_at               TIMESTAMPTZ,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT now()
);
