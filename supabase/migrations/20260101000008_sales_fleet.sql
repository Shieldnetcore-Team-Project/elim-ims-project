-- Originally authored as database/postgres/migrations/0008_sales_fleet.sql — copied here verbatim as the canonical, Supabase-CLI-managed migration history (see supabase/migrations/README.md).
-- =============================================================================
-- 0008_sales_fleet.sql
-- Sales orders (invoice & POS share one table, distinguished by channel — one
-- inventory-deduction path instead of two divergent ones) and fleet dispatch.
-- =============================================================================

CREATE TABLE sales_orders (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code                 TEXT NOT NULL UNIQUE,          -- e.g. 'SO-2026-0001'
  customer_id          UUID NOT NULL REFERENCES customers(id),
  channel              sales_channel_enum NOT NULL DEFAULT 'INVOICE',
  rep_employee_id      UUID REFERENCES employees(id),
  status               sales_status_enum NOT NULL DEFAULT 'PENDING',
  -- Cached SUM(sales_order_items.line_total), kept in sync by
  -- trg_sales_order_items_recalc_total (0012) on every line insert/update/delete.
  -- A deliberate, trigger-enforced denormalization: read-heavy (dashboard
  -- KPIs, order lists) vs. write-light (a line item rarely changes after
  -- order creation), so caching the sum is worth the trigger's cost. See
  -- docs/NORMALIZATION.md.
  total_amount         NUMERIC(16,2) NOT NULL DEFAULT 0 CHECK (total_amount >= 0),
  deleted_at           TIMESTAMPTZ,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE sales_order_items (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  sales_order_id UUID NOT NULL REFERENCES sales_orders(id) ON DELETE CASCADE,
  item_id        UUID NOT NULL REFERENCES items(id),
  quantity       NUMERIC(14,3) NOT NULL CHECK (quantity > 0),
  unit_price     NUMERIC(14,2) NOT NULL CHECK (unit_price >= 0),
  line_total     NUMERIC(16,2) GENERATED ALWAYS AS (quantity * unit_price) STORED,
  UNIQUE (sales_order_id, item_id)
);

CREATE TABLE delivery_runs (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code                  TEXT NOT NULL UNIQUE,          -- e.g. 'DR-0001'
  sales_order_id        UUID NOT NULL REFERENCES sales_orders(id),
  vehicle_id            UUID NOT NULL REFERENCES vehicles(id),
  driver_employee_id    UUID REFERENCES employees(id),
  route                 TEXT,
  status                delivery_status_enum NOT NULL DEFAULT 'SCHEDULED',
  dispatched_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  delivered_at          TIMESTAMPTZ,
  CONSTRAINT delivery_runs_delivered_after_dispatched CHECK (delivered_at IS NULL OR delivered_at >= dispatched_at)
);
