-- =============================================================================
-- 0002_lookup_tables.sql
-- Open-ended reference data. Every one of these exists to remove a repeating
-- free-text value (a department name, a location, a job title, ...) from
-- multiple tables, so that column is FK'd here instead of copy-pasted as text
-- — the classic 2NF/3NF fix for values that recur across many rows and must
-- stay consistent (rename a department once, not in 40 employee rows).
-- =============================================================================

CREATE TABLE departments (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name       TEXT NOT NULL UNIQUE
);

-- Free-form places outside the plant: where a customer/supplier is based,
-- where a delivery route ends. Deliberately separate from warehouse_locations
-- below — an external town and an internal stock bay are different concepts
-- and conflating them was a normalization smell in the original design.
CREATE TABLE locations (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name       TEXT NOT NULL UNIQUE
);

-- Internal stock locations (raw material store, line floor, FG warehouse, ...).
CREATE TABLE warehouse_locations (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name       TEXT NOT NULL UNIQUE
);

CREATE TABLE item_categories (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name       TEXT NOT NULL UNIQUE
);

-- Natural-key lookup (the unit code itself, e.g. 'unit', 'case', 'L') —
-- there is no surrogate reason to wrap this in a UUID.
CREATE TABLE uoms (
  code       TEXT PRIMARY KEY,
  name       TEXT NOT NULL
);

-- An employee's job title — distinct from app_roles (0004), which is the
-- RBAC permission role a *user account* holds. A plant operator's job title
-- doesn't change when their system permissions do, and vice versa.
CREATE TABLE job_titles (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title      TEXT NOT NULL UNIQUE
);

CREATE TABLE production_lines (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name       TEXT NOT NULL UNIQUE
);

CREATE TABLE shifts (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name       TEXT NOT NULL UNIQUE
);

CREATE TABLE water_sources (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code        TEXT NOT NULL UNIQUE,     -- e.g. 'BOREHOLE-01'
  description TEXT
);

CREATE TABLE treatment_stages (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name       TEXT NOT NULL UNIQUE       -- 'RO stage', 'UV stage', 'Ozone stage', 'Full cycle'
);

-- Chart of accounts for the double-entry ledger — replaces free-text
-- ledger.account so the same account always refers to the same row.
CREATE TABLE chart_of_accounts (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code         TEXT NOT NULL UNIQUE,     -- e.g. '1000', '4000'
  name         TEXT NOT NULL,
  account_type TEXT NOT NULL CHECK (account_type IN ('ASSET','LIABILITY','EQUITY','REVENUE','EXPENSE'))
);

-- Every page/screen the app can gate access to. FK target for both
-- role_page_access and user_page_access (0004), instead of a bare TEXT
-- page_key with no table backing it.
CREATE TABLE pages (
  page_key     TEXT PRIMARY KEY,
  label        TEXT NOT NULL,
  module_group TEXT NOT NULL
);

-- Registry of which tables participate in the soft-delete-via-approval
-- workflow (see deletion_requests, 0011) and how to reach them — lets the
-- deletion-approval trigger apply itself generically instead of a giant
-- CASE over table names hardcoded in application code.
CREATE TABLE deletable_entities (
  entity_type TEXT PRIMARY KEY,
  table_name  TEXT NOT NULL,
  id_column   TEXT NOT NULL DEFAULT 'id'
);

-- Backing store for fn_next_code() (0011) — one atomically-incremented
-- counter per human-readable code prefix (e.g. 'PO-' -> 42), replacing the
-- original SQLite approach of `SELECT MAX(id) ... +1`, which races under
-- concurrent writers.
CREATE TABLE code_sequences (
  prefix         TEXT PRIMARY KEY,
  current_value  BIGINT NOT NULL DEFAULT 0
);
