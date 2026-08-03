-- =============================================================================
-- 0009_finance_payroll.sql
-- Double-entry ledger, payments out, receipts in, payroll runs.
-- =============================================================================

-- Append-only double-entry ledger. reference_type/reference_id is
-- polymorphic (points at a purchase_orders / sales_orders / payroll_runs /
-- goods_received row, or nothing for a plain EXPENSE), validated by
-- trg_ledger_entries_validate_ref (0012).
CREATE TABLE ledger_entries (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  entry_date     TIMESTAMPTZ NOT NULL DEFAULT now(),
  account_id     UUID NOT NULL REFERENCES chart_of_accounts(id),
  debit          NUMERIC(16,2) NOT NULL DEFAULT 0 CHECK (debit >= 0),
  credit         NUMERIC(16,2) NOT NULL DEFAULT 0 CHECK (credit >= 0),
  reference_type finance_ref_type_enum,
  reference_id   UUID,
  description    TEXT,
  CONSTRAINT ledger_entries_one_side_only CHECK (NOT (debit > 0 AND credit > 0)),
  CONSTRAINT ledger_entries_nonzero CHECK (debit > 0 OR credit > 0)
);

-- payments (money out) and receipts (money in) share the same counterparty
-- shape: who was paid / who paid us is either a known supplier, customer or
-- employee (counterparty_id FK'd, validated by type) or an external party
-- with no master record of their own (e.g. "PHCN / power") captured in
-- counterparty_label instead of as a loose free-text name column.
CREATE TABLE payments (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code               TEXT NOT NULL UNIQUE,             -- e.g. 'PAY-0001'
  counterparty_type  counterparty_type_enum NOT NULL,
  counterparty_id    UUID,
  counterparty_label TEXT,
  amount             NUMERIC(16,2) NOT NULL CHECK (amount > 0),
  method             payment_method_enum,
  reference_type     finance_ref_type_enum,
  reference_id       UUID,
  status             payment_status_enum NOT NULL DEFAULT 'CLEARED',
  paid_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT payments_counterparty_identified CHECK (counterparty_id IS NOT NULL OR counterparty_label IS NOT NULL)
);

CREATE TABLE receipts (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code               TEXT NOT NULL UNIQUE,             -- e.g. 'RCT-0001'
  counterparty_type  counterparty_type_enum NOT NULL,
  counterparty_id    UUID,
  counterparty_label TEXT,
  amount             NUMERIC(16,2) NOT NULL CHECK (amount > 0),
  method             payment_method_enum,
  reference_type     finance_ref_type_enum,
  reference_id       UUID,
  status             payment_status_enum NOT NULL DEFAULT 'CLEARED',
  received_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT receipts_counterparty_identified CHECK (counterparty_id IS NOT NULL OR counterparty_label IS NOT NULL)
);

-- staff_name is deliberately absent: it was functionally dependent on
-- employee_id, not on this table's own key, so storing it here was a 3NF
-- violation (rename an employee, and every historic payslip disagrees with
-- the master record). Read it via the employees join instead.
CREATE TABLE payroll_runs (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code         TEXT NOT NULL UNIQUE,                   -- e.g. 'PYR-2026-0001'
  employee_id  UUID NOT NULL REFERENCES employees(id),
  period_month DATE NOT NULL,                           -- first-of-month, e.g. '2026-07-01'
  gross        NUMERIC(14,2) NOT NULL CHECK (gross >= 0),
  net          NUMERIC(14,2) NOT NULL CHECK (net >= 0),
  status       payroll_status_enum NOT NULL DEFAULT 'SCHEDULED',
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT payroll_runs_net_not_over_gross CHECK (net <= gross),
  UNIQUE (employee_id, period_month)
);
