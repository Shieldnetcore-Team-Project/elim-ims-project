-- Originally authored as database/postgres/migrations/0004_masters.sql — copied here verbatim as the canonical, Supabase-CLI-managed migration history (see supabase/migrations/README.md).
-- =============================================================================
-- 0004_masters.sql
-- Item catalogue, trading partners, fleet, plant assets, config, water intake.
-- =============================================================================

CREATE TABLE items (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code           TEXT NOT NULL UNIQUE,                 -- e.g. 'RM-01', 'FG-03'
  name           TEXT NOT NULL,
  category_id    UUID NOT NULL REFERENCES item_categories(id),
  type           item_type_enum NOT NULL,
  uom_code       TEXT NOT NULL REFERENCES uoms(code),
  reorder_point  NUMERIC(14,3) NOT NULL DEFAULT 0 CHECK (reorder_point >= 0),
  unit_cost      NUMERIC(14,2) NOT NULL DEFAULT 0 CHECK (unit_cost >= 0),
  deleted_at     TIMESTAMPTZ,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE suppliers (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code        TEXT NOT NULL UNIQUE,                    -- e.g. 'SUP-01'
  name        TEXT NOT NULL,
  location_id UUID REFERENCES locations(id),
  phone       TEXT,
  email       CITEXT,
  deleted_at  TIMESTAMPTZ,                              -- set by the deletion-approval workflow, see 0011/0013
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE customers (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code        TEXT NOT NULL UNIQUE,                    -- e.g. 'CUS-01'
  name        TEXT NOT NULL,
  location_id UUID REFERENCES locations(id),
  phone       TEXT,
  email       CITEXT,
  deleted_at  TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE vehicles (
  id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code                     TEXT NOT NULL UNIQUE,        -- e.g. 'FLT-01'
  default_driver_employee_id UUID REFERENCES employees(id),
  odometer_km              NUMERIC(10,1),
  status                   vehicle_status_enum NOT NULL DEFAULT 'ACTIVE',
  deleted_at               TIMESTAMPTZ,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE assets (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code             TEXT NOT NULL UNIQUE,                -- e.g. 'AST-001'
  equipment_name   TEXT NOT NULL,
  location_id      UUID REFERENCES warehouse_locations(id),
  last_service_date DATE,
  next_due_date    DATE,
  status           asset_status_enum NOT NULL DEFAULT 'ACTIVE',
  deleted_at       TIMESTAMPTZ,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT assets_due_after_service CHECK (next_due_date IS NULL OR last_service_date IS NULL OR next_due_date >= last_service_date)
);

-- System configuration as key/value rows. Atomic per row (key -> one value,
-- one description, one owner) — this is already 3NF; a key/value table only
-- violates normalization if a single "value" bundles multiple facts, which
-- none of these do.
CREATE TABLE settings (
  setting_key            TEXT PRIMARY KEY,               -- e.g. 'Company name'
  description             TEXT,
  value                    TEXT,
  updated_by_employee_id   UUID REFERENCES employees(id),
  status                   setting_status_enum NOT NULL DEFAULT 'ACTIVE',
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE water_treatment_runs (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code             TEXT NOT NULL UNIQUE,                 -- e.g. 'TR-0001'
  source_id        UUID REFERENCES water_sources(id),
  stage_id         UUID REFERENCES treatment_stages(id),
  volume_l         NUMERIC(12,2) CHECK (volume_l IS NULL OR volume_l > 0),
  operator_employee_id UUID REFERENCES employees(id),
  status           water_run_status_enum NOT NULL DEFAULT 'PASS',
  tested_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
