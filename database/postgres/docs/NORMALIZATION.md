# Normalization

Every table in this schema is in **3NF** (and, since none of the composite
keys here have partial multi-attribute functional dependencies beyond the
handful of intentionally-denormalized derived columns called out below, also
**BCNF**). This note works through what that took, using the original
`server/src/db/schema.ts` (SQLite) as the "before" — it's a real, working
schema, and every fix below addresses a specific anomaly it had, not a
hypothetical one.

## 1NF — atomic columns, no repeating groups

Satisfied throughout: every column holds a single scalar value, and every
repeating group (an order's line items, a batch's QC results) is its own
child table with a foreign key back to the header (`purchase_order_items`,
`sales_order_items`, `material_request_items`, `goods_received_items`,
`quality_control`), never a delimited string or JSON blob in a single column.

Two columns were **not** atomic in the original and are fixed here:

- `employees.tenure` was a free-text string ("3 yrs 4 mo"). Replaced by
  `employees.hire_date DATE` — a single atomic fact — with tenure *derived*
  (`age(now(), hire_date)`) in `v_employee_directory` (0013) rather than
  stored as a pre-formatted, staleness-prone string.
- `assets.last_service` / `next_due` were free text ("Recently", "Upcoming").
  Replaced with real `DATE` columns.

## 2NF — every non-key attribute depends on the *whole* key

Only relevant where a table has a composite key. `role_page_access` and
`user_page_access` (0003) have composite PKs `(role_id, page_key)` /
`(user_id, page_key)` and carry no other attribute besides `granted_at` on
the latter, which depends on the whole pair (when *this user* was granted
*this page*) — no partial-key dependency exists to violate.

## 3NF — no transitive dependencies on non-key attributes

This is where most of the original schema's redundancy lived — columns
whose value was determined by *another non-key column*, not by the row's own
primary key:

- **`payroll_runs.staff_name`** was fully determined by `staff_id`
  (`employees.name`), not by the payroll run itself. Renaming an employee
  meant every historic payslip either had to be updated too or silently
  disagreed with the master record. **Removed** — read `employees.full_name`
  via the `employee_id` join instead.
- **`app_roles.members`** (originally `roles.members`) was
  `COUNT(users WHERE role = this role)` — a fact about the *users* table,
  stored redundantly on `roles`. Any role reassignment had to remember to
  bump this counter too, or it drifted. **Removed**, replaced by the live
  `v_role_member_counts` view (0013).
- **Every `_by` / actor column was free text**: `requested_by`, `received_by`,
  `operator`, `packaged_by`, `inspector`, `driver`, `rep`, `actor`,
  `moved_by`, `owner`, `updated_by`, `paid_to`/`received_from`. A person's
  name, stored redundantly on every row they ever touched, with no way to
  correct a typo or a legal name change in one place, and no way to join
  back to that person's department/role/status. **Replaced throughout** with
  `*_employee_id UUID REFERENCES employees(id)` (or `users(id)` for
  `activity_log.actor_user_id`, since that log is about system-account
  actions specifically). This is the single largest structural change from
  the original design — see `docs/RELATIONSHIPS.md` for the full list of
  these FKs.
- **Open-ended categorical strings repeated across many rows** — a
  department name on `employees`, `material_requests` *and*
  `warehouse_requisitions`; a location on `suppliers`, `customers` *and*
  (implicitly) delivery routes; an item category, a UOM, a job title, a
  production line, a shift. Each was free text in the original, meaning a
  rename or a typo fix had to happen in every row that used it, and nothing
  stopped `"Line A"` and `"line a"` from coexisting. **Extracted into lookup
  tables** (`departments`, `locations`, `warehouse_locations`,
  `item_categories`, `uoms`, `job_titles`, `production_lines`, `shifts`,
  `water_sources`, `treatment_stages`, `chart_of_accounts`, `pages`) and
  referenced by FK — see `docs/NORMALIZATION.md#lookup-vs-enum` below for how
  that choice was made per column.
- **`warehouse_requisitions.item`** was the item's free-text *name*, not a
  foreign key to `items` — so a requisition for "PET preforms" had no actual
  relationship to the `items` row of the same name, and inventory tooling
  couldn't join the two. **Fixed** to `item_id UUID REFERENCES items(id)`.

## `lookup vs. enum`

Two different tools were used for "one column, closed set of values," chosen
per column by whether the set is genuinely fixed by the business process or
just currently small:

- **Native `ENUM` type** (0001) for workflow statuses and other sets that
  are part of the application's *logic*, not its *data* — `po_status_enum`,
  `sales_status_enum`, `qc_verdict_enum`, etc. Adding a new status is a code
  change anyway (new branches in the service layer), so a schema migration
  to add the enum label is proportionate.
- **Lookup table** (0002) for sets that are *data* an admin should be able
  to grow without a deploy — a new department, a new delivery location, a
  new item category. These also gained the referential-integrity benefit:
  `employees.department_id` can never silently reference a department that
  doesn't exist, which `employees.department TEXT` could.

## Money and derived values: intentional, documented denormalization

Two values are stored redundantly on purpose, each with the mechanism that
keeps it consistent named right next to it:

- **`sales_orders.total_amount`** duplicates `SUM(sales_order_items.line_total)`.
  Every order-list and dashboard KPI query reads this column instead of
  aggregating on every request; `trg_sales_order_items_recalc_total` (0012)
  recomputes it on every line insert/update/delete, so it can never actually
  drift from its source of truth. `purchase_orders` deliberately does **not**
  get the same treatment — POs are edited far less often as read, so
  `v_purchase_order_totals` (0013) computes it live instead, with no cache
  to invalidate.
- **`sales_order_items.line_total`** is a Postgres `GENERATED ALWAYS AS
  (quantity * unit_price) STORED` column — enforced by the database engine
  itself, not application code, so it is definitionally never inconsistent
  with its inputs.

Everything else — `items` on-hand balance, AR/AP aging, production yield,
delivery turnaround — is computed live in a view (0013) rather than stored,
because nothing reads those often enough on their own to justify a cache.

## Polymorphic references: the one structural compromise

`quality_control.ref_id`, `inventory_transactions.source_id`,
`ledger_entries`/`payments`/`receipts`.`reference_id`,
`payments`/`receipts`.`counterparty_id`, and `deletion_requests.entity_id`
each point at *one of several* other tables depending on a sibling `_type`
column. This is not fully expressible as 3NF in the strict relational sense
(a proper decomposition would split each of these into one table per target
type — `quality_control_for_goods_received`,
`quality_control_for_production_batch`, and so on), which was rejected
because it would turn 5 tables into ~18 near-identical ones for a query
pattern ("every QC test", "every ledger line") that every caller needs
type-agnostically. The integrity Postgres can't express declaratively here
is instead enforced procedurally, at the same INSERT/UPDATE boundary a real
FK would use — see `0012_triggers.sql` and the "Enforcement" column in
`docs/RELATIONSHIPS.md`. This is a standard, named trade-off (the
"polymorphic association" pattern), not an oversight.
