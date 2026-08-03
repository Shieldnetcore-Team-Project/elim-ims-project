# Elim Water Factory ERP — PostgreSQL database

A complete, normalized PostgreSQL schema for the Elim Water ERP domain
(procurement, receiving, QC, inventory, production, packaging, sales,
fleet/delivery, finance, payroll, HR/access control, audit, reports). This is
a from-scratch relational design for Postgres — it draws on the business
domain of the app's current SQLite store (`server/src/db/schema.ts`) but is
not a 1:1 port; see `docs/NORMALIZATION.md` for what changed and why.

## Layout

```
docs/
  ERD.md            Entity-relationship diagram (Mermaid) — every table & FK
  RELATIONSHIPS.md   Business-process flow diagram + full FK/trigger inventory
  NORMALIZATION.md   1NF/2NF/3NF walkthrough, anomalies fixed, trade-offs made
migrations/          Numbered, forward-only SQL — run in order, once each
  0001_extensions_and_enums.sql
  0002_lookup_tables.sql
  0003_people_and_access.sql
  0004_masters.sql
  0005_procurement_receiving_qc.sql
  0006_inventory_warehouse.sql
  0007_production_packaging.sql
  0008_sales_fleet.sql
  0009_finance_payroll.sql
  0010_reports_audit_deletion.sql
  0011_functions.sql          stored procedures (see below)
  0012_triggers.sql           trigger functions + wiring (see below)
  0013_views.sql               read-side views (see below)
  0014_indexes.sql             indexes not already implied by PK/UNIQUE
  0015_reference_data.sql      structural data every environment needs (pages, chart of accounts, ...)
seed/
  seed.sql            representative demo/transactional data (run once, after migrations)
prisma/
  schema.prisma       Prisma mirror of the whole schema, incl. views
```

## Running it

```bash
createdb elim_water
for f in database/postgres/migrations/*.sql; do
  psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f "$f"
done
psql "$DATABASE_URL" -f database/postgres/seed/seed.sql   # optional, demo data
```

Requires PostgreSQL 14+ (uses `GENERATED ALWAYS AS ... STORED` columns,
native `gen_random_uuid()` via `pgcrypto`, and `citext`).

### Prisma

```bash
cd database/postgres/prisma
npx prisma generate
```

`schema.prisma` describes the database; it isn't how the database gets
created — the SQL migrations are the source of truth (they're also what
carries the CHECK constraints, triggers and functions Prisma can't express).
Point `DATABASE_URL` at a database the migrations have already run against.

## What's here beyond tables

- **Stored procedures** (0011): `fn_next_code` (atomic human-readable code
  generation), `fn_item_balance`, `fn_post_inventory_transaction`,
  `fn_approve_purchase_order`, `fn_receive_goods`,
  `fn_issue_material_request`, `fn_complete_production_batch`,
  `fn_create_sales_order`, `fn_dispatch_delivery`, `fn_mark_delivered`,
  `fn_customer_outstanding_balance`, `fn_supplier_outstanding_balance`. Each
  is the write-API for one workflow step — multi-table effects (an inventory
  movement plus a status transition plus a total recalculation) happen
  atomically inside the function instead of being re-implemented by every
  caller. `seed/seed.sql` drives these directly rather than hand-inserting
  the rows they produce, the same way the application would.
- **Triggers** (0012): `updated_at` bookkeeping; polymorphic-reference
  validation (the FK Postgres can't declare directly — see
  `docs/RELATIONSHIPS.md`); append-only enforcement on
  `inventory_transactions`, `ledger_entries` and `activity_log`; the
  non-negative-stock guard; `sales_orders.total_amount` cache maintenance;
  and the deletion-approval workflow (a `deletion_requests` row flipping to
  `APPROVED` stamps `deleted_at` on the target row — nothing in this app is
  ever hard-deleted).
- **Views** (0013): `v_inventory_status` / `v_low_stock_alerts` (derived
  on-hand balance + status), `v_purchase_order_totals`,
  `v_sales_order_summary`, `v_customer_outstanding_balance` /
  `v_supplier_payables` (AR/AP aging), `v_production_yield`,
  `v_delivery_performance`, `v_employee_directory` (derived tenure),
  `v_role_member_counts`, `v_effective_page_access` (role baseline ∪
  per-user grants).
- **Indexes** (0014): every FK column that's queried directly, plus partial
  indexes for the "pending queue" views each workflow module opens to.

## Design constraints this schema satisfies

- **No duplicate tables** — one table per entity; `sales_orders` covers both
  invoice and POS channels (see 0008) rather than two parallel tables, on
  the same reasoning the original schema used.
- **No missing relationships** — every FK in `docs/RELATIONSHIPS.md` is a
  real `REFERENCES` constraint except the five polymorphic pointers, which
  are trigger-enforced instead (Postgres has no conditional FK) — see
  `docs/NORMALIZATION.md#polymorphic-references-the-one-structural-compromise`.
- **Normalized** — 3NF/BCNF throughout; see `docs/NORMALIZATION.md` for the
  specific anomalies this fixed relative to the original SQLite schema
  (redundant actor names, a redundant role-member counter, a redundant
  payroll staff-name column, free-text categorical columns with no
  referential integrity).
