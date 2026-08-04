-- Originally authored as database/postgres/migrations/0005_procurement_receiving_qc.sql — copied here verbatim as the canonical, Supabase-CLI-managed migration history (see supabase/migrations/README.md).
-- =============================================================================
-- 0005_procurement_receiving_qc.sql
-- Purchase orders -> goods received -> quality control.
-- =============================================================================

CREATE TABLE purchase_orders (
  id                        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code                      TEXT NOT NULL UNIQUE,        -- e.g. 'PO-2026-0001'
  supplier_id               UUID NOT NULL REFERENCES suppliers(id),
  requested_by_employee_id  UUID REFERENCES employees(id),
  status                    po_status_enum NOT NULL DEFAULT 'DRAFT',
  deleted_at                TIMESTAMPTZ,
  created_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Header total is intentionally NOT stored on purchase_orders — it's a pure
-- SUM() over these lines, always computed live via v_purchase_order_totals
-- (0013). There is no write path where the lines change without the total
-- being recomputable, so caching it would only add a place for it to go stale.
CREATE TABLE purchase_order_items (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  po_id         UUID NOT NULL REFERENCES purchase_orders(id) ON DELETE CASCADE,
  item_id       UUID NOT NULL REFERENCES items(id),
  quantity      NUMERIC(14,3) NOT NULL CHECK (quantity > 0),
  unit_price    NUMERIC(14,2) NOT NULL DEFAULT 0 CHECK (unit_price >= 0),
  UNIQUE (po_id, item_id)
);

CREATE TABLE goods_received (
  id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code                     TEXT NOT NULL UNIQUE,        -- e.g. 'GRN-0001'
  po_id                    UUID NOT NULL REFERENCES purchase_orders(id),
  received_by_employee_id  UUID REFERENCES employees(id),
  status                   grn_status_enum NOT NULL DEFAULT 'PENDING_QC',
  received_at              TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE goods_received_items (
  id        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  grn_id    UUID NOT NULL REFERENCES goods_received(id) ON DELETE CASCADE,
  item_id   UUID NOT NULL REFERENCES items(id),
  quantity  NUMERIC(14,3) NOT NULL CHECK (quantity > 0),
  UNIQUE (grn_id, item_id)
);

-- ref_type/ref_id is a polymorphic pointer at either goods_received or
-- production_batches. PostgreSQL has no native conditional FK, so integrity
-- here is enforced by trg_quality_control_validate_ref (0012) instead of a
-- REFERENCES clause — documented, trigger-checked, not merely hoped for.
CREATE TABLE quality_control (
  id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code                   TEXT NOT NULL UNIQUE,          -- e.g. 'QC-0001'
  ref_type               qc_ref_type_enum NOT NULL,
  ref_id                 UUID NOT NULL,
  inspector_employee_id  UUID REFERENCES employees(id),
  parameter              TEXT,
  result                 TEXT,
  verdict                qc_verdict_enum NOT NULL,
  notes                  TEXT,
  tested_at              TIMESTAMPTZ NOT NULL DEFAULT now()
);
