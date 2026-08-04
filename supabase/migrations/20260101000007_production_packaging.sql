-- Originally authored as database/postgres/migrations/0007_production_packaging.sql — copied here verbatim as the canonical, Supabase-CLI-managed migration history (see supabase/migrations/README.md).
-- =============================================================================
-- 0007_production_packaging.sql
-- Material requests (issue raw materials to the floor) -> production batches
-- -> packaging into finished-goods inventory.
-- =============================================================================

CREATE TABLE material_requests (
  id                        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code                      TEXT NOT NULL UNIQUE,      -- e.g. 'MR-0001'
  requested_by_employee_id  UUID REFERENCES employees(id),
  department_id             UUID REFERENCES departments(id),
  status                    material_request_status_enum NOT NULL DEFAULT 'PENDING',
  needed_by                 DATE,
  deleted_at                TIMESTAMPTZ,
  created_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE material_request_items (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id  UUID NOT NULL REFERENCES material_requests(id) ON DELETE CASCADE,
  item_id     UUID NOT NULL REFERENCES items(id),
  quantity    NUMERIC(14,3) NOT NULL CHECK (quantity > 0),
  UNIQUE (request_id, item_id)
);

CREATE TABLE stock_movements (
  id                     BIGSERIAL PRIMARY KEY,
  request_id             UUID REFERENCES material_requests(id),
  item_id                UUID NOT NULL REFERENCES items(id),
  quantity               NUMERIC(14,3) NOT NULL CHECK (quantity > 0),
  from_location_id       UUID REFERENCES warehouse_locations(id),
  to_location_id         UUID REFERENCES warehouse_locations(id),
  moved_by_employee_id   UUID REFERENCES employees(id),
  moved_at               TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE production_batches (
  id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code                    TEXT NOT NULL UNIQUE,        -- e.g. 'PB-0001'
  product_item_id         UUID NOT NULL REFERENCES items(id),
  line_id                 UUID REFERENCES production_lines(id),
  shift_id                UUID REFERENCES shifts(id),
  operator_employee_id    UUID REFERENCES employees(id),
  units_target            NUMERIC(14,2) CHECK (units_target IS NULL OR units_target >= 0),
  units_actual            NUMERIC(14,2) CHECK (units_actual IS NULL OR units_actual >= 0),
  status                  batch_status_enum NOT NULL DEFAULT 'IN_PROGRESS',
  water_treatment_run_id  UUID REFERENCES water_treatment_runs(id),
  started_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at            TIMESTAMPTZ,
  CONSTRAINT production_batches_completed_after_started CHECK (completed_at IS NULL OR completed_at >= started_at)
);

CREATE TABLE finished_goods (
  id                      BIGSERIAL PRIMARY KEY,
  batch_id                UUID NOT NULL REFERENCES production_batches(id),
  item_id                 UUID NOT NULL REFERENCES items(id),
  quantity                NUMERIC(14,3) NOT NULL CHECK (quantity > 0),
  packaged_by_employee_id UUID REFERENCES employees(id),
  packaged_at             TIMESTAMPTZ NOT NULL DEFAULT now()
);
